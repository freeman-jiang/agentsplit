// Receipt images in the receipts bucket (Garage), behind the membership check.
// The ledger stores a receipt by URL (the current app's storage URL, or an r2:
// pointer for new uploads); the object key is the URL's part after the storage prefix.
// Rules from the current app: src/lib/receipt-storage.ts, src/app/api/receipts/route.ts.
import { sql } from 'drizzle-orm'
import { receipts } from '../../db/schema/app'
import type { Bucket } from './bucket'
import type { Db } from './db'
import { randomId } from './ids'
import { requireMember, type Principal } from './ledger'

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024
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
 * `document-<time>-<id>.png`. Refuses keys with `..`, `?`, `#` or `%` (P-RECEIPT-26).
 */
export function receiptKey(url: string): string | null {
  const key = url.startsWith(NEW_URL_PREFIX) ? url.slice(NEW_URL_PREFIX.length) : /^https?:\/\/[^/]+\/[^/]+\/(.+)$/.exec(url)?.[1]
  if (!key || /\.\.|[?#%]/.test(key)) return null
  return key
}

/** The download address the UI and the API give for a receipt (P-RECEIPT-07). */
export const receiptDownloadPath = (data: { groupId: string; url: string }) => `/api/receipts?${new URLSearchParams({ groupId: data.groupId, url: data.url })}`

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })

/** Checks a member's access to a receipt: it must be registered to the group, or attached to one of its expenses. */
async function receiptInGroup(db: Db, data: { groupId: string; url: string }) {
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM receipts WHERE group_id = ${data.groupId} AND url = ${data.url})
      OR EXISTS (SELECT 1 FROM expense_documents d JOIN expenses e ON e.id = d.expense_id WHERE e.group_id = ${data.groupId} AND d.url = ${data.url}) AS found
  `)
  return result.rows[0]?.found === true
}

/**
 * The reader of GET /api/receipts: an agent's API key or OAuth token, as for
 * MCP (P-RECEIPT-22, P-TOOL-GETEXP-06), else the web session. A request
 * with a bad agent credential does not fall back to the cookie.
 */
export async function receiptReader(db: Db, data: { request: Request; baseUrl: string; secret: string }): Promise<Principal | null> {
  const headers = data.request.headers
  if (headers.has('x-api-key') || headers.has('authorization')) {
    const { authenticate } = await import('./mcp/authenticate')
    const result = await authenticate(db, { request: data.request, baseUrl: data.baseUrl })
    return 'principal' in result ? result.principal : null
  }
  const { sessionPrincipal } = await import('./session')
  return sessionPrincipal(db, { cookie: headers.get('cookie'), secret: data.secret, baseUrl: data.baseUrl })
}

/**
 * GET /api/receipts?groupId=&url=. Membership is checked before storage is
 * read, on every request; receipts that only old revisions or deleted expenses
 * refer to stay readable to members (P-RECEIPT-27).
 */
export async function downloadReceipt(data: { db: Db; bucket: Bucket; principal: Principal | null; url: URL }): Promise<Response> {
  const groupId = data.url.searchParams.get('groupId')
  const url = data.url.searchParams.get('url')
  if (!groupId || !url) return json(400, 'Receipt reference is required')
  if (!data.principal) return json(401, 'Authentication required')
  let member: { groupId: string }
  try {
    member = await requireMember(data.db, { principal: data.principal, group: groupId })
  } catch {
    return json(403, 'Group access denied')
  }
  const key = receiptKey(url)
  if (!key || !(await receiptInGroup(data.db, { groupId: member.groupId, url }))) return json(404, 'Receipt not found')
  const object = await data.bucket.get(key).catch(() => null)
  if (!object) return json(404, 'Receipt not found')
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
 * registered to the group after; if the registration fails, the object is removed.
 */
export async function uploadReceipt(data: {
  db: Db
  bucket: Bucket
  principal: Principal | null
  request: Request
  baseUrl: string
  enabled: boolean
}): Promise<Response> {
  if (data.request.headers.get('origin') !== new URL(data.baseUrl).origin) return json(403, 'Origin not allowed')
  if (!data.principal) return json(401, 'Authentication required')
  if (!data.enabled) return json(403, 'Receipts are disabled')
  // Cap the body before parsing it.
  const length = Number(data.request.headers.get('content-length'))
  if (!length || length > MAX_RECEIPT_BYTES + ENVELOPE_BYTES) return json(413, 'Receipt must be at most 5 MiB')
  let form: FormData
  try {
    form = await data.request.formData()
  } catch {
    return json(400, 'Group and image are required')
  }
  const groupId = form.get('groupId')
  const file = form.get('file')
  if (typeof groupId !== 'string' || typeof file === 'string' || file === null) return json(400, 'Group and image are required')
  let member: { groupId: string }
  try {
    member = await requireMember(data.db, { principal: data.principal, group: groupId })
  } catch {
    return json(403, 'Group access denied')
  }
  const invalid = () => json(400, 'Could not upload receipt. Use a JPEG or PNG image up to 5 MiB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const info = bytes.length && bytes.length <= MAX_RECEIPT_BYTES ? imageInfo(bytes) : null
  if (!info) return invalid()
  const key = `receipts/${randomId()}.${info.format === 'jpeg' ? 'jpg' : 'png'}`
  const url = `${NEW_URL_PREFIX}${key}`
  const id = randomId()
  try {
    await data.bucket.put(key, bytes, { contentType: info.format === 'jpeg' ? 'image/jpeg' : 'image/png' })
    await data.db.insert(receipts).values({ id, groupId: member.groupId, url, createdBy: data.principal.userId })
  } catch (error) {
    await data.bucket.delete(key).catch(() => {})
    console.error('Receipt upload failed', error)
    return invalid()
  }
  return Response.json({ id, url, width: info.width, height: info.height }, { headers: { 'Cache-Control': 'no-store' } })
}
