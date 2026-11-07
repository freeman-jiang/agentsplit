// Agent receipt uploads against a real database and the in-memory bucket: a
// target from create_expense, the one PUT, the attach through update_expense,
// and the download through /api/receipts with the same API key. Parity items
// are named in docs/v2/parity/mcp.md.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { receipts, receiptUploads } from '../../db/schema/app'
import { putUpload } from '~/server/receipt-routes'
import { removeStaleUploads } from '~/server/receipt-uploads'
import { BASE, failure, ok, startHarness, type Harness } from './mcp-harness'

let h: Harness
let alice: Record<string, string>
let bob: Record<string, string>
let mallory: Record<string, string>

const id21 = (n: number) => `u${String(n).padStart(20, '0')}`

beforeAll(async () => {
  h = await startHarness()
  await h.account('alice', { name: 'Alice' })
  await h.account('bob', { name: 'Bob' })
  await h.account('mallory', { name: 'Mallory' })
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g2', name: 'Trip', people: ['qa'], members: [['alice', 'qa', 'admin']] })
  alice = { 'x-api-key': await h.apiKey('alice') }
  bob = { authorization: `Bearer ${await h.apiKey('bob')}` }
  mallory = { 'x-api-key': await h.apiKey('mallory') }
})
afterAll(() => h.close())

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00])

const expense = {
  title: 'Groceries',
  expenseDate: '2026-11-01',
  amount: '20',
  currencyCode: 'USD',
  paidBy: 'pa',
  paidFor: [
    { participant: 'pa', shares: '1' },
    { participant: 'pb', shares: '1' },
  ],
  isReimbursement: false,
}

type Target = { uploadId: string; filename: string; method: string; url: string; headers: Record<string, string>; expiresAt: string }

/** Creates an expense in g1 and returns its upload targets. */
async function create(n: number, uploads: { filename: string; contentType: string; bytes: number }[], headers = alice) {
  const created = await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(n), expense, uploads }, headers })
  return created['uploads'] as Target[]
}

/** The agent's PUT to a target, with the target's headers unless others are given. */
const put = (target: Target, body: Uint8Array<ArrayBuffer>, headers = target.headers) =>
  h.withDb((db) =>
    putUpload({
      db,
      bucket: h.r2.bucket,
      request: new Request(target.url, { method: 'PUT', headers, body }),
      token: new URL(target.url).pathname.split('/').pop() ?? '',
    }),
  )

const revisionOf = async (n: number) => {
  const read = await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(n) }, headers: alice })
  return (read['expense'] as { revision: number }).revision
}

describe('agent receipt uploads', () => {
  it('reports attachments as enabled with the current limits', async () => {
    const reference = await ok(h, { name: 'get_reference_data', args: {}, headers: alice })
    expect(reference['attachments']).toEqual({ enabled: true, contentTypes: ['image/jpeg', 'image/png'], maxBytes: 5_242_880 })
  })

  it('uploads, attaches and downloads a receipt with the same API key', async () => {
    const image = png(640, 480)
    const [target, unused] = await create(1, [
      { filename: 'receipt.png', contentType: 'image/png', bytes: image.length },
      { filename: 'other.jpg', contentType: 'image/jpeg', bytes: 100 },
    ])
    if (!target || !unused) throw new Error('no targets')
    expect(target).toMatchObject({ filename: 'receipt.png', method: 'PUT', headers: { 'Content-Type': 'image/png', 'Content-Length': String(image.length) } })
    expect(target.url).toMatch(new RegExp(`^${BASE}/api/receipt-uploads/[A-Za-z0-9_-]{43}$`))
    expect(Date.parse(target.expiresAt) - Date.now()).toBeGreaterThan(290_000)
    // A target alone saves nothing.
    expect(await revisionOf(1)).toBe(1)

    expect((await put(target, image)).status).toBe(200)
    const attached = await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: alice })
    expect(attached).toMatchObject({ revision: 2, uploads: [], uploadError: null })

    const read = await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(1) }, headers: alice })
    const [document] = (read['expense'] as { documents: { url: string; width: number; height: number; downloadUrl: string }[] }).documents
    expect(document).toMatchObject({ width: 640, height: 480 })
    expect(document?.url).toMatch(/^r2:\/\/agentsplit-receipts\/receipts\/[A-Za-z0-9_-]{21}\.png$/)

    // GET downloadUrl with the agent's own key, and with another member's bearer key.
    const download = (headers: Record<string, string>) => h.app.fetch(new Request(document?.downloadUrl ?? '', { headers }))
    const image200 = await download(alice)
    expect(image200.status).toBe(200)
    expect(image200.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image200.arrayBuffer())).toEqual(image)
    expect((await download(bob)).status).toBe(200)
    expect((await download(mallory)).status).toBe(403)
    expect((await download({ 'x-api-key': 'agentsplit_not-a-real-key-0123456789abcdef' })).status).toBe(401)
    // A key at its rate limit keeps the endpoint's 429, so the agent waits instead of thinking its key is revoked.
    await h.withDb((db) => db.execute(sql`UPDATE apikey SET request_count = 1000, last_request = now() WHERE reference_id = 'alice'`))
    const limited = await download(alice)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    await h.withDb((db) => db.execute(sql`UPDATE apikey SET request_count = 0 WHERE reference_id = 'alice'`))
  })

  it('keeps or removes receipts with documents, and refuses a receipt of another group', async () => {
    const image = png(30, 20)
    const [target] = await create(8, [{ filename: 'keep.png', contentType: 'image/png', bytes: image.length }])
    if (!target) throw new Error('no target')
    expect((await put(target, image)).status).toBe(200)
    await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: alice })
    const read = await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(8) }, headers: alice })
    const [saved] = (read['expense'] as { documents: { id: string; url: string; width: number; height: number }[] }).documents
    if (!saved) throw new Error('no document')
    const kept = { id: saved.id, url: saved.url, width: saved.width, height: saved.height }

    const foreign = 'r2://agentsplit-receipts/receipts/ttttttttttttttttttttt.png'
    await h.withDb((db) => db.insert(receipts).values({ id: 'trip-receipt', groupId: 'g2', url: foreign, createdBy: 'alice' }))
    const refused = await failure(h, {
      name: 'update_expense',
      args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 2, changes: { documents: [kept, { id: 'x', url: foreign, width: 1, height: 1 }] } },
      headers: alice,
    })
    expect(refused).toMatchObject({ code: 'BAD_REQUEST', message: 'Attach only receipts uploaded to this group' })
    const removed = await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 2, changes: { documents: [] } }, headers: alice })
    expect(removed['revision']).toBe(3)
    const after = await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(8) }, headers: alice })
    expect((after['expense'] as { documents: unknown[] }).documents).toEqual([])
    // A group create may name a receipt of its own group again.
    const created = await ok(h, { name: 'create_expense', args: { groupId: 'g1', expenseId: id21(9), expense: { ...expense, documents: [kept] } }, headers: alice })
    expect(created['revision']).toBe(1)
  })

  it('refuses a reused or expired upload URL, and attaches an upload only once', async () => {
    const image = png(10, 10)
    const [first, second] = await create(2, [
      { filename: 'a.png', contentType: 'image/png', bytes: image.length },
      { filename: 'b.png', contentType: 'image/png', bytes: image.length },
    ])
    if (!first || !second) throw new Error('no targets')
    expect((await put(first, image)).status).toBe(200)
    expect((await put(first, png(20, 20))).status).toBe(403)

    // Wrong headers do not use up the target.
    expect((await put(second, image, { 'Content-Type': 'image/jpeg', 'Content-Length': String(image.length) })).status).toBe(400)
    await h.withDb((db) => db.update(receiptUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(receiptUploads.id, second.uploadId)))
    expect((await put(second, image)).status).toBe(403)

    await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 1, attachUploadIds: [first.uploadId] }, headers: alice })
    const again = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 2, attachUploadIds: [first.uploadId] }, headers: alice })
    expect(again).toMatchObject({ code: 'BAD_REQUEST', message: 'Receipt upload could not be finalized. Upload the file first, then retry with its uploadId.' })
    expect(await revisionOf(2)).toBe(2)
  })

  it('refuses a stored upload after 24 hours, or with content of another type', async () => {
    const image = png(10, 10)
    const [old, mislabeled] = await create(3, [
      { filename: 'old.png', contentType: 'image/png', bytes: image.length },
      { filename: 'jpeg.png', contentType: 'image/png', bytes: jpeg.length },
    ])
    if (!old || !mislabeled) throw new Error('no targets')
    expect((await put(old, image)).status).toBe(200)
    expect((await put(mislabeled, jpeg)).status).toBe(200)
    await h.withDb((db) => db.update(receiptUploads).set({ uploadedAt: sql`now() - interval '25 hours'` }).where(eq(receiptUploads.id, old.uploadId)))
    const expired = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, attachUploadIds: [old.uploadId] }, headers: alice })
    expect(expired).toMatchObject({ code: 'BAD_REQUEST', message: 'Upload is too large or expired' })
    const wrong = await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, attachUploadIds: [mislabeled.uploadId] }, headers: alice })
    expect(wrong).toMatchObject({ code: 'BAD_REQUEST', message: 'Receipts must be valid JPEG or PNG images' })
    expect(await revisionOf(3)).toBe(1)
  })

  it('refuses another principal’s or another expense’s upload, and an unfinished one, without a new revision', async () => {
    const image = png(10, 10)
    await create(4, [])
    // Bob is a member of the same group, but his upload is bound to him.
    const updated = await ok(h, {
      name: 'update_expense',
      args: { groupId: 'g1', expenseId: id21(4), expectedRevision: 1, uploads: [{ filename: 'bob.png', contentType: 'image/png', bytes: image.length }] },
      headers: bob,
    })
    expect(updated['revision']).toBe(1)
    const [bobs] = updated['uploads'] as Target[]
    if (!bobs) throw new Error('no target')
    expect((await put(bobs, image)).status).toBe(200)
    const [otherExpense] = await create(5, [{ filename: 'five.png', contentType: 'image/png', bytes: image.length }])
    if (!otherExpense) throw new Error('no target')
    expect((await put(otherExpense, image)).status).toBe(200)
    const [unfinished] = await create(6, [{ filename: 'six.png', contentType: 'image/png', bytes: image.length }])
    if (!unfinished) throw new Error('no target')

    const attach = (n: number, uploadId: string) => failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(n), expectedRevision: 1, attachUploadIds: [uploadId] }, headers: alice })
    for (const uploadId of [bobs.uploadId, otherExpense.uploadId])
      expect(await attach(4, uploadId)).toMatchObject({ code: 'FORBIDDEN', message: 'This upload does not belong to this user and expense' })
    expect(await attach(6, unfinished.uploadId)).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await attach(4, 'n0t-a-real-upload-id0')).toMatchObject({ code: 'BAD_REQUEST' })
    // A non-member cannot even reach the expense.
    expect(await failure(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(4), expectedRevision: 1, attachUploadIds: [bobs.uploadId] }, headers: mallory })).toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await revisionOf(4)).toBe(1)
    expect(await revisionOf(6)).toBe(1)
    // Bob attaches his own upload.
    expect((await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(4), expectedRevision: 1, attachUploadIds: [bobs.uploadId] }, headers: bob }))['revision']).toBe(2)
  })

  it('removes targets that can no longer be attached, with their objects', async () => {
    const image = png(10, 10)
    const [stale] = await create(7, [{ filename: 'stale.png', contentType: 'image/png', bytes: image.length }])
    if (!stale) throw new Error('no target')
    expect((await put(stale, image)).status).toBe(200)
    const [row] = await h.withDb((db) => db.select({ key: receiptUploads.key }).from(receiptUploads).where(eq(receiptUploads.id, stale.uploadId)))
    expect(h.r2.objects.has(row?.key ?? '')).toBe(true)
    await h.withDb((db) => db.update(receiptUploads).set({ createdAt: sql`now() - interval '26 hours'` }).where(eq(receiptUploads.id, stale.uploadId)))
    expect(await h.withDb((db) => removeStaleUploads({ db, bucket: h.r2.bucket }))).toBe(1)
    expect(h.r2.objects.has(row?.key ?? '')).toBe(false)
  })
})
