// Agent receipt uploads: the current app's staged S3 uploads
// (src/lib/expense-uploads.ts). An upload target is an app URL with a
// single-use secret, not a presigned storage URL, so the bucket stays off the
// public internet. The agent PUTs the bytes there once; the server streams
// them into the bucket at their final key. Only update_expense with attachUploadIds
// registers the image to the group and attaches it, so a target alone saves nothing.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { receipts, receiptUploads } from '../../db/schema/app'
import { Forbidden, Invalid } from '../shared/api'
import { randomId, SECRET_TOKEN } from '../shared/ids'
import { LIMITS } from '../shared/limits'
import { absoluteUrl, receiptUploadPath } from '../shared/paths'
import { receiptTypeOf, type ReceiptContentType } from '../shared/vocabulary'
import { removeOrphans, storageUnavailable, type Bucket } from './bucket'
import { readBody } from './core/body'
import type { Db } from './core/db'
import { randomToken, sha256Hex } from './core/ids'
import type { Principal } from './core/access'
import type { StoredDocument } from './expense-read'
import { spaceFor } from './receipt-quota'
import { imageInfo, newReceiptKey, receiptUrl, type ImageInfo } from './receipts'

/** The first read for the image header. Phone JPEGs carry their frame header well inside it. */
const HEADER_BYTES = 256 * 1024

export type UploadRequest = { readonly filename: string; readonly contentType: ReceiptContentType; readonly bytes: number }
export type UploadTarget = {
  uploadId: string
  filename: string
  method: 'PUT'
  url: string
  headers: { 'Content-Type': string; 'Content-Length': string }
  expiresAt: string
}

/**
 * Upload targets for an expense that the caller just wrote, in the write's
 * transaction. The rows bind each target to the caller, the group and the
 * expense. When the files would not fit the caller's receipt storage, counting
 * the uploads that the caller can still attach, the write keeps its result and
 * reports uploadError, as in the current app (P-TOOL-CREATEEXP-31, 32).
 */
export async function prepareUploads(
  tx: Db,
  data: { principal: Principal; groupId: string; expenseId: string; requests: readonly UploadRequest[] | undefined; baseUrl: string },
): Promise<{ uploads: UploadTarget[]; uploadError: string | null }> {
  if (!data.requests?.length) return { uploads: [], uploadError: null }
  const bytes = data.requests.reduce((sum, file) => sum + file.bytes, 0)
  const full = await spaceFor(tx, { userId: data.principal.userId, bytes, lock: false, outstanding: true })
  if (full) return { uploads: [], uploadError: full }
  const expiresAt = new Date(Date.now() + LIMITS.uploadTargetSeconds * 1000)
  const rows = data.requests.map((file) => {
    const token = randomToken()
    const id = randomId()
    return {
      file,
      token,
      row: {
        id,
        tokenHash: sha256Hex(token),
        userId: data.principal.userId,
        groupId: data.groupId,
        expenseId: data.expenseId,
        key: newReceiptKey(file.contentType),
        contentType: file.contentType,
        bytes: file.bytes,
        expiresAt,
      },
    }
  })
  await tx.insert(receiptUploads).values(rows.map((r) => r.row))
  return {
    uploads: rows.map(({ file, token, row }) => ({
      uploadId: row.id,
      filename: file.filename,
      method: 'PUT' as const,
      url: absoluteUrl({ baseUrl: data.baseUrl, path: receiptUploadPath(token) }),
      headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.bytes) },
      expiresAt: expiresAt.toISOString(),
    })),
    uploadError: null,
  }
}

/** The answer to a target that does not exist, was used, or has expired. */
const NOT_VALID = 'This upload URL is not valid, was used, or has expired'

/** How long an agent may take to send a PUT receipt body (up to 5 MiB). */
const UPLOAD_BODY_MS = 30_000
/** Maximum stale upload rows cleaned per hourly pass so one run stays bounded. */
const STALE_BATCH = 200

/**
 * Stores the body of an agent's PUT to its upload target. The secret in the
 * URL is the only credential, as with a presigned URL. The request claims the
 * target first, then releases the database connection before reading the body
 * (bounded in time, size, and shared memory budget) and uploading to storage.
 * If reading or writing fails, the target is released back to pending until it
 * expires. Returns the stored ETag, or a refusal Response (408/413/400/503).
 */
export async function storeUpload(data: {
  withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A>
  bucket: Bucket
  token: string
  request: Request
}): Promise<{ etag: string } | Response> {
  if (!SECRET_TOKEN.test(data.token)) throw new Forbidden({ message: NOT_VALID })
  const contentType = data.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const contentLength = data.request.headers.get('content-length')
  const target = await data.withDb(async (db) => {
    const claimed = await db
      .update(receiptUploads)
      .set({ state: 'writing' })
      .where(and(eq(receiptUploads.tokenHash, sha256Hex(data.token)), eq(receiptUploads.state, 'pending'), sql`${receiptUploads.expiresAt} > now()`))
      .returning({ id: receiptUploads.id, key: receiptUploads.key, contentType: receiptUploads.contentType, bytes: receiptUploads.bytes })
    const row = claimed[0]
    if (!row) throw new Forbidden({ message: NOT_VALID })
    // The current app signed these two headers into the URL, so storage refused other values.
    if (contentType !== row.contentType || contentLength !== String(row.bytes) || !data.request.body) {
      await db.update(receiptUploads).set({ state: 'pending' }).where(eq(receiptUploads.id, row.id))
      throw new Invalid({ message: `Send exactly the headers of the upload target: Content-Type ${row.contentType} and Content-Length ${row.bytes}` })
    }
    return row
  })

  const releaseTarget = () =>
    data
      .withDb((db) => db.update(receiptUploads).set({ state: 'pending' }).where(eq(receiptUploads.id, target.id)))
      .catch((error: unknown) => console.error('Releasing failed upload target failed', { id: target.id }, error))

  const read = await readBody(data.request, { maxBytes: target.bytes, timeoutMs: UPLOAD_BODY_MS })
  if (read instanceof Response) {
    await releaseTarget()
    return read
  }
  let stored: { size: number; etag: string }
  try {
    if (read.bytes.byteLength !== target.bytes) {
      await releaseTarget()
      throw new Invalid({ message: 'Upload is incomplete' })
    }
    try {
      stored = await data.bucket.put(target.key, read.bytes, { contentType: target.contentType })
    } catch (error) {
      await releaseTarget()
      throw storageUnavailable({ what: 'Receipt upload to storage', error })
    }
  } finally {
    read.release()
  }
  if (stored.size !== target.bytes) {
    await removeOrphans(data.bucket, [target.key])
    await releaseTarget()
    throw new Invalid({ message: 'Upload is incomplete' })
  }
  await data.withDb((db) => db.update(receiptUploads).set({ state: 'stored', uploadedAt: sql`now()` }).where(eq(receiptUploads.id, target.id)))
  return { etag: stored.etag }
}

/** The image header of a stored object: the first part, or all of it when the frame header comes later. */
async function storedImage(bucket: Bucket, data: { key: string; bytes: number }): Promise<ImageInfo | null> {
  const head = await bucket.get(data.key, { range: { offset: 0, length: HEADER_BYTES } })
  if (!head || head.size !== data.bytes) return null
  const info = imageInfo(await head.bytes())
  if (info || head.size <= HEADER_BYTES) return info
  const whole = await bucket.get(data.key)
  return whole ? imageInfo(await whole.bytes()) : null
}

/**
 * Attaches stored uploads to an expense, in the update's transaction
 * (P-TOOL-UPDATEEXP-11 to 14). Each upload must belong to the caller, the
 * group and the expense, be stored within LIMITS.uploadAttachHours, and be a JPEG or PNG of
 * its declared type. The image is registered to the group, and its upload
 * row is deleted, so an uploadId attaches once. The images must fit the
 * caller's receipt storage, decided under the caller's quota lock, so
 * concurrent attaches cannot pass on the same free space. Storage header reads
 * run in parallel before the quota advisory lock is taken, and optional
 * `imageCache` avoids re-fetching storage if the SERIALIZABLE transaction retries.
 */
export async function attachUploads(
  tx: Db,
  data: {
    principal: Principal
    groupId: string
    expenseId: string
    uploadIds: readonly string[]
    bucket: Bucket
    imageCache?: Map<string, ImageInfo | null>
  },
): Promise<StoredDocument[]> {
  const ids = [...new Set(data.uploadIds)]
  if (!ids.length) return []
  const rows = await tx
    .select({
      id: receiptUploads.id,
      userId: receiptUploads.userId,
      groupId: receiptUploads.groupId,
      expenseId: receiptUploads.expenseId,
      key: receiptUploads.key,
      contentType: receiptUploads.contentType,
      bytes: receiptUploads.bytes,
      state: receiptUploads.state,
      fresh: sql<boolean>`${receiptUploads.uploadedAt} > now() - make_interval(hours => ${LIMITS.uploadAttachHours})`,
    })
    .from(receiptUploads)
    .where(inArray(receiptUploads.id, ids))
    .for('update')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const unfinished = new Invalid({ message: 'Receipt upload could not be finalized. Upload the file first, then retry with its uploadId.' })
  // Check every ID before any storage read: ownership first, as the current app did.
  for (const id of ids) {
    const row = byId.get(id)
    if (row && (row.userId !== data.principal.userId || row.groupId !== data.groupId || row.expenseId !== data.expenseId))
      throw new Forbidden({ message: 'This upload does not belong to this user and expense' })
  }
  const ordered: (typeof rows)[number][] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || row.state !== 'stored') throw unfinished
    if (!row.fresh) throw new Invalid({ message: 'Upload is too large or expired' })
    ordered.push(row)
  }
  const bytes = ordered.reduce((sum, row) => sum + row.bytes, 0)
  // Soft check before reading storage, so a full account fails fast without S3 I/O.
  const softFull = await spaceFor(tx, { userId: data.principal.userId, bytes, lock: false, outstanding: false })
  if (softFull) throw new Invalid({ message: softFull, reason: 'precondition' })
  // Read image headers in parallel before taking the quota advisory lock.
  const infos = await Promise.all(
    ordered.map(async (row) => {
      const cacheKey = `${row.key}:${row.bytes}`
      if (data.imageCache?.has(cacheKey)) return data.imageCache.get(cacheKey) ?? null
      const info = await storedImage(data.bucket, row)
      data.imageCache?.set(cacheKey, info)
      return info
    }),
  )
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]
    const info = infos[i]
    // The key's extension and the stored Content-Type come from the declared type, so the content must match it.
    if (!row || !info || receiptTypeOf(info.format) !== row.contentType) throw new Invalid({ message: 'Receipts must be valid JPEG or PNG images' })
  }
  // Authoritative check under the quota lock right before writing.
  const full = await spaceFor(tx, { userId: data.principal.userId, bytes, lock: true, outstanding: false })
  if (full) throw new Invalid({ message: full, reason: 'precondition' })
  const documents: StoredDocument[] = []
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]
    const info = infos[i]
    if (!row || !info) throw unfinished
    const url = receiptUrl(row.key)
    await tx.insert(receipts).values({ id: randomId(), groupId: data.groupId, url, createdBy: data.principal.userId, bytes: row.bytes })
    documents.push({ id: randomId(), url, width: info.width, height: info.height })
  }
  await tx.delete(receiptUploads).where(inArray(receiptUploads.id, ids))
  return documents
}

/**
 * Removes targets that can no longer be attached, and their objects. Runs from
 * the hourly job. Accepts `withDb` so storage deletes never hold a database
 * connection, or `db` for direct callers in tests.
 */
export async function removeStaleUploads(data: ({ db: Db } | { withDb: <A>(work: (db: Db) => Promise<A>) => Promise<A> }) & { bucket: Bucket }) {
  const run = 'withDb' in data ? data.withDb : <A>(work: (db: Db) => Promise<A>) => work(data.db)
  // An hour past the last attach window: a PUT at the end of the target's time, then the attach time.
  const stale = await run((db) =>
    db
      .select({ id: receiptUploads.id, key: receiptUploads.key, state: receiptUploads.state })
      .from(receiptUploads)
      .where(sql`${receiptUploads.createdAt} < now() - make_interval(secs => ${LIMITS.uploadTargetSeconds + (LIMITS.uploadAttachHours + 1) * 3600})`)
      .limit(STALE_BATCH),
  )
  if (stale.length === 0) return 0
  // The objects go first (outside the database connection): if storage fails, the rows stay and the next run tries again.
  await data.bucket.delete(stale.filter((r) => r.state !== 'pending').map((r) => r.key))
  await run((db) => db.delete(receiptUploads).where(inArray(receiptUploads.id, stale.map((r) => r.id))))
  return stale.length
}

