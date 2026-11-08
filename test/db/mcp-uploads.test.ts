// Agent receipt uploads against a real database and the in-memory bucket: a
// target from create_expense, the one PUT, the attach through update_expense,
// and the download through /api/receipts with the same API key. Parity items
// are named in docs/v2/parity/mcp.md.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { receipts, receiptUploads } from '../../db/schema/app'
import { removeStaleUploads } from '~/server/receipt-uploads'
import { LIMITS } from '~/shared/limits'
import { RECEIPT_CONTENT_TYPES } from '~/shared/vocabulary'
import { mcpExpense } from '../kit/drafts'
import { id21 as id } from '../kit/ids'
import { JPEG as jpeg, png as pngOf } from '../kit/images'
import { BASE, startHarness, type Harness } from './harness'

let h: Harness
let alice: Record<string, string>
let bob: Record<string, string>
let mallory: Record<string, string>

const id21 = (n: number) => id('u', n)

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

const png = (width: number, height: number) => pngOf({ width, height, bytes: 64 })

const expense = mcpExpense({ paidBy: 'pa', people: ['pa', 'pb'], title: 'Groceries', amount: '20' })

type Target = { uploadId: string; filename: string; method: string; url: string; headers: Record<string, string>; expiresAt: string }

/** Creates an expense in g1 and returns its upload targets. */
async function create(n: number, uploads: { filename: string; contentType: string; bytes: number }[], headers = alice) {
  const created = await h.mcp.ok({ name: 'create_expense', args: { groupId: 'g1', expenseId: id21(n), expense, uploads }, headers })
  return created['uploads'] as Target[]
}

/** The agent's PUT to a target through the app, with the target's headers unless others are given. */
const put = (target: Target, body: Uint8Array<ArrayBuffer>, headers = target.headers) => h.fetch(new Request(target.url, { method: 'PUT', headers, body }))

const revisionOf = async (n: number) => {
  const read = await h.mcp.ok({ name: 'get_expense', args: { groupId: 'g1', expenseId: id21(n) }, headers: alice })
  return (read['expense'] as { revision: number }).revision
}

describe('agent receipt uploads', () => {
  it('reports attachments as enabled with the limits the upload enforces', async () => {
    const reference = await h.mcp.ok({ name: 'get_reference_data', args: {}, headers: alice })
    expect(reference['attachments']).toEqual({ enabled: true, contentTypes: [...RECEIPT_CONTENT_TYPES], maxBytes: LIMITS.receiptBytes })
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
    expect(Date.parse(target.expiresAt) - Date.now()).toBeGreaterThan((LIMITS.uploadTargetSeconds - 10) * 1000)
    // A target alone saves nothing.
    expect(await revisionOf(1)).toBe(1)

    expect((await put(target, image)).status).toBe(200)
    const attached = await h.mcp.ok({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(1), expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: alice })
    expect(attached).toMatchObject({ revision: 2, uploads: [], uploadError: null })

    const read = await h.mcp.ok({ name: 'get_expense', args: { groupId: 'g1', expenseId: id21(1) }, headers: alice })
    const [document] = (read['expense'] as { documents: { url: string; width: number; height: number; downloadUrl: string }[] }).documents
    expect(document).toMatchObject({ width: 640, height: 480 })
    expect(document?.url).toMatch(/^r2:\/\/agentsplit-receipts\/receipts\/[A-Za-z0-9_-]{21}\.png$/)

    // GET downloadUrl with the agent's own key, and with another member's bearer key.
    const download = (headers: Record<string, string>) => h.fetch(new Request(document?.downloadUrl ?? '', { headers }))
    const image200 = await download(alice)
    expect(image200.status).toBe(200)
    expect(image200.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image200.arrayBuffer())).toEqual(image)
    expect((await download(bob)).status).toBe(200)
    expect((await download(mallory)).status).toBe(403)
    expect((await download({ 'x-api-key': 'agentsplit_not-a-real-key-0123456789abcdef' })).status).toBe(401)
    // A key at its rate limit keeps the endpoint's 429, so the agent waits instead of thinking its key is revoked.
    // A second key of Alice's, so the shared key keeps its budget for the later tests.
    const spent = await h.apiKeyWithId('alice')
    await h.withDb((db) => db.execute(sql`UPDATE apikey SET request_count = 1000, last_request = now() WHERE id = ${spent.id}`))
    const limited = await download({ 'x-api-key': spent.key })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('keeps or removes receipts with documents, and refuses a receipt of another group', async () => {
    const image = png(30, 20)
    const [target] = await create(8, [{ filename: 'keep.png', contentType: 'image/png', bytes: image.length }])
    if (!target) throw new Error('no target')
    expect((await put(target, image)).status).toBe(200)
    await h.mcp.ok({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: alice })
    const read = await h.mcp.ok({ name: 'get_expense', args: { groupId: 'g1', expenseId: id21(8) }, headers: alice })
    const [saved] = (read['expense'] as { documents: { id: string; url: string; width: number; height: number }[] }).documents
    if (!saved) throw new Error('no document')
    const kept = { id: saved.id, url: saved.url, width: saved.width, height: saved.height }

    const foreign = 'r2://agentsplit-receipts/receipts/ttttttttttttttttttttt.png'
    await h.withDb((db) => db.insert(receipts).values({ id: 'trip-receipt', groupId: 'g2', url: foreign, createdBy: 'alice' }))
    const refused = await h.mcp.failure({
      name: 'update_expense',
      args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 2, changes: { documents: [kept, { id: 'x', url: foreign, width: 1, height: 1 }] } },
      headers: alice,
    })
    expect(refused).toMatchObject({ code: 'BAD_REQUEST', message: 'Attach only receipts uploaded to this group' })
    const removed = await h.mcp.ok({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(8), expectedRevision: 2, changes: { documents: [] } }, headers: alice })
    expect(removed['revision']).toBe(3)
    const after = await h.mcp.ok({ name: 'get_expense', args: { groupId: 'g1', expenseId: id21(8) }, headers: alice })
    expect((after['expense'] as { documents: unknown[] }).documents).toEqual([])
    // A group create may name a receipt of its own group again.
    const created = await h.mcp.ok({ name: 'create_expense', args: { groupId: 'g1', expenseId: id21(9), expense: { ...expense, documents: [kept] } }, headers: alice })
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

    await h.mcp.ok({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 1, attachUploadIds: [first.uploadId] }, headers: alice })
    const again = await h.mcp.failure({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 2, attachUploadIds: [first.uploadId] }, headers: alice })
    expect(again).toMatchObject({ code: 'BAD_REQUEST', message: 'Receipt upload could not be finalized. Upload the file first, then retry with its uploadId.' })
    expect(await revisionOf(2)).toBe(2)
  })

  it('refuses a stored upload after its attach window, or with content of another type', async () => {
    const image = png(10, 10)
    const [old, mislabeled] = await create(3, [
      { filename: 'old.png', contentType: 'image/png', bytes: image.length },
      { filename: 'jpeg.png', contentType: 'image/png', bytes: jpeg.length },
    ])
    if (!old || !mislabeled) throw new Error('no targets')
    expect((await put(old, image)).status).toBe(200)
    expect((await put(mislabeled, jpeg)).status).toBe(200)
    await h.withDb((db) => db.update(receiptUploads).set({ uploadedAt: sql`now() - make_interval(hours => ${LIMITS.uploadAttachHours + 1})` }).where(eq(receiptUploads.id, old.uploadId)))
    const expired = await h.mcp.failure({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, attachUploadIds: [old.uploadId] }, headers: alice })
    expect(expired).toMatchObject({ code: 'BAD_REQUEST', message: 'Upload is too large or expired' })
    const wrong = await h.mcp.failure({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(3), expectedRevision: 1, attachUploadIds: [mislabeled.uploadId] }, headers: alice })
    expect(wrong).toMatchObject({ code: 'BAD_REQUEST', message: 'Receipts must be valid JPEG or PNG images' })
    expect(await revisionOf(3)).toBe(1)
  })

  it('refuses another principal’s or another expense’s upload, and an unfinished one, without a new revision', async () => {
    const image = png(10, 10)
    await create(4, [])
    // Bob is a member of the same group, but his upload is bound to him.
    const updated = await h.mcp.ok({
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

    const attach = (n: number, uploadId: string) => h.mcp.failure({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(n), expectedRevision: 1, attachUploadIds: [uploadId] }, headers: alice })
    for (const uploadId of [bobs.uploadId, otherExpense.uploadId])
      expect(await attach(4, uploadId)).toMatchObject({ code: 'FORBIDDEN', message: 'This upload does not belong to this user and expense' })
    expect(await attach(6, unfinished.uploadId)).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await attach(4, 'n0t-a-real-upload-id0')).toMatchObject({ code: 'BAD_REQUEST' })
    // A non-member cannot even reach the expense.
    expect(await h.mcp.failure({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(4), expectedRevision: 1, attachUploadIds: [bobs.uploadId] }, headers: mallory })).toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await revisionOf(4)).toBe(1)
    expect(await revisionOf(6)).toBe(1)
    // Bob attaches his own upload.
    expect((await h.mcp.ok({ name: 'update_expense', args: { groupId: 'g1', expenseId: id21(4), expectedRevision: 1, attachUploadIds: [bobs.uploadId] }, headers: bob }))['revision']).toBe(2)
  })

  it('removes targets that can no longer be attached, with their objects', async () => {
    const image = png(10, 10)
    const [stale] = await create(7, [{ filename: 'stale.png', contentType: 'image/png', bytes: image.length }])
    if (!stale) throw new Error('no target')
    expect((await put(stale, image)).status).toBe(200)
    const [row] = await h.withDb((db) => db.select({ key: receiptUploads.key }).from(receiptUploads).where(eq(receiptUploads.id, stale.uploadId)))
    expect(h.storage.objects.has(row?.key ?? '')).toBe(true)
    await h.withDb((db) => db.update(receiptUploads).set({ createdAt: sql`now() - make_interval(hours => ${LIMITS.uploadAttachHours + 2})` }).where(eq(receiptUploads.id, stale.uploadId)))
    expect(await h.withDb((db) => removeStaleUploads({ db, bucket: h.storage.bucket }))).toBe(1)
    expect(h.storage.objects.has(row?.key ?? '')).toBe(false)
  })
})
