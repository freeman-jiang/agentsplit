// Receipt images in the receipts bucket (Garage), behind the membership check.
// The ledger stores a receipt by URL (the current app's storage URL, or an r2:
// pointer for new uploads); the object key is the URL's part after the storage prefix.
// Rules from the current app: src/lib/receipt-storage.ts, src/app/api/receipts/route.ts.
import { sql } from 'drizzle-orm'
import { receipts } from '../../db/schema/app'
import { Forbidden } from '../shared/api'
import { LIMITS, mebibytes } from '../shared/limits'
import type { Bucket } from './bucket'
import type { Db } from './db'
import { randomId } from './ids'
import { requireMember, type Principal } from './access'
import { httpReader } from './mcp/authenticate'
import { spaceFor } from './receipt-quota'
import { GROUP_DENIED, jsonError, sameOrigin } from './security'
import type { Tombstone } from './expense-read'

/** The multipart envelope may add this much to the image. */
const ENVELOPE_BYTES = 64 * 1024
const MAX_PIXELS = 40_000_000
/**
 * The pointer of a receipt stored by v2: this prefix and the object key. The
 * name is from the time v2 stored receipts in R2. The current app's objects
 * and v2's share one bucket and one key scheme.
 */
export const NEW_URL_PREFIX = 'r2://agentsplit-receipts/'

export type ImageInfo = { format: 'jpeg' | 'png'; width: number; height: number }

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

const sized = (info: ImageInfo) => (info.width >= 1 && info.height >= 1 && info.width * info.height <= MAX_PIXELS ? info : null)

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

/** The download address the UI and the API give for a receipt (P-RECEIPT-07). */
export const receiptDownloadPath = (data: { groupId: string; url: string }) => `/api/receipts?${new URLSearchParams({ groupId: data.groupId, url: data.url })}`

/**
 * The caller's membership of the group, or null when access is denied. A NUL
 * byte cannot name a group, and PostgreSQL text cannot hold it, so it is denied
 * before the query. Any other failure is thrown.
 */
async function memberOrNull(db: Db, data: { principal: Principal; group: string }) {
  if (data.group.includes('\0')) return null
  try {
    return await requireMember(db, data)
  } catch (error) {
    if (error instanceof Forbidden) return null
    throw error
  }
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
 * The reader of GET /api/receipts: an agent's API key or OAuth token, as for
 * MCP (P-RECEIPT-22, P-TOOL-GETEXP-06), else the web session. A request
 * with a bad agent credential does not fall back to the cookie.
 */
export async function receiptReader(db: Db, data: { request: Request; baseUrl: string; secret: string }): Promise<Principal | null> {
  const reader = await httpReader(db, data)
  return 'principal' in reader ? reader.principal : null
}

/**
 * GET /api/receipts?groupId=&url=. Membership is checked before storage is
 * read, on every request; receipts that only old revisions or deleted expenses
 * refer to stay readable to members (P-RECEIPT-27). A receipt deleted for good
 * answers 410 Gone, with who deleted it and when.
 */
export async function downloadReceipt(data: { db: Db; bucket: Bucket; principal: Principal | null; url: URL }): Promise<Response> {
  const groupId = data.url.searchParams.get('groupId')
  const url = data.url.searchParams.get('url')
  if (!groupId || !url) return jsonError({ status: 400, message: 'Receipt reference is required' })
  if (!data.principal) return jsonError({ status: 401, message: 'Authentication required' })
  const member = await memberOrNull(data.db, { principal: data.principal, group: groupId })
  if (!member) return jsonError({ status: 403, message: GROUP_DENIED })
  const key = receiptKey(url)
  const receipt = key ? await receiptInGroup(data.db, { groupId: member.groupId, url }) : null
  if (!key || !receipt?.found) return jsonError({ status: 404, message: 'Receipt not found' })
  if (receipt.deleted) return jsonError({ status: 410, message: `Receipt deleted by ${receipt.deleted.by} on ${receipt.deleted.at}` })
  const object = await data.bucket.get(key).catch(() => null)
  if (!object) return jsonError({ status: 404, message: 'Receipt not found' })
  return new Response(object.stream(), {
    headers: {
      'Content-Type': object.contentType === 'image/png' ? 'image/png' : 'image/jpeg',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  })
}

/**
 * POST /api/receipts, multipart with `groupId` and `file`. Only a signed-in
 * browser on the app's own origin may upload. The object is stored first and
 * registered to the group after; if the registration fails, the object is
 * removed. The uploader's storage quota is checked before the upload and again,
 * under the uploader's quota lock, when the receipt is registered.
 */
export async function uploadReceipt(data: {
  db: Db
  bucket: Bucket
  principal: Principal | null
  request: Request
  baseUrl: string
}): Promise<Response> {
  if (!sameOrigin({ request: data.request, baseUrl: data.baseUrl })) return jsonError({ status: 403, message: 'Origin not allowed' })
  if (!data.principal) return jsonError({ status: 401, message: 'Authentication required' })
  // Cap the body before parsing it.
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
  const member = await memberOrNull(data.db, { principal: data.principal, group: groupId })
  if (!member) return jsonError({ status: 403, message: GROUP_DENIED })
  const invalid = () => jsonError({ status: 400, message: `Could not upload receipt. Use a JPEG or PNG image up to ${mebibytes(LIMITS.receiptBytes)}.` })
  const bytes = new Uint8Array(await file.arrayBuffer())
  const info = bytes.length && bytes.length <= LIMITS.receiptBytes ? imageInfo(bytes) : null
  if (!info) return invalid()
  const { userId } = data.principal
  const full = (message: string) => jsonError({ status: 413, message })
  const early = await spaceFor(data.db, { userId, bytes: bytes.length, lock: false, outstanding: false })
  if (early) return full(early)
  const key = `receipts/${randomId()}.${info.format === 'jpeg' ? 'jpg' : 'png'}`
  const url = `${NEW_URL_PREFIX}${key}`
  const id = randomId()
  let refused: string | null
  try {
    await data.bucket.put(key, bytes, { contentType: info.format === 'jpeg' ? 'image/jpeg' : 'image/png' })
    refused = await data.db.transaction(async (tx) => {
      const message = await spaceFor(tx, { userId, bytes: bytes.length, lock: true, outstanding: false })
      if (!message) await tx.insert(receipts).values({ id, groupId: member.groupId, url, createdBy: userId, bytes: bytes.length })
      return message
    })
  } catch (error) {
    await data.bucket.delete(key).catch(() => {})
    console.error('Receipt upload failed', error)
    return invalid()
  }
  if (refused) {
    await data.bucket.delete(key).catch(() => {})
    return full(refused)
  }
  return Response.json({ id, url, width: info.width, height: info.height }, { headers: { 'Cache-Control': 'no-store' } })
}
