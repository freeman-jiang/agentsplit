// Receipt images in the receipts bucket (Garage), behind the membership check.
// The ledger stores a receipt by URL (the current app's storage URL, or an r2:
// pointer for new uploads); the object key is the URL's part after the storage prefix.
// Rules from the current app: src/lib/receipt-storage.ts, src/app/api/receipts/route.ts.
import { sql } from 'drizzle-orm'
import { receipts } from '../../db/schema/app'
import { groupAccessDenied, Invalid, NotFound } from '../shared/api'
import { LIMITS, mebibytes } from '../shared/limits'
import { RECEIPT_FORMATS, receiptTypeOf, type ReceiptFormat } from '../shared/vocabulary'
import { randomId } from '../shared/ids'
import type { Bucket } from './bucket'
import type { Db } from './core/db'
import { requireMember, type Principal } from './core/access'
import { spaceFor } from './receipt-quota'
import type { Tombstone } from './expense-read'

/**
 * The pointer of a receipt stored by v2: this prefix and the object key. The
 * name is from the time v2 stored receipts in R2. The current app's objects
 * and v2's share one bucket and one key scheme.
 */
export const NEW_URL_PREFIX = 'r2://agentsplit-receipts/'

export type ImageInfo = { format: ReceiptFormat; width: number; height: number }

/**
 * Reads the format and size from the image header. The content decides the
 * type, never the declared type. Returns null for anything that is not a JPEG
 * or PNG with a real size.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 24 && png.every((b, i) => bytes[i] === b) && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    return sized({ format: 'png', width: view.getUint32(16), height: view.getUint32(20) })
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  // Walk the JPEG segments to the first start-of-frame marker.
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1] ?? 0
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = view.getUint16(at + 2)
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return sized({ format: 'jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) })
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

const sized = (info: ImageInfo) => (info.width >= 1 && info.height >= 1 && info.width * info.height <= LIMITS.receiptPixelsMax ? info : null)

/**
 * The object key of a stored receipt URL: the part after the storage prefix, as the
 * current app's readReceipt takes it. A current-app URL is
 * `https://<host>/<bucket>/<key>`; a v2 upload is `r2://agentsplit-receipts/<key>`.
 * Keys keep their original form, such as `receipts/<id>.png` or the older
 * `document-<time>-<id>.png`. Refuses keys with `..`, `?`, `#`, `%` (P-RECEIPT-26) or a NUL
 * byte, which PostgreSQL text cannot hold.
 */
export function receiptKey(url: string): string | null {
  const key = url.startsWith(NEW_URL_PREFIX) ? url.slice(NEW_URL_PREFIX.length) : /^https?:\/\/[^/]+\/[^/]+\/(.+)$/.exec(url)?.[1]
  if (!key || /\.\.|[?#%\0]/.test(key)) return null
  return key
}

/** The caller's membership of the group. A NUL byte cannot name a group, and PostgreSQL text cannot hold it, so it is denied before the query. */
function member(db: Db, data: { principal: Principal; groupId: string }) {
  if (data.groupId.includes('\0')) throw groupAccessDenied()
  return requireMember(db, data)
}

/**
 * Checks a member's access to a receipt: it must be registered to the group,
 * or attached to one of its expenses. A receipt deleted for good has its tombstone.
 */
async function receiptInGroup(db: Db, data: { groupId: string; url: string }) {
  const result = await db.execute<{ found: boolean; deleted: Tombstone | null }>(sql`
    SELECT EXISTS (SELECT 1 FROM receipts WHERE group_id = ${data.groupId} AND url = ${data.url})
      OR EXISTS (SELECT 1 FROM expense_documents d JOIN expenses e ON e.id = d.expense_id WHERE e.group_id = ${data.groupId} AND d.url = ${data.url}) AS found,
      (SELECT json_build_object('by', u.name, 'at', to_char(dr.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
        FROM receipts r JOIN deleted_receipts dr ON dr.receipt_id = r.id JOIN "user" u ON u.id = dr.deleted_by
        WHERE r.group_id = ${data.groupId} AND r.url = ${data.url}) AS deleted
  `)
  const row = result.rows[0]
  return { found: row?.found === true, deleted: row?.deleted ?? null }
}

/**
 * The object of a receipt a member may read. Membership is checked before
 * storage is read, on every request; receipts that only old revisions or
 * deleted expenses refer to stay readable to members (P-RECEIPT-27). A
 * receipt deleted for good gives its tombstone instead.
 */
export async function readableReceipt(
  db: Db,
  data: { principal: Principal; groupId: string; url: string },
): Promise<{ readonly key: string } | { readonly deleted: Tombstone }> {
  const { groupId } = await member(db, data)
  const key = receiptKey(data.url)
  const receipt = key ? await receiptInGroup(db, { groupId, url: data.url }) : null
  if (!key || !receipt?.found) throw new NotFound({ entity: 'receipt', id: data.url })
  return receipt.deleted ? { deleted: receipt.deleted } : { key }
}

/** The refusal of an image that is not a JPEG or PNG up to the receipt size. */
export const RECEIPT_REFUSED = `Could not upload receipt. Use a JPEG or PNG image up to ${mebibytes(LIMITS.receiptBytes)}.`

/**
 * Stores an uploaded image as a receipt of the group, for a member. The object
 * is stored first and registered to the group after; if the registration
 * fails, the object is removed. The uploader's storage quota is checked before
 * the upload and again, under the uploader's quota lock, when the receipt is
 * registered; a full quota is a precondition Invalid.
 */
export async function storeReceipt(db: Db, data: { bucket: Bucket; principal: Principal; groupId: string; file: Blob }) {
  const { groupId } = await member(db, data)
  const bytes = new Uint8Array(await data.file.arrayBuffer())
  const info = bytes.length && bytes.length <= LIMITS.receiptBytes ? imageInfo(bytes) : null
  if (!info) throw new Invalid({ message: RECEIPT_REFUSED })
  const { userId } = data.principal
  const early = await spaceFor(db, { userId, bytes: bytes.length, lock: false, outstanding: false })
  if (early) throw new Invalid({ message: early, reason: 'precondition' })
  const contentType = receiptTypeOf(info.format)
  const key = `receipts/${randomId()}.${RECEIPT_FORMATS[contentType].extension}`
  const url = `${NEW_URL_PREFIX}${key}`
  const id = randomId()
  let refused: string | null
  try {
    await data.bucket.put(key, bytes, { contentType })
    refused = await db.transaction(async (tx) => {
      const message = await spaceFor(tx, { userId, bytes: bytes.length, lock: true, outstanding: false })
      if (!message) await tx.insert(receipts).values({ id, groupId, url, createdBy: userId, bytes: bytes.length })
      return message
    })
  } catch (error) {
    await data.bucket.delete(key).catch(() => {})
    console.error('Receipt upload failed', error)
    throw new Invalid({ message: RECEIPT_REFUSED })
  }
  if (refused) {
    await data.bucket.delete(key).catch(() => {})
    throw new Invalid({ message: refused, reason: 'precondition' })
  }
  return { id, url, width: info.width, height: info.height }
}
