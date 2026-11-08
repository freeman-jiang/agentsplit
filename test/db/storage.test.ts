// The receipt storage quota and permanent receipt deletion, against a real
// database and the in-memory bucket. A broken quota fails silently until
// someone abuses it, and a broken deletion either keeps the image or rewrites
// history, so each rule here has a test.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { receipts } from '../../db/schema/app'
import { getExpenseDetail } from '~/server/expenses'
import { getSavedExpense, listActivities } from '~/server/history'
import { createExpense, deleteExpense, updateExpense } from '~/server/ledger'
import { receiptUsage } from '~/server/receipt-quota'
import { RECEIPT_REFUSED, receiptKey, receiptUrl } from '~/server/receipts'
import { deleteReceipts, purgeDeletedReceipts } from '~/server/storage'
import { LIMITS, storageFullMessage } from '~/shared/limits'
import { GROUP_DENIED } from '~/shared/errors'
import { RECEIPTS_PATH } from '~/shared/paths'
import { draft, mcpExpense } from '../kit/drafts'
import { counter } from '../kit/ids'
import { png } from '../kit/images'
import { principal } from '../kit/people'
import { receiptUpload } from '../kit/upload'
import { waitFor } from '../kit/wait'
import { BASE, startHarness, testApp, type Harness } from './harness'

let h: Harness
const cookies = new Map<string, string>()
const groupId = counter('g')

beforeAll(async () => {
  h = await startHarness()
})
afterAll(() => h.close())

/** A new group whose people are the new accounts `users`, the first of them its admin. Returns the group ID. */
async function groupOf(...users: [string, ...string[]]): Promise<string> {
  for (const id of users) if (!cookies.has(id)) cookies.set(id, (await h.account(id, { name: id.toUpperCase() })).cookie)
  const id = groupId()
  const [admin, ...others] = users
  await h.group({ id, people: users.map((u) => `p-${u}`), members: [[admin, `p-${admin}`, 'admin'], ...others.map((u): [string, string, 'member'] => [u, `p-${u}`, 'member'])] })
  return id
}

/** A browser upload to POST /api/receipts with the user's session. */
async function upload(data: { userId: string; groupId: string; image?: Uint8Array<ArrayBuffer> }) {
  return h.fetch(await receiptUpload({ baseUrl: BASE, groupId: data.groupId, file: data.image ?? png({ width: 40, height: 30, bytes: 64 }), cookie: cookies.get(data.userId) ?? '' }))
}

const fillers = counter('fill')
/** Usage that is already there: a receipt row of `bytes` uploaded by `userId`. */
const fill = (data: { userId: string; groupId: string; bytes: number }) => {
  const id = fillers()
  return h.withDb((db) => db.insert(receipts).values({ id, groupId: data.groupId, url: receiptUrl(`receipts/${id}.jpg`), createdBy: data.userId, bytes: data.bytes }))
}
/** GET /api/receipts with the user's session, or with no credential when `userId` is null. */
const download = (data: { userId: string | null; groupId: string; url?: string }) =>
  h.fetch(
    new Request(`${BASE}${RECEIPTS_PATH}?${new URLSearchParams({ groupId: data.groupId, ...(data.url === undefined ? {} : { url: data.url }) })}`, {
      headers: data.userId ? { cookie: cookies.get(data.userId) ?? '' } : {},
    }),
  )
const usage = (userId: string) => h.withDb((db) => receiptUsage(db, userId))
const keyOf = (url: string) => receiptKey(url) ?? ''

describe('receipt storage quota', () => {
  it('counts the uploader’s receipts and refuses an upload that does not fit, with the plain message', async () => {
    const g = await groupOf('dave')
    await fill({ userId: 'dave', groupId: g, bytes: LIMITS.receiptStorageBytes - 100 })
    expect((await upload({ userId: 'dave', groupId: g })).status).toBe(200)
    expect(await usage('dave')).toBe(LIMITS.receiptStorageBytes - 100 + 64)
    const refused = await upload({ userId: 'dave', groupId: g })
    expect(refused.status).toBe(413)
    expect(((await refused.json()) as { error: string }).error).toBe(storageFullMessage(LIMITS.receiptStorageBytes - 36))
    expect(await usage('dave')).toBe(LIMITS.receiptStorageBytes - 36)
  })

  it('lets only one of two concurrent uploads use the last free space, and a refused upload leaves no object', async () => {
    const g = await groupOf('erin')
    await fill({ userId: 'erin', groupId: g, bytes: LIMITS.receiptStorageBytes - 100 })
    // Holding this lock stops every receipt insert, but not the reads of the quota check, so both
    // uploads reach their decision before either one's receipt row exists.
    const gate = await h.pool.connect()
    try {
      await gate.query('BEGIN')
      await gate.query('LOCK TABLE receipts IN EXCLUSIVE MODE')
      const uploads = [upload({ userId: 'erin', groupId: g }), upload({ userId: 'erin', groupId: g })]
      // One waits for the table and the other for the uploader's quota lock; without that lock, both would wait for the table.
      await waitFor(
        async () => (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]?.n === 2,
        { what: 'both uploads to wait for a lock' },
      )
      await gate.query('COMMIT')
      expect((await Promise.all(uploads)).map((r) => r.status).sort()).toEqual([200, 413])
    } finally {
      await gate.query('ROLLBACK')
      gate.release()
    }
    expect(await usage('erin')).toBe(LIMITS.receiptStorageBytes - 36)
    const stored = await h.withDb((db) => db.select({ url: receipts.url }).from(receipts).where(eq(receipts.createdBy, 'erin')))
    const objects = [...h.storage.objects.keys()].filter((k) => stored.some((r) => keyOf(r.url) === k))
    expect(objects).toHaveLength(1)
  })

  it('reports a full quota as uploadError when an agent asks for targets, and refuses the attach when space ran out since', async () => {
    const g = await groupOf('hank')
    const hank = { 'x-api-key': await h.apiKey('hank') }
    await fill({ userId: 'hank', groupId: g, bytes: LIMITS.receiptStorageBytes - 100 })
    const expense = mcpExpense({ paidBy: 'p-hank', people: ['p-hank'], title: 'Taxi', amount: '9' })
    const image = png({ width: 20, height: 20, bytes: 64 })
    const created = await h.mcp.ok({
      name: 'create_expense',
      args: { groupId: g, expenseId: 'q0000000000000000000a', expense, uploads: [{ filename: 'a.png', contentType: 'image/png', bytes: image.length }] },
      headers: hank,
    })
    const [target] = created['uploads'] as { uploadId: string; url: string; headers: Record<string, string> }[]
    if (!target) throw new Error('no target')
    // The outstanding target counts: a second request does not fit, but the expense is saved.
    const second = await h.mcp.ok({
      name: 'create_expense',
      args: { groupId: g, expenseId: 'q0000000000000000000b', expense, uploads: [{ filename: 'b.png', contentType: 'image/png', bytes: image.length }] },
      headers: hank,
    })
    expect(second).toMatchObject({ revision: 1, uploads: [] })
    expect(second['uploadError']).toMatch(/^Your receipt storage is full/)

    const put = await h.fetch(new Request(target.url, { method: 'PUT', headers: target.headers, body: image }))
    expect(put.status).toBe(200)
    await fill({ userId: 'hank', groupId: g, bytes: 50 })
    const refused = await h.mcp.failure({ name: 'update_expense', args: { groupId: g, expenseId: 'q0000000000000000000a', expectedRevision: 1, attachUploadIds: [target.uploadId] }, headers: hank })
    expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', outcomeUnknown: false })
    expect(refused.message).toMatch(/^Your receipt storage is full/)
  })
})

describe('permanent receipt deletion', () => {
  it('frees the uploader’s space and tombstones the receipt in old revisions, the log and downloads, without changing any activity', async () => {
    const g = await groupOf('alice', 'bob')
    const [alice, bob] = [principal('alice', { name: 'ALICE' }), principal('bob', { name: 'BOB' })]
    const uploaded = (await (await upload({ userId: 'bob', groupId: g, image: png({ width: 64, height: 48, bytes: 64 }) })).json()) as { id: string; url: string; width: number; height: number }
    const document = { id: 'new', url: uploaded.url, width: uploaded.width, height: uploaded.height }
    const expense = (notes: string) => draft({ payer: 'p-bob', people: ['p-alice', 'p-bob'], amount: '20.00', notes })
    const expenseId = 'd0000000000000000000a'
    await h.tx((db) => createExpense(db, { principal: bob, groupId: g, expenseId, idempotencyKey: null, expense: expense(''), documents: [document] }))
    await h.tx((db) => updateExpense(db, { principal: alice, groupId: g, expenseId, expectedRevision: 1, idempotencyKey: null, expense: expense('Two people') }))
    expect(await usage('bob')).toBe(64)
    expect(h.storage.objects.has(keyOf(uploaded.url))).toBe(true)

    const history = () => h.withDb(async (db) => (await db.execute<{ id: string; row: string }>(sql`SELECT id, row_to_json(a)::text AS row FROM activities a WHERE group_id = ${g} ORDER BY sequence`)).rows)
    const before = await history()

    const result = await h.tx((db) => deleteReceipts(db, { principal: bob, receiptIds: [uploaded.id] }))
    expect(result).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 64 }], freedBytes: 64 })
    expect(await h.withDb((db) => purgeDeletedReceipts({ db, bucket: h.storage.bucket, receiptIds: [uploaded.id] }))).toBe(1)
    expect(h.storage.objects.has(keyOf(uploaded.url))).toBe(false)
    expect(await usage('bob')).toBe(0)

    // Every earlier activity is byte for byte the same; one new revision removes the receipt.
    const after = await history()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1)
    const detail = await h.withDb((db) => getExpenseDetail(db, { principal: alice, groupId: g, expenseId }))
    expect(detail.expense).toMatchObject({ revision: 3, amount: '20.00', documentCount: 0 })
    expect(detail.documents).toEqual([])

    const tombstone = { by: 'BOB', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }
    const saved = await h.withDb((db) => getSavedExpense(db, { principal: alice, groupId: g, expenseId, revision: 1 }))
    expect(saved.expense.documents).toEqual([{ id: expect.any(String), url: uploaded.url, deleted: tombstone }])
    const log = await h.withDb((db) => listActivities(db, { principal: alice, groupId: g, expenseId, order: 'asc', limit: 10 }))
    const created = log.activities[0]?.snapshot
    expect(created?._tag === 'expense' ? created.expense.documents : null).toEqual([{ id: expect.any(String), url: uploaded.url, deleted: tombstone }])

    const gone = await download({ userId: 'alice', groupId: g, url: uploaded.url })
    expect(gone.status).toBe(410)
    expect(((await gone.json()) as { error: string }).error).toMatch(/^Receipt deleted by BOB on \d{4}-\d\d-\d\d$/)

    // Agents see the tombstone instead of a download URL.
    const agent = await h.mcp.ok({ name: 'get_expense', args: { groupId: g, expenseId, revision: 1 }, headers: { 'x-api-key': await h.apiKey('alice') } })
    const [agentDocument] = (agent['expense'] as { documents: Record<string, unknown>[] }).documents
    expect(agentDocument).toMatchObject({ url: uploaded.url, deleted: tombstone })
    expect(agentDocument).not.toHaveProperty('downloadUrl')

    // The receipt cannot be attached again, and a second delete frees nothing.
    await expect(
      h.tx((db) => updateExpense(db, { principal: bob, groupId: g, expenseId, expectedRevision: 3, idempotencyKey: null, expense: expense('Two people'), documents: [document] })),
    ).rejects.toMatchObject({ _tag: 'Invalid', field: 'documents' })
    expect(await h.tx((db) => deleteReceipts(db, { principal: bob, receiptIds: [uploaded.id] }))).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 0 }], freedBytes: 0 })
  })

  it('lets only the uploader or a group admin delete, and hides receipts of other groups', async () => {
    const g = await groupOf('olga', 'pete', 'quinn')
    await groupOf('mallory')
    const [olga, pete, quinn, mallory] = ['olga', 'pete', 'quinn', 'mallory'].map((id) => principal(id))
    if (!olga || !pete || !quinn || !mallory) throw new Error('four people')
    const mine = (await (await upload({ userId: 'pete', groupId: g })).json()) as { id: string }
    const other = (await (await upload({ userId: 'pete', groupId: g })).json()) as { id: string }
    await expect(h.tx((db) => deleteReceipts(db, { principal: quinn, receiptIds: [mine.id] }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(h.tx((db) => deleteReceipts(db, { principal: mallory, receiptIds: [mine.id] }))).rejects.toMatchObject({ _tag: 'NotFound' })
    // One refused receipt refuses the whole request.
    await expect(h.tx((db) => deleteReceipts(db, { principal: quinn, receiptIds: [other.id, mine.id] }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    expect(await usage('pete')).toBe(128)
    expect((await h.tx((db) => deleteReceipts(db, { principal: olga, receiptIds: [mine.id] }))).freedBytes).toBe(64)
    expect(await usage('pete')).toBe(64)
  })

  it('deletes through the agent tool and removes the object from storage after the commit', async () => {
    const g = await groupOf('rosa')
    const uploaded = (await (await upload({ userId: 'rosa', groupId: g })).json()) as { id: string; url: string }
    const key = { 'x-api-key': await h.apiKey('rosa') }
    const listed = await h.mcp.ok({ name: 'list_receipts', args: { order: 'oldest' }, headers: key })
    expect((listed['receipts'] as { receiptId: string }[]).map((r) => r.receiptId)).toEqual([uploaded.id])
    const deleted = await h.mcp.ok({ name: 'delete_receipts', args: { receiptIds: [uploaded.id] }, headers: key })
    expect(deleted).toEqual({ deleted: [{ receiptId: uploaded.id, bytes: 64 }], freedBytes: 64, usedBytes: 0 })
    expect(h.storage.objects.has(keyOf(uploaded.url))).toBe(false)
    const purged = await h.withDb(async (db) => (await db.execute<{ purged: boolean }>(sql`SELECT purged_at IS NOT NULL AS purged FROM deleted_receipts WHERE receipt_id = ${uploaded.id}`)).rows[0])
    expect(purged).toEqual({ purged: true })
  })
})

describe('receipt uploads and downloads', () => {
  it('keeps the receipt ZIP file valid when storage fails on one receipt, and names that receipt', async () => {
    const g = await groupOf('ivy')
    for (let i = 0; i < 2; i++) expect((await upload({ userId: 'ivy', groupId: g })).status).toBe(200)
    const [broken, ...rest] = await h.withDb((db) => db.select({ url: receipts.url }).from(receipts).where(eq(receipts.groupId, g)))
    const brokenKey = keyOf(broken?.url ?? '')
    const down = testApp({
      pool: h.pool,
      bucket: { ...h.storage.bucket, get: (key, options) => (key === brokenKey ? Promise.reject(new Error('storage is down')) : h.storage.bucket.get(key, options)) },
    })
    const response = await down.fetch(new Request(`${BASE}/groups/${g}/expenses/export/receipts`, { headers: { cookie: cookies.get('ivy') ?? '' } }))
    const zip = new Uint8Array(await response.arrayBuffer())
    // The end-of-central-directory record closes every complete ZIP file, and counts its entries.
    const end = new DataView(zip.buffer, zip.length - 22)
    expect({ signature: end.getUint32(0, true), entries: end.getUint16(10, true) }).toEqual({ signature: 0x06054b50, entries: rest.length + 1 })
    expect(new TextDecoder().decode(zip)).toMatch(/could not be read from storage[^]*Not attached\//)
  })

  it('refuses a download without a session or an API key before reading storage', async () => {
    const g = await groupOf('ursula')
    const uploaded = (await (await upload({ userId: 'ursula', groupId: g })).json()) as { url: string }
    const reads = h.storage.calls.length
    const anonymous = await download({ userId: null, groupId: g, url: uploaded.url })
    expect(anonymous.status).toBe(401)
    expect(h.storage.calls.slice(reads)).toEqual([])
  })

  it('checks the reference and the membership before reading storage', async () => {
    const g = await groupOf('vera')
    const other = await groupOf('wanda')
    const [registered, foreign] = [receiptUrl(`receipts/${fillers()}.jpg`), receiptUrl(`receipts/${fillers()}.jpg`)]
    await h.withDb((db) =>
      db.insert(receipts).values([
        { id: fillers(), groupId: g, url: registered, createdBy: 'vera' },
        { id: fillers(), groupId: other, url: foreign, createdBy: 'wanda' },
      ]),
    )
    const reads = h.storage.calls.length
    expect((await download({ userId: 'vera', groupId: g })).status).toBe(400)
    const denied = await download({ userId: 'wanda', groupId: g, url: registered })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(await denied.json()).toEqual({ error: GROUP_DENIED })
    // PostgreSQL text cannot hold a NUL byte: such a reference is denied or not found, never a database error.
    expect((await download({ userId: 'vera', groupId: `${g}\0`, url: registered })).status).toBe(403)
    expect((await download({ userId: 'vera', groupId: g, url: `${registered}\0` })).status).toBe(404)
    // Another group's receipt is not found through this group.
    expect((await download({ userId: 'vera', groupId: g, url: foreign })).status).toBe(404)
    expect(h.storage.calls.slice(reads)).toEqual([])
    // Registered, but missing in storage.
    expect((await download({ userId: 'vera', groupId: g, url: registered })).status).toBe(404)
  })

  it('uploads to the bucket for a member, and serves the image with safe headers', async () => {
    const g = await groupOf('xena', 'yuri')
    const other = await groupOf('zack')
    const send = async (data: { groupId: string; file: Uint8Array<ArrayBuffer>; length?: number; userId?: string | null }) =>
      h.fetch(await receiptUpload({ baseUrl: BASE, type: 'image/jpeg', groupId: data.groupId, file: data.file, ...(data.length === undefined ? {} : { length: data.length }), ...(data.userId === null ? {} : { cookie: cookies.get(data.userId ?? 'xena') ?? '' }) }))
    const objects = h.storage.objects.size
    const tiny = png({ width: 1, height: 1 })
    expect((await send({ groupId: g, file: tiny, userId: null })).status).toBe(401)
    expect((await send({ groupId: g, file: tiny, length: 2 * LIMITS.receiptBytes })).status).toBe(413)
    expect((await send({ groupId: other, file: tiny })).status).toBe(403)
    const bad = await send({ groupId: g, file: new TextEncoder().encode('not an image at all, really') })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: RECEIPT_REFUSED })
    expect((await send({ groupId: g, file: png({ width: LIMITS.receiptPixelsMax + 1, height: 1 }) })).status).toBe(400)
    expect(h.storage.objects.size).toBe(objects)

    // A storage outage is an outage, not a refused image.
    const down = testApp({ pool: h.pool, bucket: { ...h.storage.bucket, put: () => Promise.reject(new Error('storage is down')) } })
    const outage = await down.fetch(await receiptUpload({ baseUrl: BASE, type: 'image/png', groupId: g, file: png({ width: 2, height: 2 }), cookie: cookies.get('xena') ?? '' }))
    expect(outage.status).toBe(503)

    const stored = await send({ groupId: g, file: png({ width: 64, height: 48 }) })
    expect(stored.status).toBe(200)
    const receipt = (await stored.json()) as { id: string; url: string; width: number; height: number }
    expect(receipt).toMatchObject({ width: 64, height: 48 })
    expect(receipt.url).toMatch(/^r2:\/\/agentsplit-receipts\/receipts\/[A-Za-z0-9_-]{21}\.png$/)
    // The detected type wins over the declared image/jpeg.
    expect(h.storage.objects.get(keyOf(receipt.url))?.contentType).toBe('image/png')

    const image = await download({ userId: 'yuri', groupId: g, url: receipt.url })
    expect(image.status).toBe(200)
    expect(Object.fromEntries(image.headers)).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
    })
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png({ width: 64, height: 48 }))
  })

  it('serves a receipt that only a deleted expense refers to', async () => {
    const g = await groupOf('abel', 'bert')
    const uploaded = (await (await upload({ userId: 'abel', groupId: g })).json()) as { id: string; url: string; width: number; height: number }
    const expenseId = 'd0000000000000000000b'
    const expense = draft({ payer: 'p-abel', people: ['p-abel', 'p-bert'], amount: '20.00' })
    await h.tx((db) => createExpense(db, { principal: principal('abel'), groupId: g, expenseId, idempotencyKey: null, expense, documents: [{ id: 'kept', url: uploaded.url, width: uploaded.width, height: uploaded.height }] }))
    await h.tx((db) => deleteExpense(db, { principal: principal('abel'), groupId: g, expenseId, expectedRevision: 1, idempotencyKey: null }))
    const response = await download({ userId: 'bert', groupId: g, url: uploaded.url })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png({ width: 40, height: 30, bytes: 64 }))
  })
})
