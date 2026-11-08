// The receipt routes over plain HTTP: GET and POST /api/receipts, an agent's
// PUT to its upload target, and a group's receipts as one ZIP file. The rules
// are in receipts.ts, receipt-uploads.ts and storage.ts; this module reads the
// request and writes the response. Rules from the current app:
// src/app/api/receipts/route.ts.
import { LIMITS, mebibytes } from '../shared/limits'
import { todayUtc } from '../shared/dates'
import { RECEIPT_CONTENT_TYPES } from '../shared/vocabulary'
import type { Principal } from './core/access'
import type { Reader } from './auth/authenticate'
import { storageUnavailable, type Bucket, type StoredObject } from './bucket'
import type { Db } from './core/db'
import { contentDisposition } from './headers'
import { domainErrorResponse, jsonError } from './core/errors'
import { storeUpload } from './receipt-uploads'
import { readableReceipt, storeReceipt } from './receipts'
import { receiptArchive } from './storage'
import { zipStream, type ZipEntry } from './zip'

/** The multipart envelope may add this much to the image. */
export const ENVELOPE_BYTES = 64 * 1024

/**
 * GET /api/receipts?groupId=&url=. `reader` is the caller (httpReader): an
 * agent's API key or OAuth token, as for MCP (P-RECEIPT-22, P-TOOL-GETEXP-06),
 * else the web session. A receipt deleted for good answers 410 Gone, with who
 * deleted it and when.
 */
export async function downloadReceipt(data: { db: Db; bucket: Bucket; url: URL; reader: Reader }): Promise<Response> {
  const groupId = data.url.searchParams.get('groupId')
  const url = data.url.searchParams.get('url')
  if (!groupId || !url) return jsonError({ status: 400, message: 'Receipt reference is required' })
  if ('response' in data.reader) return data.reader.response
  let receipt: Awaited<ReturnType<typeof readableReceipt>>
  try {
    receipt = await readableReceipt(data.db, { principal: data.reader.principal, groupId, url })
  } catch (error) {
    return domainErrorResponse(error)
  }
  if ('deleted' in receipt) return jsonError({ status: 410, message: `Receipt deleted by ${receipt.deleted.by} on ${receipt.deleted.at}` })
  let object: StoredObject | null
  try {
    object = await data.bucket.get(receipt.key)
  } catch (error) {
    return domainErrorResponse(storageUnavailable({ what: 'Reading a receipt', error }))
  }
  if (!object) return jsonError({ status: 404, message: 'Receipt not found' })
  return new Response(object.stream(), {
    headers: {
      // Only a receipt type is ever served, whatever the stored object claims.
      'Content-Type': RECEIPT_CONTENT_TYPES.find((type) => type === object.contentType) ?? 'image/jpeg',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  })
}

/** POST /api/receipts, multipart with `groupId` and `file`, from a browser's session (`principal`). app.ts has checked the origin. */
export async function uploadReceipt(data: { db: Db; bucket: Bucket; request: Request; principal: Principal | null }): Promise<Response> {
  const { principal } = data
  if (!principal) return jsonError({ status: 401, message: 'Authentication required' })
  const length = Number(data.request.headers.get('content-length'))
  if (!length || length > LIMITS.receiptBytes + ENVELOPE_BYTES) return jsonError({ status: 413, message: `Receipt must be at most ${mebibytes(LIMITS.receiptBytes)}` })
  let form: FormData
  try {
    form = await data.request.formData()
  } catch {
    return jsonError({ status: 400, message: 'Group and image are required' })
  }
  const groupId = form.get('groupId')
  const file = form.get('file')
  if (typeof groupId !== 'string' || typeof file === 'string' || file === null) return jsonError({ status: 400, message: 'Group and image are required' })
  try {
    return Response.json(await storeReceipt(data.db, { bucket: data.bucket, principal, groupId, file }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return domainErrorResponse(error)
  }
}

/** PUT /api/receipt-uploads/<token>: an agent's upload target from create_expense or update_expense. */
export async function putUpload(data: { db: Db; bucket: Bucket; request: Request; token: string }): Promise<Response> {
  try {
    const { etag } = await storeUpload({
      db: data.db,
      bucket: data.bucket,
      token: data.token,
      contentType: data.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase(),
      contentLength: data.request.headers.get('content-length'),
      // Taken after the claim: Bun's server stored an incomplete object when the stream was taken before the claim's query.
      body: () => data.request.body,
    })
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', ETag: etag } })
  } catch (error) {
    return domainErrorResponse(error)
  }
}

/**
 * Every receipt of a group as one ZIP file, at /<group>/expenses/export/receipts,
 * for members only, with the same credentials as the exports. `withDb` runs
 * the database work; the file streams from storage after it is done, so the
 * connection is released first. A receipt whose object is missing is listed
 * in MISSING.txt at the end of the file instead.
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
    for (const entry of archive.entries) {
      const object = await bucket.get(entry.key)
      if (!object) {
        missing.push(entry.name)
        yield null
        continue
      }
      yield { name: entry.name, time: entry.time, bytes: await object.bytes() }
    }
    if (missing.length)
      yield { name: 'MISSING.txt', time: new Date(), bytes: new TextEncoder().encode(`These receipts were not found in storage:\n${missing.join('\n')}\n`) }
  }
  return new Response(zipStream(files()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${archive.groupName} receipts ${todayUtc()}.zip`),
      'Cache-Control': 'private, no-store',
    },
  })
}
