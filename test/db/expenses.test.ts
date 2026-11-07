// The expenses area against a real database: receipts on expenses, recurring
// series, balances with settlements, and the edit screen's detail read. Tests
// that only read their own expenses share one group; tests that read a whole
// group (balances, series, links) each build their own.
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, categories, expenses, receipts, recurringLinks } from '../../db/schema/app'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { GROUP_DENIED } from '~/shared/errors'
import { listBalances } from '~/server/balances'
import { makeDb, sqlState } from '~/server/core/db'
import type { Principal } from '~/server/core/access'
import { jsonError } from '~/server/core/errors'
import type { StoredDocument } from '~/server/expense-read'
import { locateExpense, getExpenseDetail, listCategories } from '~/server/expenses'
import { createExpense, deleteExpense, getGroup, listExpenses, updateExpense } from '~/server/ledger'
import { downloadReceipt, uploadReceipt } from '~/server/receipt-routes'
import { RECEIPT_REFUSED } from '~/server/receipts'
import { listRecurring, materializeDue, occurrenceId, processGroup } from '~/server/recurring'
import { BASE } from '../kit/config'
import { testDatabase, type TestDatabase } from '../kit/database'
import { draft } from '../kit/drafts'
import { counter, id21 } from '../kit/ids'
import { png } from '../kit/images'
import { principal } from '../kit/people'
import { seedHousehold } from '../kit/seed'
import { receiptUpload } from '../kit/upload'
import { fakeBucket } from './fake-bucket'

let database: TestDatabase
const tx: TestDatabase['tx'] = (work) => database.tx(work)
const alice = principal('u-alice', { name: 'Alice' })
const bob = principal('u-bob', { name: 'Bob' })
const mallory = principal('u-mallory', { name: 'Mallory' })
const key = counter('expenses-key')
const nextGroup = counter('xg')
const nextExpense = counter('x')

/** A receipt URL of the new form, unique to `name`. */
const receiptUrl = (name: string) => `r2://agentsplit-receipts/receipts/${id21(name, 1)}.jpg`

/**
 * A new group "Home": Alice (admin), Bob (member) and Cara (no account), with
 * `receipts` uploaded to it. Its draft is a Costco expense of 90.00 that Alice
 * pays, split evenly.
 */
async function household(data: { receipts?: readonly string[] } = {}) {
  const groupId = nextGroup()
  const slug = `${groupId}-home`
  const [pa, pb, pc] = [`${groupId}-pa`, `${groupId}-pb`, `${groupId}-pc`]
  await tx(async (db) => {
    await seedHousehold(db, { groupId, slug, name: 'Home', people: [{ id: pa, name: 'Alice', userId: alice.userId }, { id: pb, name: 'Bob', userId: bob.userId }, { id: pc, name: 'Cara' }] })
    const urls = data.receipts ?? []
    if (urls.length) await db.insert(receipts).values(urls.map((url, i) => ({ id: `${groupId}-r${i}`, groupId, url, createdBy: alice.userId })))
  })
  const expense = (over: Partial<ExpenseDraft> = {}) => draft({ payer: pa, people: [pa, pb, pc], vendor: 'Costco', categoryId: 9, amount: '90.00', ...over })
  const documents = (list: readonly StoredDocument[] | undefined) => (list ? { documents: list } : {})
  const create = (data: { expenseId: string; expense?: ExpenseDraft; documents?: readonly StoredDocument[]; by?: Principal }) =>
    tx((db) => createExpense(db, { principal: data.by ?? alice, groupId, expenseId: data.expenseId, idempotencyKey: key(), expense: data.expense ?? expense(), ...documents(data.documents) }))
  const update = (data: { expenseId: string; expectedRevision: number; expense: ExpenseDraft; documents?: readonly StoredDocument[]; by?: Principal }) =>
    tx((db) => updateExpense(db, { principal: data.by ?? alice, groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision, idempotencyKey: key(), expense: data.expense, ...documents(data.documents) }))
  const remove = (data: { expenseId: string; expectedRevision: number }) =>
    tx((db) => deleteExpense(db, { principal: alice, groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision, idempotencyKey: key() }))
  /** The group's expenses whose title or vendor matches `search`, newest first. */
  const search = async (search: string) => (await tx((db) => listExpenses(db, { principal: alice, groupId, filter: { search }, cursor: null, limit: 50 }))).expenses
  const balances = (currency?: 'JPY') => tx((db) => listBalances(db, { principal: alice, groupId, ...(currency ? { currency } : {}) }))
  /** The scheduled run for this group only. */
  const run = (today: string) => materializeDue(makeDb(database.pool), { today, groupId, onError: () => {} })
  return { groupId, slug, pa, pb, pc, expense, create, update, remove, search, balances, run }
}
type Household = Awaited<ReturnType<typeof household>>

const doc1 = { id: 'd1', url: receiptUrl('aaaa'), width: 10, height: 20 }
// A v1 receipt URL: https://<host>/<bucket>/<key> (receipts.ts reads both forms).
const doc2 = { id: 'd2', url: 'https://s3.example/bucket/receipts/bbbbbbbbbbbbbbbbbbbbb.png', width: 30, height: 40 }
const foreignUrl = receiptUrl('cccc')
let home: Household
let otherGroupId: string

beforeAll(async () => {
  database = await testDatabase()
  home = await household({ receipts: [doc1.url, doc2.url] })
  // Mallory's group, which Alice and Bob are not in.
  const groupId = nextGroup()
  otherGroupId = groupId
  await tx(async (db) => {
    await seedHousehold(db, { groupId, slug: `${groupId}-other`, name: 'Other', people: [{ id: `${groupId}-pm`, name: 'Mallory', userId: mallory.userId }] })
    await db.insert(receipts).values({ id: `${groupId}-r`, groupId, url: foreignUrl, createdBy: mallory.userId })
  })
})
afterAll(async () => {
  await database.close()
})

const snapshotOf = async (expenseId: string, revision: number) => {
  const all = await tx((db) => db.select().from(activities).where(eq(activities.expenseId, expenseId)))
  return all.find((a) => a.expenseRevision === revision)?.snapshot as { expense: { documents: { url: string }[] } } | undefined
}
const snapshotUrls = async (expenseId: string, revision: number) => (await snapshotOf(expenseId, revision))?.expense.documents.map((d) => d.url)

describe('expense writes', () => {
  it('lists every category in ID order', async () => {
    const table = await tx((db) => db.select().from(categories).orderBy(asc(categories.id)))
    expect(await tx((db) => listCategories(db))).toEqual(table)
  })

  it('records receipts in revision 1 and keeps them when an update omits them', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId, documents: [doc1] })
    expect(await snapshotUrls(expenseId, 1)).toEqual([doc1.url])
    const updated = await home.update({ expenseId, expectedRevision: 1, expense: home.expense({ title: 'Food' }) })
    expect(updated.documentCount).toBe(1)
  })

  it('removing a receipt keeps it in the earlier revision, readable by members', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId, documents: [doc1] })
    await home.update({ expenseId, expectedRevision: 1, expense: home.expense({ title: 'Food' }), documents: [doc2] })
    expect(await snapshotUrls(expenseId, 1)).toEqual([doc1.url])
    expect(await snapshotUrls(expenseId, 2)).toEqual([doc2.url])
    const detail = await tx((db) => getExpenseDetail(db, { principal: bob, groupId: home.groupId, expenseId }))
    expect(detail.documents.map((d) => d.downloadUrl)).toEqual([`/api/receipts?groupId=${home.groupId}&url=${encodeURIComponent(doc2.url)}`])
  })

  it('lists receipts in the order they were attached, as the current app does', async () => {
    const expenseId = nextExpense()
    const docs = [5, 1, 4, 2, 3].map((n) => ({ id: `o${n}`, url: receiptUrl(`${expenseId}o${n}`), width: n, height: n }))
    await tx((db) => db.insert(receipts).values(docs.map((d) => ({ id: `r-${expenseId}-${d.id}`, groupId: home.groupId, url: d.url, createdBy: alice.userId }))))
    const [first, ...others] = docs
    if (!first) throw new Error('missing receipt')
    await home.create({ expenseId, documents: others })
    const urls = async () => (await tx((db) => getExpenseDetail(db, { principal: alice, groupId: home.groupId, expenseId }))).documents.map((d) => d.url)
    expect(await urls()).toEqual(others.map((d) => d.url))
    // A receipt attached later comes last, and the revision keeps the same order.
    const saved = await tx((db) => getExpenseDetail(db, { principal: alice, groupId: home.groupId, expenseId }))
    const kept = saved.documents.map((d) => ({ id: d.id, url: d.url, width: d.width, height: d.height }))
    await home.update({ expenseId, expectedRevision: 1, expense: home.expense(), documents: [...kept, first] })
    expect(await urls()).toEqual([...others, first].map((d) => d.url))
    expect(await snapshotUrls(expenseId, 2)).toEqual(await urls())
  })

  it('refuses a receipt that was not uploaded to the group', async () => {
    const foreign = { id: 'd3', url: foreignUrl, width: 1, height: 1 }
    await expect(home.create({ expenseId: nextExpense(), documents: [foreign] })).rejects.toMatchObject({
      _tag: 'Invalid',
      field: 'documents',
      message: 'Attach only receipts uploaded to this group',
    })
  })

  it('refuses a reused expense ID with Conflict and an unknown category with Invalid', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId })
    await expect(home.create({ expenseId })).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 1 })
    await expect(home.create({ expenseId: nextExpense(), expense: home.expense({ categoryId: 99 }) })).rejects.toMatchObject({ _tag: 'Invalid', field: 'categoryId' })
  })

  it('adds no revision for an edit that changes nothing', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId, expense: home.expense({ title: 'Food' }), documents: [doc2] })
    const same = await home.update({ expenseId, expectedRevision: 1, expense: home.expense({ title: 'Food' }), documents: [doc2] })
    expect(same.revision).toBe(1)
  })

  it('drops a legacy conversion when the amount changes, and keeps it otherwise', async () => {
    // The app never writes a conversion; only rows from the old data carry one. Insert one at revision 0, as that data has it.
    const expenseId = nextExpense()
    const { groupId, pa, pb, pc } = home
    await tx(async (db) => {
      await db.execute(sql`INSERT INTO expenses (id, group_id, revision, kind, title, notes, category_id, expense_date, currency, amount, split_mode, original_amount, original_currency, conversion_rate)
        VALUES (${expenseId}, ${groupId}, 0, 'expense', 'Groceries', '', 9, '2026-11-01', 'USD', 9000, 'evenly', 12000, 'CAD', '0.75')`)
      await db.execute(sql`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount) VALUES (${expenseId}, ${groupId}, ${pa}, 9000)`)
      await db.execute(
        sql`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount) VALUES (${expenseId}, ${groupId}, ${pa}, 3000), (${expenseId}, ${groupId}, ${pb}, 3000), (${expenseId}, ${groupId}, ${pc}, 3000)`,
      )
    })
    const conversion = async () => (await tx((db) => db.select({ c: expenses.originalCurrency }).from(expenses).where(eq(expenses.id, expenseId))))[0]?.c
    await home.update({ expenseId, expectedRevision: 0, expense: home.expense({ title: 'Renamed', vendor: null }) })
    expect(await conversion()).toBe('CAD')
    await home.update({ expenseId, expectedRevision: 1, expense: home.expense({ title: 'Renamed', vendor: null, amount: '60.00' }) })
    expect(await conversion()).toBeNull()
  })

  it('names who added and who last edited an expense', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId })
    await home.update({ expenseId, expectedRevision: 1, expense: home.expense({ title: 'Food and drink' }), by: bob })
    const detail = await tx((db) => getExpenseDetail(db, { principal: alice, groupId: home.groupId, expenseId }))
    expect(detail.added?.by).toBe('Alice')
    expect(detail.edited?.by).toBe('Bob')
    // Alice only added it, so her last change is the addition.
    expect(detail.myLastEdit).toBe(detail.added?.at)
    const page = await tx((db) => listExpenses(db, { principal: alice, groupId: home.groupId, filter: {}, cursor: null, limit: 50 }))
    expect(page.expenses.find((e) => e.id === expenseId)).toMatchObject({ addedBy: 'Alice', editedBy: 'Bob' })
  })

  it('finds an expense from any accessible group, and nothing for others', async () => {
    const expenseId = nextExpense()
    await home.create({ expenseId })
    expect(await tx((db) => locateExpense(db, { principal: bob, expenseId }))).toMatchObject({ groupId: home.groupId, slug: home.slug, kind: 'expense' })
    await expect(tx((db) => locateExpense(db, { principal: mallory, expenseId }))).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(tx((db) => getExpenseDetail(db, { principal: mallory, groupId: home.groupId, expenseId }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })
})

describe('payments and balances', () => {
  it('suggests settlements per currency, lists every participant, and settles to zero', async () => {
    const h = await household()
    await h.create({ expenseId: nextExpense() })
    const usd = (await h.balances()).currencies.find((c) => c.currency === 'USD')
    expect(usd?.balances.map((b) => b.participantId).sort()).toEqual([h.pa, h.pb, h.pc])
    expect(usd?.settlements).toEqual([
      { from: h.pc, to: h.pa, amount: '30.00' },
      { from: h.pb, to: h.pa, amount: '30.00' },
    ])
    for (const s of usd?.settlements ?? [])
      await h.create({
        expenseId: nextExpense(),
        expense: h.expense({ kind: 'payment', title: 'Payment', vendor: null, categoryId: 1, amount: s.amount, payers: [{ participantId: s.from, amount: s.amount }], shares: [{ participantId: s.to, weight: '1' }] }),
      })
    const after = (await h.balances()).currencies.find((c) => c.currency === 'USD')
    expect(after?.balances.map((b) => b.net)).toEqual(['0.00', '0.00', '0.00'])
    expect(after?.settlements).toEqual([])
  })

  it('keeps currencies apart and filters by currency', async () => {
    const h = await household()
    await h.create({ expenseId: nextExpense() })
    await h.create({ expenseId: nextExpense(), expense: h.expense({ currency: 'JPY', amount: '6000', payers: [{ participantId: h.pb, amount: '6000' }] }) })
    expect((await h.balances()).currencies.map((c) => c.currency)).toEqual(['JPY', 'USD'])
    const jpy = await h.balances('JPY')
    expect(jpy.currencies).toHaveLength(1)
    expect(jpy.currencies[0]?.settlements).toEqual([
      { from: h.pc, to: h.pb, amount: '2000' },
      { from: h.pa, to: h.pb, amount: '2000' },
    ])
    await expect(tx((db) => listBalances(db, { principal: mallory, groupId: h.groupId }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('accepts a payment shared by several people, and a negative one (P-BAL-93)', async () => {
    const h = await household()
    const refund = await h.create({ expenseId: nextExpense(), expense: h.expense({ kind: 'payment', title: 'Refund', amount: '-30.00' }) })
    expect(refund.shares.map((s) => s.amount)).toEqual(['-10.00', '-10.00', '-10.00'])
  })
})

describe('recurring expenses', () => {
  it('creates every missed month on the anchor day, once, with copies of the receipts', async () => {
    const h = await household({ receipts: [doc1.url] })
    await h.create({ expenseId: nextExpense(), expense: h.expense({ title: 'Rent', expenseDate: '2026-01-31', recurrence: 'monthly' }), documents: [doc1] })
    // Reads never create occurrences.
    await h.search('Rent')
    await tx((db) => getGroup(db, { principal: alice, groupId: h.groupId }))
    expect(await h.search('Rent')).toHaveLength(1)

    expect(await h.run('2026-04-05')).toHaveLength(2)
    const rents = await h.search('Rent')
    expect(rents.map((e) => e.expenseDate)).toEqual(['2026-03-31', '2026-02-28', '2026-01-31'])
    expect(rents.every((e) => e.documentCount === 1 && e.vendor === 'Costco')).toBe(true)
    expect(rents[0]?.addedBy).toBe('Automatic recurrence')
    // A rerun on the same day creates nothing.
    expect(await h.run('2026-04-05')).toEqual([])
    const [series] = await tx((db) => listRecurring(db, { principal: alice, groupId: h.groupId }))
    expect(series).toMatchObject({ expense: { expenseDate: '2026-03-31' }, nextDate: '2026-04-30' })
  })

  it('never duplicates when two runs race', async () => {
    const h = await household()
    await h.create({ expenseId: nextExpense(), expense: h.expense({ title: 'Coffee', expenseDate: '2026-03-01', recurrence: 'daily' }) })
    const errors: unknown[] = []
    const race = () => materializeDue(makeDb(database.pool), { today: '2026-03-06', groupId: h.groupId, onError: (error) => errors.push(error) })
    const results = await Promise.allSettled([race(), race(), race()])
    const coffee = await h.search('Coffee')
    expect(coffee.map((e) => e.expenseDate)).toEqual(['2026-03-06', '2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01'])
    // Each occurrence comes from one run. A run that loses a race may fail, but only on a write conflict, never on a duplicate occurrence.
    const created = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    expect(new Set(created).size).toBe(created.length)
    expect(created.every((id) => coffee.some((e) => e.id === id))).toBe(true)
    const failures = [...errors, ...results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))]
    expect(failures.map(sqlState).filter((code) => code !== '40001' && code !== '40P01')).toEqual([])
  })

  it('stops a series when its newest expense is set to none or deleted', async () => {
    const h = await household()
    await h.create({ expenseId: nextExpense(), expense: h.expense({ title: 'Coffee', expenseDate: '2026-03-01', recurrence: 'daily' }) })
    expect(await h.run('2026-03-06')).toHaveLength(5)
    const [newest] = await h.search('Coffee')
    if (!newest) throw new Error('missing occurrence')
    await h.update({ expenseId: newest.id, expectedRevision: 1, expense: h.expense({ title: 'Coffee', expenseDate: newest.expenseDate, recurrence: 'none' }) })
    expect(await h.run('2026-03-20')).toEqual([])
    const rent = nextExpense()
    await h.create({ expenseId: rent, expense: h.expense({ title: 'Rent', expenseDate: '2026-01-31', recurrence: 'monthly' }) })
    expect((await tx((db) => listRecurring(db, { principal: alice, groupId: h.groupId }))).map((r) => r.expense.id)).toEqual([rent])
    await h.remove({ expenseId: rent, expectedRevision: 1 })
    expect(await tx((db) => listRecurring(db, { principal: alice, groupId: h.groupId }))).toEqual([])
    expect(await h.run('2026-12-31')).toEqual([])
  })

  it('counts an edited rule or date from the saved date, and never restarts an older occurrence', async () => {
    const h = await household()
    const gym = nextExpense()
    await h.create({ expenseId: gym, expense: h.expense({ title: 'Gym', expenseDate: '2026-05-10', recurrence: 'monthly' }) })
    await h.update({ expenseId: gym, expectedRevision: 1, expense: h.expense({ title: 'Gym', expenseDate: '2026-05-12', recurrence: 'weekly' }) })
    const [link] = await tx((db) => db.select().from(recurringLinks).where(eq(recurringLinks.currentFrameExpenseId, gym)))
    expect(link).toMatchObject({ nextExpenseDate: '2026-05-19', anchorDay: 12 })
    expect(await h.run('2026-05-19')).toHaveLength(1)
    // The older occurrence's link is closed: changing its rule does not open a new one.
    await h.update({ expenseId: gym, expectedRevision: 2, expense: h.expense({ title: 'Gym', expenseDate: '2026-05-12', recurrence: 'daily' }) })
    const links = await tx((db) => db.select().from(recurringLinks).where(eq(recurringLinks.groupId, h.groupId)))
    expect(links.filter((l) => l.currentFrameExpenseId === gym)).toHaveLength(1)
    expect(links.filter((l) => !l.nextExpenseCreatedAt).map((l) => l.nextExpenseDate)).toEqual(['2026-05-26'])
  })

  it('lets a member process one group only, and records them', async () => {
    const h = await household()
    const gym = nextExpense()
    await h.create({ expenseId: gym, expense: h.expense({ title: 'Gym', expenseDate: '2026-05-19', recurrence: 'weekly' }) })
    await expect(tx((db) => processGroup(db, { principal: mallory, groupId: h.groupId, today: '2026-06-30' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    const { createdExpenseIds } = await tx((db) => processGroup(db, { principal: bob, groupId: h.slug, today: '2026-05-26' }))
    expect(createdExpenseIds).toHaveLength(1)
    const [row] = await tx((db) => db.select().from(activities).where(eq(activities.expenseId, createdExpenseIds[0] ?? '')))
    expect(row).toMatchObject({ actorName: 'Bob', source: 'web' })
    const [frame] = await tx((db) => db.select({ deleted: expenses.deletedAt }).from(expenses).where(eq(expenses.id, gym)))
    expect(frame?.deleted).toBeNull()
  })

  it('skips a link that always fails in the scheduled run, and creates the other links (P-RECUR-24)', async () => {
    const h = await household()
    const solo = (over: Partial<ExpenseDraft>) => h.expense({ shares: [{ participantId: h.pa, weight: '1' }], recurrence: 'daily', ...over })
    const [broken, fine] = [nextExpense(), nextExpense()]
    await h.create({ expenseId: broken, expense: solo({ title: 'Broken', expenseDate: '2026-07-30' }) })
    await h.create({ expenseId: fine, expense: solo({ title: 'Fine', expenseDate: '2026-07-31' }) })
    // The broken link is due first, and the ID of its next occurrence is taken, so its insert always fails.
    const [link] = await tx((db) => db.select().from(recurringLinks).where(eq(recurringLinks.currentFrameExpenseId, broken)))
    if (!link) throw new Error('missing link')
    await h.create({ expenseId: await occurrenceId(link.id), expense: solo({ title: 'Taken', recurrence: 'none' }) })
    const failed: string[] = []
    const created = await materializeDue(makeDb(database.pool), { today: '2026-08-01', groupId: h.groupId, onError: (_error, linkId) => failed.push(linkId) })
    expect(failed).toEqual([link.id])
    const fines = await h.search('Fine')
    expect(fines.map((e) => e.expenseDate)).toEqual(['2026-08-01', '2026-07-31'])
    expect(created).toEqual([fines[0]?.id])
    // An explicit request still fails on the broken link: its occurrence ID is a duplicate key.
    await expect(tx((db) => processGroup(db, { principal: alice, groupId: h.groupId, today: '2026-08-01' })).catch(sqlState)).resolves.toBe('23505')
  })
})

describe('receipt endpoints', () => {
  /** The caller as app.ts reads it (httpReader); without a principal, its 401. */
  const as = (principal: Principal | null) => (principal ? { principal } : { response: jsonError({ status: 401, message: 'Authentication required' }) })
  const get = (params: Record<string, string>) => new URL(`${BASE}/api/receipts?${new URLSearchParams(params)}`)

  it('checks the reference, the session and the membership before reading storage', async () => {
    const { bucket, calls } = fakeBucket()
    await database.withDb(async (db) => {
      const download = (reader: Principal | null, params: Record<string, string>) => downloadReceipt({ db, bucket, reader: as(reader), url: get(params) })
      expect((await download(alice, { groupId: home.groupId })).status).toBe(400)
      expect((await download(null, { groupId: home.groupId, url: doc1.url })).status).toBe(401)
      const denied = await download(mallory, { groupId: home.groupId, url: doc1.url })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('cache-control')).toBe('no-store')
      expect(await denied.json()).toEqual({ error: GROUP_DENIED })
      // PostgreSQL text cannot hold a NUL byte: such a reference is denied or not found, never a database error.
      expect((await download(alice, { groupId: `${home.groupId}\0`, url: doc1.url })).status).toBe(403)
      expect((await download(alice, { groupId: home.groupId, url: `${doc1.url}\0` })).status).toBe(404)
      // Another group's receipt is not found through this group.
      expect((await download(alice, { groupId: home.groupId, url: foreignUrl })).status).toBe(404)
      expect(calls).toEqual([])
      // Registered, but missing in storage.
      expect((await download(alice, { groupId: home.slug, url: doc1.url })).status).toBe(404)
    })
  })

  it('uploads to the bucket for a member, and serves the image with safe headers', async () => {
    const { bucket, objects } = fakeBucket()
    await database.withDb(async (db) => {
      const upload = async (data: { groupId: string; file: Uint8Array<ArrayBuffer>; length?: number; by?: Principal | null }) => {
        const { by, ...request } = data
        return uploadReceipt({ db, bucket, principal: by === undefined ? alice : by, request: await receiptUpload({ baseUrl: BASE, type: 'image/jpeg', ...request }) })
      }
      const tiny = png({ width: 1, height: 1 })
      expect((await upload({ groupId: home.groupId, file: tiny, by: null })).status).toBe(401)
      expect((await upload({ groupId: home.groupId, file: tiny, length: 6 * 1024 * 1024 })).status).toBe(413)
      expect((await upload({ groupId: otherGroupId, file: tiny })).status).toBe(403)
      const bad = await upload({ groupId: home.groupId, file: new TextEncoder().encode('not an image at all, really') })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: RECEIPT_REFUSED })
      expect((await upload({ groupId: home.groupId, file: png({ width: 8000, height: 6000 }) })).status).toBe(400)
      expect(objects.size).toBe(0)

      const ok = await upload({ groupId: home.slug, file: png({ width: 64, height: 48 }) })
      expect(ok.status).toBe(200)
      const stored = (await ok.json()) as { id: string; url: string; width: number; height: number }
      expect(stored).toMatchObject({ width: 64, height: 48 })
      expect(stored.url).toMatch(/^r2:\/\/agentsplit-receipts\/receipts\/[A-Za-z0-9_-]{21}\.png$/)
      // The detected type wins over the declared image/jpeg.
      expect([...objects.values()].map((o) => o.contentType)).toEqual(['image/png'])

      const image = await downloadReceipt({ db, bucket, reader: as(bob), url: get({ groupId: home.groupId, url: stored.url }) })
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
  })

  it('serves a receipt that only a deleted expense refers to', async () => {
    const h = await household({ receipts: [receiptUrl('deleted')] })
    const doc = { id: 'd-deleted', url: receiptUrl('deleted'), width: 1, height: 1 }
    const expenseId = nextExpense()
    await h.create({ expenseId, documents: [doc] })
    await h.remove({ expenseId, expectedRevision: 1 })
    const { bucket, objects } = fakeBucket()
    objects.set(`receipts/${id21('deleted', 1)}.jpg`, { bytes: new Uint8Array([1]), contentType: 'image/jpeg' })
    const response = await database.withDb((db) => downloadReceipt({ db, bucket, reader: as(bob), url: get({ groupId: h.groupId, url: doc.url }) }))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1]))
  })
})
