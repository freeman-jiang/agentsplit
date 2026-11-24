// The receipt routes over plain HTTP: GET and POST /api/receipts, an agent's
// PUT to its upload target, and a group's receipts as one ZIP file. The rules
// are in receipts.ts, receipt-uploads.ts and storage.ts; this module reads the
// request and writes the response. Rules from the current app:
// src/app/api/receipts/route.ts.
import { NotFound } from '../shared/api'
import { LIMITS, mebibytes } from '../shared/limits'
import { todayUtc } from '../shared/dates'
import { RECEIPT_CONTENT_TYPES } from '../shared/vocabulary'
import type { Principal } from './core/access'
import type { Reader } from './auth/authenticate'
import { storageUnavailable, type Bucket, type StoredObject } from './bucket'
import { withBufferedBody } from './core/body'
import type { Db } from './core/db'
import { contentDisposition } from './headers'
import { domainErrorResponse, jsonError } from './core/errors'
import { storeUpload } from './receipt-uploads'
import { readableReceipt, storeReceipt } from './receipts'
import { receiptArchive } from './storage'
import { zipStream, type ZipEntry } from './zip'

/** The multipart envelope may add this much to the image. */
const ENVELOPE_BYTES = 64 * 1024

/**
 * How long a receipt's presigned URL works. The reader follows the redirect at
 * once, so a few seconds would do; 5 minutes also covers a slow network and
 * clock skew between the server and storage. A URL that leaks (from a log, a
 * copied address bar or browser history) reads only this one image, and only
 * until then. A removed member or a deleted receipt also loses access at most
 * this late, for a URL already handed out.
 */
const PRESIGNED_SECONDS = 5 * 60

/** How long a browser may take to send a multipart receipt upload (up to 5 MiB). */
const UPLOAD_BODY_MS = 30_000

/**
 * GET /api/receipts?groupId=&url=. `readerOf` authenticates the caller on a
 * short database connection, then checks access and releases the connection
 * BEFORE touching storage, so slow storage never ties up the database pool.
 */
export async function downloadReceipt(data: {
  withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  bucket: Bucket
  url: URL
  readerOf: (db: Db) => Promise<Reader>
  downloads: 'stream' | 'redirect'
}): Promise<Response> {
  const groupId = data.url.searchParams.get('groupId')
  const url = data.url.searchParams.get('url')
  if (!groupId || !url) return jsonError({ status: 400, message: 'Receipt reference is required' })
  const checked = await data.withDb(async (db): Promise<Response | Awaited<ReturnType<typeof readableReceipt>>> => {
    const reader = await data.readerOf(db)
    if ('response' in reader) return reader.response
    try {
      return await readableReceipt(db, { principal: reader.principal, groupId, url })
    } catch (error) {
      return domainErrorResponse(error)
    }
  })
  if (checked instanceof Response) return checked
  const receipt = checked
  // The current app's 410 names the UTC day of the deletion.
  if ('deleted' in receipt) return jsonError({ status: 410, message: `Receipt deleted by ${receipt.deleted.by} on ${receipt.deleted.at.slice(0, 10)}` })
  // In redirect mode only the object's metadata is read here, never its bytes.
  let object: StoredObject | null
  try {
    object = await data.bucket.get(receipt.key)
  } catch (error) {
    return domainErrorResponse(storageUnavailable({ what: 'Reading a receipt', error }))
  }
  if (!object) return domainErrorResponse(new NotFound({ entity: 'receipt', id: url }))
  // Only a receipt type is ever served, whatever the stored object claims.
  const contentType = RECEIPT_CONTENT_TYPES.find((type) => type === object.contentType) ?? 'image/jpeg'
  if (data.downloads === 'redirect') {
    const location = data.bucket.presignGet(receipt.key, { expiresIn: PRESIGNED_SECONDS, contentType, contentDisposition: 'inline' })
    return new Response(null, { status: 307, headers: { Location: location, 'Cache-Control': 'private, no-store' } })
  }
  return new Response(object.stream(), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  })
}

/**
 * POST /api/receipts, multipart with `groupId` and `file`, from a browser's session.
 * app.ts has checked the origin. The session check releases its database connection
 * before the multipart body is buffered (under the shared body timeout and memory
 * budget) and before the image is uploaded to storage.
 */
export async function uploadReceipt(data: {
  withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  bucket: Bucket
  request: Request
  sessionOf: (db: Db) => Promise<Principal | null>
}): Promise<Response> {
  const principal = await data.withDb(data.sessionOf)
  if (!principal) return jsonError({ status: 401, message: 'Authentication required' })
  const maxBytes = LIMITS.receiptBytes + ENVELOPE_BYTES
  const tooLargeMessage = `Receipt must be at most ${mebibytes(LIMITS.receiptBytes)}`
  const length = Number(data.request.headers.get('content-length'))
  if (!length || length > maxBytes) return jsonError({ status: 413, message: tooLargeMessage, headers: { Connection: 'close' } })
  return withBufferedBody(data.request, { maxBytes, timeoutMs: UPLOAD_BODY_MS, tooLargeMessage }, async (buffered) => {
    let form: FormData
    try {
      form = await buffered.formData()
    } catch {
      return jsonError({ status: 400, message: 'Group and image are required' })
    }
    const groupId = form.get('groupId')
    const file = form.get('file')
    if (typeof groupId !== 'string' || typeof file === 'string' || file === null) return jsonError({ status: 400, message: 'Group and image are required' })
    try {
      return Response.json(await storeReceipt(data.withDb, { bucket: data.bucket, principal, groupId, file }), { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      return domainErrorResponse(error)
    }
  })
}

/** PUT /api/receipt-uploads/<token>: an agent's upload target from create_expense or update_expense. */
export async function putUpload(data: {
  withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  bucket: Bucket
  request: Request
  token: string
}): Promise<Response> {
  try {
    const result = await storeUpload(data)
    if (result instanceof Response) return result
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', ETag: result.etag } })
  } catch (error) {
    return domainErrorResponse(error)
  }
}

/**
 * Every receipt of a group as one ZIP file, at /<group>/expenses/export/receipts,
 * for members only, with the same credentials as the exports. `withDb` runs
 * the database work; the file streams from storage after it is done, so the
 * connection is released first. A receipt whose object is missing, or that
 * storage fails to read, is listed in MISSING.txt at the end of the file
 * instead: a failure mid-stream would end the download as a file that no
 * unzip tool can open.
 */
export async function downloadReceiptArchive(data: {
  withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  bucket: Bucket
  group: string
  /** The caller (httpReader), read on the archive's connection. */
  readerOf: (db: Db) => Promise<Reader>
}): Promise<Response> {
  const prepared = await data.withDb(async (db): Promise<Response | Awaited<ReturnType<typeof receiptArchive>>> => {
    const reader = await data.readerOf(db)
    if ('response' in reader) return reader.response
    try {
      return await receiptArchive(db, { principal: reader.principal, groupId: data.group })
    } catch (error) {
      return domainErrorResponse(error)
    }
  })
  if (prepared instanceof Response) return prepared
  const archive = prepared
  const { bucket } = data
  async function* files(): AsyncGenerator<ZipEntry | null> {
    const missing: string[] = []
    const unreadable: string[] = []
    for (const entry of archive.entries) {
      let bytes: Uint8Array | null
      try {
        const object = await bucket.get(entry.key)
        bytes = object ? await object.bytes() : null
      } catch (error) {
        console.error('Reading a receipt for the ZIP download failed', { key: entry.key }, error)
        unreadable.push(entry.name)
        yield null
        continue
      }
      if (!bytes) {
        missing.push(entry.name)
        yield null
        continue
      }
      yield { name: entry.name, time: entry.time, bytes }
    }
    const sections = [
      missing.length ? `These receipts were not found in storage:\n${missing.join('\n')}\n` : '',
      unreadable.length ? `These receipts could not be read from storage. Download the file again later:\n${unreadable.join('\n')}\n` : '',
    ].filter(Boolean)
    if (sections.length) yield { name: 'MISSING.txt', time: new Date(), bytes: new TextEncoder().encode(sections.join('\n')) }
  }
  return new Response(zipStream(files()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${archive.groupName} receipts ${todayUtc()}.zip`),
      'Cache-Control': 'private, no-store',
    },
  })
}
