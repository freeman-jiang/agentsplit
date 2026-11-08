// The dashboard feed: filters, attribution, current names, cursor shape and the
// account balance's per-row output. Privacy and pagination across contexts are
// in ungrouped.test.ts. The read tests share one flat; each test that writes
// builds its own flat with its own accounts, so the shared feed never changes.
import { Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { accountBalances } from '~/server/balances'
import type { Principal } from '~/server/core/access'
import { makeDb } from '~/server/core/db'
import { listCategories } from '~/server/expenses'
import { expenseContext, feedOptions, listFeed, type FeedFilter } from '~/server/feed'
import { createExpense, updateExpense } from '~/server/ledger'
import { AccountBalances, ExpenseContext, FeedOptions, FeedPage } from '~/shared/api'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { CATEGORY } from '~/shared/vocabulary'
import { testDatabase, type TestDatabase } from '../kit/database'
import { draft } from '../kit/drafts'
import { counter } from '../kit/ids'
import { principal, userRows } from '../kit/people'
import { scheduledRun } from '../kit/recurring'
import { seedHousehold } from '../kit/seed'

let database: TestDatabase
const tx: TestDatabase['tx'] = (work) => database.tx(work)
const key = counter('feed-key')

/**
 * The group "Flat": Alice (admin, on the web), Bob (member, through an agent)
 * and Cara (no account). Alice's participant keeps an old name, so a view
 * that shows "Alice" reads the account's current name.
 */
async function flat(groupId: string) {
  const alice = principal(`u-${groupId}-alice`, { name: 'Alice' })
  const bob = principal(`u-${groupId}-bob`, { name: 'Bob', source: 'agent', agentKeyId: `key-${groupId}` })
  const [pa, pb, pc] = [`${groupId}-pa`, `${groupId}-pb`, `${groupId}-pc`]
  const slug = `flat-${groupId}`
  await tx(async (db) => {
    await db.insert(user).values(userRows([alice, bob], { verified: true }))
    await seedHousehold(db, {
      groupId,
      slug,
      name: 'Flat',
      people: [{ id: pa, name: 'Alice (old name)', userId: alice.userId }, { id: pb, name: 'Bob', userId: bob.userId }, { id: pc, name: 'Cara' }],
    })
  })
  const expense = (over: Partial<ExpenseDraft>) => draft({ payer: pa, people: [pa, pb, pc], expenseDate: '2026-10-01', amount: '30', ...over })
  const create = (p: Principal, id: string, over: Partial<ExpenseDraft>) =>
    tx((db) => createExpense(db, { principal: p, groupId, expenseId: id, idempotencyKey: key(), expense: expense(over) }))
  return { groupId, slug, alice, bob, pa, pb, pc, expense, create }
}
type Flat = Awaited<ReturnType<typeof flat>>

/** The shared feed's five expenses, with IDs `<prefix>groceries` and so on. */
async function fill(h: Flat, prefix: string) {
  await h.create(h.alice, `${prefix}groceries`, { vendor: 'Costco', notes: 'contains rent' })
  await h.create(h.bob, `${prefix}rent`, { title: 'Rent 100%', categoryId: 18, expenseDate: '2026-10-02', payers: [{ participantId: h.pb, amount: '30' }] })
  await h.create(h.bob, `${prefix}cara`, { title: 'Cara only', payers: [{ participantId: h.pc, amount: '30' }], shares: [{ participantId: h.pc, weight: '1' }] })
  await h.create(h.alice, `${prefix}pay`, { kind: 'payment', title: 'Payback', categoryId: CATEGORY.payment, payers: [{ participantId: h.pb, amount: '30' }], shares: [{ participantId: h.pa, weight: '1' }] })
  await h.create(h.alice, `${prefix}eur`, { currency: 'EUR', title: 'Euro snacks', expenseDate: '2026-09-01' })
}

let home: Flat
const feed = (p: Principal, data: { filter?: FeedFilter; limit?: number } = {}) =>
  tx((db) => listFeed(db, { principal: p, filter: { involvingMe: false, ...data.filter }, cursor: null, limit: data.limit ?? 100 }))
const ids = async (filter: FeedFilter, p: Principal = home.alice) => (await feed(p, { filter })).expenses.map((e) => e.id)

beforeAll(async () => {
  database = await testDatabase()
  home = await flat('g1')
  await fill(home, 'e-')
})
afterAll(async () => {
  await database.close()
})

describe('feed', () => {
  it('filters by search on title or vendor, with LIKE characters taken literally', async () => {
    expect(await ids({ search: 'costco' })).toEqual(['e-groceries'])
    expect(await ids({ search: '100%' })).toEqual(['e-rent'])
    expect(await ids({ search: '%' })).toEqual(['e-rent'])
    // Notes are not searched.
    expect(await ids({ search: 'contains rent' })).toEqual([])
  })

  it('filters by type, category and currency', async () => {
    expect(await ids({ kind: 'payment' })).toEqual(['e-pay'])
    expect((await ids({ kind: 'expense' })).sort()).toEqual(['e-cara', 'e-eur', 'e-groceries', 'e-rent'])
    expect(await ids({ categoryId: 18 })).toEqual(['e-rent'])
    expect(await ids({ currency: 'EUR' })).toEqual(['e-eur'])
  })

  it('person matches payer or beneficiary, payer matches payers only, and involving me uses the bound participant', async () => {
    expect((await ids({ personUserId: home.bob.userId })).sort()).toEqual(['e-eur', 'e-groceries', 'e-pay', 'e-rent'])
    expect((await ids({ payerUserId: home.bob.userId })).sort()).toEqual(['e-pay', 'e-rent'])
    expect(await ids({ payerUserId: 'u-nobody' })).toEqual([])
    expect((await ids({ involvingMe: true })).sort()).toEqual(['e-eur', 'e-groceries', 'e-pay', 'e-rent'])
  })

  it('orders by expense date, then creation time, then ID, newest first', async () => {
    expect(await ids({})).toEqual(['e-rent', 'e-pay', 'e-cara', 'e-groceries', 'e-eur'])
  })

  it('returns a cursor with the exact creation time, and pages without gaps', async () => {
    const first = await feed(home.alice, { limit: 2 })
    expect(first.nextCursor).toMatchObject({ date: '2026-10-01', id: 'e-pay' })
    expect(first.nextCursor?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    const rest = await tx((db) => listFeed(db, { principal: home.alice, filter: { involvingMe: false }, cursor: first.nextCursor, limit: 100 }))
    expect([...first.expenses, ...rest.expenses].map((e) => e.id)).toEqual(['e-rent', 'e-pay', 'e-cara', 'e-groceries', 'e-eur'])
    expect(rest.nextCursor).toBeNull()
    // The output encodes with the contract's schema, as the RPC server does.
    expect(() => Schema.encodeSync(FeedPage)(first)).not.toThrow()
  })

  it('shows current account names and the viewer participant', async () => {
    const h = await flat('names')
    await h.create(h.alice, 'names-groceries', { vendor: 'Costco' })
    await tx((db) => db.update(user).set({ name: 'Alice Renamed' }).where(eq(user.id, h.alice.userId)))
    const [row] = (await feed(h.bob, { filter: { search: 'costco' }, limit: 10 })).expenses
    expect(row?.people).toEqual([
      { id: h.pa, name: 'Alice Renamed' },
      { id: h.pb, name: 'Bob' },
      { id: h.pc, name: 'Cara' },
    ])
    expect(row?.participantId).toBe(h.pb)
    expect(row?.group).toEqual({ id: h.groupId, name: 'Flat', slug: h.slug })
    expect(row?.contextExpenseId).toBeNull()
  })

  it('attributes from create and update events, never the payer, and ignores baselines', async () => {
    const h = await flat('attr')
    const one = async (id: string, p: Principal = h.alice) => (await feed(p)).expenses.find((e) => e.id === id)
    // Bob creates it, and Alice pays.
    await h.create(h.bob, 'attr-rent', { title: 'Rent', categoryId: 18 })
    await h.create(h.alice, 'attr-cara', { title: 'Cara only', payers: [{ participantId: h.pc, amount: '30' }], shares: [{ participantId: h.pc, weight: '1' }] })
    const rent = await one('attr-rent')
    expect(rent?.attribution.createdBy).toEqual({ userId: h.bob.userId, name: 'Bob', source: 'agent' })
    expect(rent?.attribution.updatedBy).toBeNull()
    await tx((db) => updateExpense(db, { principal: h.alice, groupId: h.groupId, expenseId: 'attr-rent', expectedRevision: 1, idempotencyKey: key(), expense: h.expense({ title: 'Rent', categoryId: 18, amount: '40' }) }))
    const edited = await one('attr-rent')
    expect(edited?.attribution.updatedBy).toEqual({ userId: h.alice.userId, name: 'Alice', source: 'web' })
    expect(edited?.attribution.lastEditedByYouAt).toBe(edited?.attribution.updatedAt)
    expect((await one('attr-rent', h.bob))?.attribution.lastEditedByYouAt).toBeNull()
    // A recurring copy is named "Automatic recurrence".
    await h.create(h.alice, 'attr-daily', { title: 'Daily coffee', recurrence: 'daily' })
    const [copy] = await scheduledRun(makeDb(database.pool), { today: '2026-10-02', groupId: h.groupId })
    expect((await one(copy ?? ''))?.attribution.createdBy).toEqual({ userId: null, name: 'Automatic recurrence', source: 'system' })
    // A legacy expense with only a baseline has no author; only v1's import wrote baselines, so the row is written here.
    await tx((db) =>
      db.insert(activities).values({ id: 'attr-act-baseline', groupId: h.groupId, type: 'update_expense', expenseId: 'attr-cara', expenseRevision: 0, snapshot: {}, actorUserId: h.alice.userId, actorName: 'Alice' }),
    )
    expect((await one('attr-cara'))?.attribution.updatedBy).toBeNull()
  })

  it('returns options and the expense page in the contract shape', async () => {
    const options = await tx((db) => feedOptions(db, { principal: home.alice }))
    expect(options.categories).toEqual(await tx((db) => listCategories(db)))
    expect(() => Schema.encodeSync(FeedOptions)(options)).not.toThrow()
    const page = await tx((db) => expenseContext(db, { principal: home.bob, expenseId: 'e-groceries' }))
    expect(page).toMatchObject({ group: { id: home.groupId, kind: 'named' }, role: 'member', participantId: home.pb, context: null })
    expect(page.participants.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Cara'])
    expect(() => Schema.encodeSync(ExpenseContext)(page)).not.toThrow()
  })

  it('reports per-group rows with signs, and no rows for currencies the user does not share', async () => {
    const h = await flat('sums')
    await fill(h, 'sums-')
    await h.create(h.bob, 'sums-gbp', { currency: 'GBP', title: 'Bob and Cara', payers: [{ participantId: h.pb, amount: '30' }], shares: [{ participantId: h.pb, weight: '1' }, { participantId: h.pc, weight: '1' }] })
    const summary = await tx((db) => accountBalances(db, { principal: h.alice }))
    // USD: groceries +20, Bob's rent -10, Bob's payment to Alice -30. EUR: +20. Alice has no part in the GBP expense.
    expect(summary.balances).toEqual([
      { groupId: h.groupId, groupName: 'Flat', kind: 'named', currency: 'EUR', participantId: h.pa, participantName: 'Alice', amount: '20.00' },
      { groupId: h.groupId, groupName: 'Flat', kind: 'named', currency: 'USD', participantId: h.pa, participantName: 'Alice', amount: '-20.00' },
    ])
    expect(() => Schema.encodeSync(AccountBalances)(summary)).not.toThrow()
  })
})
