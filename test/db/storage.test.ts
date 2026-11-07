// The receipt storage quota and permanent receipt deletion, against a real
// database and the in-memory bucket. A broken quota fails silently until
// someone abuses it, and a broken deletion either keeps the image or rewrites
// history, so each rule here has a test.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { receipts } from '../../db/schema/app'
import { makeDb, serializable, type Db } from '~/server/core/db'
import { getExpenseDetail } from '~/server/expenses'
import { getSavedExpense, listActivities } from '~/server/history'
import { createExpense, updateExpense } from '~/server/ledger'
import { type Principal } from '~/server/core/access'
import { receiptUsage, spaceFor } from '~/server/receipt-quota'
import { downloadReceipt, uploadReceipt } from '~/server/receipt-routes'
import { deleteReceipts, purgeDeletedReceipts } from '~/server/storage'
import { LIMITS } from '~/shared/limits'
import { BASE, failure, ok, startHarness, type Harness } from './mcp-harness'

let h: Harness
const web = (id: string, name: string): Principal => ({ userId: id, name, email: `${id}@example.com`, source: 'web', agentKeyId: null })
const alice = web('alice', 'Alice')
const bob = web('bob', 'Bob')
const cara = web('cara', 'Cara')
const mallory = web('mallory', 'Mallory')

beforeAll(async () => {
  h = await startHarness()
  for (const p of [alice, bob, cara, mallory]) await h.account(p.userId, { name: p.name })
  for (const id of ['dave', 'erin', 'hank']) await h.account(id)
  await h.group({
    id: 'g1',
    name: 'Home',
    people: ['pa', 'pb', 'pc', 'pd', 'pe'],
    members: [
      ['alice', 'pa', 'admin'],
      ['bob', 'pb', 'member'],
      ['cara', 'pc', 'member'],
      ['dave', 'pd', 'member'],
      ['erin', 'pe', 'member'],
    ],
  })
})
afterAll(() => h.close())

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

/** A browser upload to POST /api/receipts, on its own connection. */
async function upload(principal: Principal, image = png(40, 30)) {
  const form = new FormData()
  form.set('groupId', 'g1')
  form.set('file', new File([image], 'receipt.png', { type: 'image/png' }))
  const encoded = new Request(BASE, { method: 'POST', body: form })
  const bytes = await encoded.arrayBuffer()
  const request = new Request(`${BASE}/api/receipts`, {
    method: 'POST',
    body: bytes,
    headers: { origin: BASE, 'content-type': encoded.headers.get('content-type') ?? '', 'content-length': String(bytes.byteLength) },
  })
  return h.withDb((db) => uploadReceipt({ db, bucket: h.r2.bucket, principal, request }))
}

let filler = 0
/** Usage that is already there: a receipt row of `bytes` uploaded by `userId`. */
const fill = (userId: string, bytes: number) =>
  h.withDb((db) => db.insert(receipts).values({ id: `fill-${++filler}`, groupId: 'g1', url: `r2://agentsplit-receipts/receipts/fill-${filler}.jpg`, createdBy: userId, bytes }))

const usage = (userId: string) => h.withDb((db) => receiptUsage(db, userId))
const tx = <A>(work: (db: Db) => Promise<A>) => h.withDb((db) => serializable(db, work))

const draft = (notes: string) => ({
  kind: 'expense' as const,
  title: 'Groceries',
  vendor: null,
  notes,
  categoryId: 0,
  expenseDate: '2026-11-01',
  currency: 'USD' as const,
  amount: '20.00',
  payers: [{ participantId: 'pb', amount: '20.00' }],
  splitMode: 'evenly' as const,
  shares: [
    { participantId: 'pa', weight: '1' },
    { participantId: 'pb', weight: '1' },
  ],
  recurrence: 'none' as const,
})

describe('receipt storage quota', () => {
  it('counts the uploader’s receipts and refuses an upload that does not fit, with the plain message', async () => {
    await fill('dave', LIMITS.receiptStorageBytes - 100)
    const dave = web('dave', 'Dave')
    expect((await upload(dave)).status).toBe(200)
    expect(await usage('dave')).toBe(LIMITS.receiptStorageBytes - 100 + 64)
    const refused = await upload(dave)
    expect(refused.status).toBe(413)
    expect(((await refused.json()) as { error: string }).error).toMatch(/^You're out of receipt space \(500 MB of 500 MB\)\. Download or delete old receipts/)
    expect(await usage('dave')).toBe(LIMITS.receiptStorageBytes - 36)
  })

  it('lets only one of two concurrent uploads use the last free space', async () => {
    await fill('erin', LIMITS.receiptStorageBytes - 100)
    const erin = web('erin', 'Erin')
    const results = await Promise.all([upload(erin), upload(erin), upload(erin)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 413, 413])
    expect(await usage('erin')).toBeLessThanOrEqual(LIMITS.receiptStorageBytes)
    // A refused upload leaves no object behind.
    const stored = await h.withDb((db) => db.select({ url: receipts.url }).from(receipts).where(eq(receipts.createdBy, 'erin')))
    const keys = [...h.r2.objects.keys()].filter((k) => stored.some((r) => r.url.endsWith(k)))
    expect(keys).toHaveLength(1)
  })

  it('makes a second upload wait for the first one’s commit before it decides, so both cannot take the last free space', async () => {
    await h.account('kim')
    await fill('kim', LIMITS.receiptStorageBytes - 100)
    const [first, second] = [await h.pool.connect(), await h.pool.connect()]
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      expect(await spaceFor(makeDb(first), { userId: 'kim', bytes: 64, lock: true, outstanding: false })).toBeNull()
      await makeDb(first).insert(receipts).values({ id: 'kim-1', groupId: 'g1', url: 'r2://agentsplit-receipts/receipts/kim-1.png', createdBy: 'kim', bytes: 64 })
      let decided = false
      const waiting = spaceFor(makeDb(second), { userId: 'kim', bytes: 64, lock: true, outstanding: false }).finally(() => {
        decided = true
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(decided).toBe(false)
      await first.query('COMMIT')
      expect(await waiting).toMatch(/^You're out of receipt space/)
    } finally {
      await second.query('ROLLBACK')
      first.release()
      second.release()
    }
  })

  it('reports a full quota as uploadError when an agent asks for targets, and refuses the attach when space ran out since', async () => {
    await h.group({ id: 'g2', name: 'Trip', people: ['ha'], members: [['hank', 'ha', 'admin']] })
    const hank = { 'x-api-key': await h.apiKey('hank') }
    await fill('hank', LIMITS.receiptStorageBytes - 100)
    const expense = { title: 'Taxi', expenseDate: '2026-11-01', amount: '9', currencyCode: 'USD', paidBy: 'ha', paidFor: [{ participant: 'ha', shares: '1' }], isReimbursement: false }
    const image = png(20, 20)
    const created = await ok(h, {
      name: 'create_expense',
      args: { groupId: 'g2', expenseId: 'q0000000000000000000a', expense, uploads: [{ filename: 'a.png', contentType: 'image/png', bytes: image.length }] },
      headers: hank,
    })
    const [target] = created['uploads'] as { uploadId: string; url: string; headers: Record<string, string> }[]
    if (!target) throw new Error('no target')
    // The outstanding target counts: a second request does not fit, but the expense is saved.
    const second = await ok(h, {
      name: 'create_expense',
      args: { groupId: 'g2', expenseId: 'q0000000000000000000b', expense, uploads: [{ filename: 'b.png', contentType: 'image/png', bytes: image.length }] },
      headers: hank,
    })
    expect(second).toMatchObject({ revision: 1, uploads: [] })
    expect(second['uploadError']).toMatch(/^You're out of receipt space/)

    const put = await h.app.fetch(new Request(target.url, { method: 'PUT', headers: target.headers, body: image }))
    expect(put.status).toBe(200)
    await fill('hank', 50)
    const refused = await failure(h, { name: 'update_expense', args: { groupId: 'g2', expenseId: 'q0000000000000000000a', expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: hank })
    expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', outcomeUnknown: false })
    expect(refused.message).toMatch(/^You're out of receipt space/)
  })
})

describe('permanent receipt deletion', () => {
  it('frees the uploader’s space and tombstones the receipt in old revisions, the log and downloads, without changing any activity', async () => {
    const uploaded = (await (await upload(bob, png(64, 48))).json()) as { id: string; url: string; width: number; height: number }
    const document = { id: 'new', url: uploaded.url, width: uploaded.width, height: uploaded.height }
    const expenseId = 'd0000000000000000000a'
    await tx((db) => createExpense(db, { principal: bob, groupId: 'g1', expenseId, idempotencyKey: null, expense: draft(''), documents: [document] }))
    await tx((db) => updateExpense(db, { principal: alice, groupId: 'g1', expenseId, expectedRevision: 1, idempotencyKey: null, expense: draft('Two people') }))
    expect(await usage('bob')).toBe(64)
    const key = uploaded.url.replace('r2://agentsplit-receipts/', '')
    expect(h.r2.objects.has(key)).toBe(true)

    const history = () => h.withDb(async (db) => (await db.execute<{ id: string; row: string }>(sql`SELECT id, row_to_json(a)::text AS row FROM activities a WHERE group_id = 'g1' ORDER BY sequence`)).rows)
    const before = await history()

    const result = await tx((db) => deleteReceipts(db, { principal: bob, receiptIds: [uploaded.id] }))
    expect(result).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 64 }], freedBytes: 64 })
    expect(await h.withDb((db) => purgeDeletedReceipts({ db, bucket: h.r2.bucket, receiptIds: [uploaded.id] }))).toBe(1)
    expect(h.r2.objects.has(key)).toBe(false)
    expect(await usage('bob')).toBe(0)

    // Every earlier activity is byte for byte the same; one new revision removes the receipt.
    const after = await history()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1)
    const detail = await h.withDb((db) => getExpenseDetail(db, { principal: alice, groupId: 'g1', expenseId }))
    expect(detail.expense).toMatchObject({ revision: 3, amount: '20.00', documentCount: 0 })
    expect(detail.documents).toEqual([])

    const tombstone = { by: 'Bob', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }
    const saved = await h.withDb((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId, revision: 1 }))
    expect(saved.expense.documents).toEqual([{ id: expect.any(String), url: uploaded.url, deleted: tombstone }])
    const log = await h.withDb((db) => listActivities(db, { principal: alice, groupId: 'g1', expenseId, order: 'asc', limit: 10 }))
    const created = log.activities[0]?.snapshot
    expect(created?._tag === 'expense' ? created.expense.documents : null).toEqual([{ id: expect.any(String), url: uploaded.url, deleted: tombstone }])

    const download = await h.withDb((db) =>
      downloadReceipt({ db, bucket: h.r2.bucket, reader: { principal: alice }, url: new URL(`${BASE}/api/receipts?${new URLSearchParams({ groupId: 'g1', url: uploaded.url })}`) }),
    )
    expect(download.status).toBe(410)
    expect(((await download.json()) as { error: string }).error).toMatch(/^Receipt deleted by Bob on \d{4}-\d\d-\d\d$/)

    // Agents see the tombstone instead of a download URL.
    const agent = await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId, revision: 1 }, headers: { 'x-api-key': await h.apiKey('alice') } })
    const [agentDocument] = (agent['expense'] as { documents: Record<string, unknown>[] }).documents
    expect(agentDocument).toMatchObject({ url: uploaded.url, deleted: tombstone })
    expect(agentDocument).not.toHaveProperty('downloadUrl')

    // The receipt cannot be attached again, and a second delete frees nothing.
    await expect(
      tx((db) => updateExpense(db, { principal: bob, groupId: 'g1', expenseId, expectedRevision: 3, idempotencyKey: null, expense: draft('Two people'), documents: [document] })),
    ).rejects.toMatchObject({ _tag: 'Invalid', field: 'documents' })
    expect(await tx((db) => deleteReceipts(db, { principal: bob, receiptIds: [uploaded.id] }))).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 0 }], freedBytes: 0 })
  })

  it('lets only the uploader or a group admin delete, and hides receipts of other groups', async () => {
    const mine = (await (await upload(bob)).json()) as { id: string }
    const other = (await (await upload(bob)).json()) as { id: string }
    await expect(tx((db) => deleteReceipts(db, { principal: cara, receiptIds: [mine.id] }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(tx((db) => deleteReceipts(db, { principal: mallory, receiptIds: [mine.id] }))).rejects.toMatchObject({ _tag: 'NotFound' })
    // One refused receipt refuses the whole request.
    await expect(tx((db) => deleteReceipts(db, { principal: cara, receiptIds: [other.id, mine.id] }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(await usage('bob')).toBe(128)
    expect((await tx((db) => deleteReceipts(db, { principal: alice, receiptIds: [mine.id] }))).freedBytes).toBe(64)
    expect(await usage('bob')).toBe(64)
  })

  it('deletes through the agent tool and removes the object from storage after the commit', async () => {
    const uploaded = (await (await upload(bob)).json()) as { id: string; url: string }
    const key = uploaded.url.replace('r2://agentsplit-receipts/', '')
    const bobKey = { 'x-api-key': await h.apiKey('bob') }
    const listed = await ok(h, { name: 'list_receipts', args: { order: 'oldest' }, headers: bobKey })
    expect((listed['receipts'] as { receiptId: string }[]).map((r) => r.receiptId)).toContain(uploaded.id)
    const before = await usage('bob')
    const deleted = await ok(h, { name: 'delete_receipts', args: { receiptIds: [uploaded.id] }, headers: bobKey })
    expect(deleted).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 64 }], freedBytes: 64, usedBytes: before - 64 })
    expect(h.r2.objects.has(key)).toBe(false)
    const purged = await h.withDb(async (db) => (await db.execute<{ purged: boolean }>(sql`SELECT purged_at IS NOT NULL AS purged FROM deleted_receipts WHERE receipt_id = ${uploaded.id}`)).rows[0])
    expect(purged).toEqual({ purged: true })
  })
})

