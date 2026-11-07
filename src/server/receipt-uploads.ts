// Agent receipt uploads: the current app's staged S3 uploads
// (src/lib/expense-uploads.ts). An upload target is an app URL with a
// single-use secret, not a presigned storage URL, so the bucket stays off the
// public internet. The agent PUTs the bytes there once; the server streams
// them into the bucket at their final key. Only update_expense with attachUploadIds
// registers the image to the group and attaches it, so a target alone saves nothing.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { receipts, receiptUploads } from '../../db/schema/app'
import { LIMITS } from '../shared/limits'
import type { ReceiptContentType } from '../shared/vocabulary'
import type { Bucket } from './bucket'
import type { Db } from './db'
import { randomId, randomToken, sha256Hex } from './ids'
import type { Principal, StoredDocument } from './ledger'
import { spaceFor } from './receipt-quota'
import { imageInfo, NEW_URL_PREFIX, type ImageInfo } from './receipts'
import { jsonError } from './security'

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

/** A finalization failure, with the current app's tRPC code and message. */
export class UploadError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
  }
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
  const origin = new URL(data.baseUrl).origin
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
        key: `receipts/${randomId()}.${file.contentType === 'image/png' ? 'png' : 'jpg'}`,
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
      url: `${origin}/api/receipt-uploads/${token}`,
      headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.bytes) },
      expiresAt: expiresAt.toISOString(),
    })),
    uploadError: null,
  }
}

/**
 * PUT /api/receipt-uploads/<token>. The secret in the URL is the only
 * credential, as with a presigned URL. The request claims the target first,
 * so a second PUT with the same URL fails. The body streams into the bucket,
 * and the stored size must be the declared size. If the write fails, the target is free again until it expires.
 */
export async function putUpload(data: { db: Db; bucket: Bucket; request: Request; token: string }): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(data.token)) return jsonError({ status: 403, message: 'This upload URL is not valid, was used, or has expired' })
  const claimed = await data.db
    .update(receiptUploads)
    .set({ state: 'writing' })
    .where(and(eq(receiptUploads.tokenHash, sha256Hex(data.token)), eq(receiptUploads.state, 'pending'), sql`${receiptUploads.expiresAt} > now()`))
    .returning({ id: receiptUploads.id, key: receiptUploads.key, contentType: receiptUploads.contentType, bytes: receiptUploads.bytes })
  const target = claimed[0]
  if (!target) return jsonError({ status: 403, message: 'This upload URL is not valid, was used, or has expired' })
  const release = () => data.db.update(receiptUploads).set({ state: 'pending' }).where(eq(receiptUploads.id, target.id))
  // The current app signed these two headers into the URL, so storage refused other values.
  const type = data.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const length = data.request.headers.get('content-length')
  if (type !== target.contentType || length !== String(target.bytes) || !data.request.body) {
    await release()
    return jsonError({ status: 400, message: `Send exactly the headers of the upload target: Content-Type ${target.contentType} and Content-Length ${target.bytes}` })
  }
  let stored: { size: number; etag: string } | null = null
  try {
    stored = await data.bucket.put(target.key, data.request.body, { contentType: target.contentType })
  } catch (error) {
    console.error('Receipt upload to storage failed', error)
  }
  if (stored?.size !== target.bytes) {
    if (stored) await data.bucket.delete(target.key).catch(() => {})
    await release()
    return jsonError({ status: 400, message: 'Upload is incomplete' })
  }
  await data.db.update(receiptUploads).set({ state: 'stored', uploadedAt: sql`now()` }).where(eq(receiptUploads.id, target.id))
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', ETag: stored.etag } })
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
 * concurrent attaches cannot pass on the same free space. Returns the new documents.
 */
export async function attachUploads(
  tx: Db,
  data: { principal: Principal; groupId: string; expenseId: string; uploadIds: readonly string[]; bucket: Bucket },
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
  const unfinished = new UploadError('BAD_REQUEST', 'Receipt upload could not be finalized. Upload the file first, then retry with its uploadId.')
  // Check every ID before any storage read: ownership first, as the current app did.
  for (const id of ids) {
    const row = byId.get(id)
    if (row && (row.userId !== data.principal.userId || row.groupId !== data.groupId || row.expenseId !== data.expenseId))
      throw new UploadError('FORBIDDEN', 'This upload does not belong to this user and expense')
  }
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || row.state !== 'stored') throw unfinished
    if (!row.fresh) throw new UploadError('BAD_REQUEST', 'Upload is too large or expired')
  }
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  const full = await spaceFor(tx, { userId: data.principal.userId, bytes, lock: true, outstanding: false })
  if (full) throw new UploadError('PRECONDITION_FAILED', full)
  const documents: StoredDocument[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) throw unfinished
    const info = await storedImage(data.bucket, row)
    // The key's extension and the stored Content-Type come from the declared type, so the content must match it.
    if (!info || `image/${info.format}` !== row.contentType) throw new UploadError('BAD_REQUEST', 'Receipts must be valid JPEG or PNG images')
    const url = `${NEW_URL_PREFIX}${row.key}`
    await tx.insert(receipts).values({ id: randomId(), groupId: data.groupId, url, createdBy: data.principal.userId, bytes: row.bytes })
    documents.push({ id: randomId(), url, width: info.width, height: info.height })
  }
  await tx.delete(receiptUploads).where(inArray(receiptUploads.id, ids))
  return documents
}

/**
 * Removes targets that can no longer be attached, and their objects. Runs from
 * the hourly job. The current app left unattached pending-receipts objects in the bucket.
 */
export async function removeStaleUploads(data: { db: Db; bucket: Bucket }) {
  const removed = await data.db
    .delete(receiptUploads)
    .where(sql`${receiptUploads.createdAt} < now() - make_interval(hours => ${LIMITS.uploadAttachHours + 1})`)
    .returning({ key: receiptUploads.key, state: receiptUploads.state })
  await data.bucket.delete(removed.filter((r) => r.state !== 'pending').map((r) => r.key))
  return removed.length
}

