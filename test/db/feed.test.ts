// The dashboard feed: filters, attribution, current names, cursor shape and the
// account balance's per-row output. Privacy and pagination across contexts are
// in ungrouped.test.ts.
import { Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { accountBalances } from '~/server/balances'
import type { Db } from '~/server/core/db'
import { expenseContext, feedOptions, listFeed, type FeedFilter } from '~/server/feed'
import { createExpense, updateExpense } from '~/server/ledger'
import { type Principal } from '~/server/core/access'
import { AccountBalances, ExpenseContext, FeedOptions, FeedPage } from '~/shared/api'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { testDatabase, type TestDatabase } from '../kit/database'

let database: TestDatabase
const tx = <A>(work: (db: Db) => Promise<A>) => database.tx(work)

const alice: Principal = { userId: 'u-alice', name: 'Alice', email: 'alice@example.com', source: 'web', agentKeyId: null }
const bob: Principal = { userId: 'u-bob', name: 'Bob', email: 'bob@example.com', source: 'agent', agentKeyId: 'key-1' }
let keys = 0
const key = () => `feed-key-${++keys}`.padEnd(12, '0')
const draft = (over: Partial<ExpenseDraft>): ExpenseDraft => ({
  kind: 'expense',
  title: 'Groceries',
  vendor: null,
  notes: '',
  categoryId: 0,
  expenseDate: '2026-10-01',
  currency: 'USD',
  amount: '30',
  payers: [{ participantId: 'pa', amount: '30' }],
  splitMode: 'evenly',
  shares: [{ participantId: 'pa', weight: '1' }, { participantId: 'pb', weight: '1' }, { participantId: 'pc', weight: '1' }],
  recurrence: 'none',
  ...over,
})
const create = (p: Principal, id: string, over: Partial<ExpenseDraft>) =>
  tx((db) => createExpense(db, { principal: p, groupId: 'g1', expenseId: id, idempotencyKey: key(), expense: draft(over) }))
const ids = async (filter: FeedFilter, p: Principal = alice) =>
  (await tx((db) => listFeed(db, { principal: p, filter: { involvingMe: false, ...filter }, cursor: null, limit: 100 }))).expenses.map((e) => e.id)

beforeAll(async () => {
  database = await testDatabase()
  await tx(async (db) => {
    const now = new Date()
    await db.insert(user).values([
      { id: alice.userId, name: 'Alice', email: alice.email, emailVerified: true, createdAt: now, updatedAt: now },
      { id: bob.userId, name: 'Bob', email: bob.email, emailVerified: true, createdAt: now, updatedAt: now },
    ])
    await db.insert(groups).values({ id: 'g1', kind: 'named', slug: 'flat', name: 'Flat', defaultCurrency: 'USD' })
    await db.insert(participants).values([
      { id: 'pa', groupId: 'g1', name: 'Alice (old name)' },
      { id: 'pb', groupId: 'g1', name: 'Bob' },
      { id: 'pc', groupId: 'g1', name: 'Cara' },
    ])
    await db.insert(memberships).values([
      { userId: alice.userId, groupId: 'g1', role: 'admin', participantId: 'pa' },
      { userId: bob.userId, groupId: 'g1', participantId: 'pb' },
    ])
  })
  await create(alice, 'e-groceries', { vendor: 'Costco', notes: 'contains rent' })
  await create(bob, 'e-rent', { title: 'Rent 100%', categoryId: 18, expenseDate: '2026-10-02', payers: [{ participantId: 'pb', amount: '30' }] })
  await create(bob, 'e-cara', { title: 'Cara only', payers: [{ participantId: 'pc', amount: '30' }], shares: [{ participantId: 'pc', weight: '1' }] })
  await create(alice, 'e-pay', { kind: 'payment', title: 'Payback', categoryId: 1, payers: [{ participantId: 'pb', amount: '30' }], shares: [{ participantId: 'pa', weight: '1' }] })
  await create(alice, 'e-eur', { currency: 'EUR', title: 'Euro snacks', expenseDate: '2026-09-01' })
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
    expect((await ids({ personUserId: bob.userId })).sort()).toEqual(['e-eur', 'e-groceries', 'e-pay', 'e-rent'])
    expect((await ids({ payerUserId: bob.userId })).sort()).toEqual(['e-pay', 'e-rent'])
    expect(await ids({ payerUserId: 'u-nobody' })).toEqual([])
    expect((await ids({ involvingMe: true })).sort()).toEqual(['e-eur', 'e-groceries', 'e-pay', 'e-rent'])
  })

  it('orders by expense date, then creation time, then ID, newest first', async () => {
    expect(await ids({})).toEqual(['e-rent', 'e-pay', 'e-cara', 'e-groceries', 'e-eur'])
  })

  it('returns a cursor with the exact creation time, and pages without gaps', async () => {
    const first = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: null, limit: 2 }))
    expect(first.nextCursor).toMatchObject({ date: '2026-10-01', id: 'e-pay' })
    expect(first.nextCursor?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    const rest = await tx((db) => listFeed(db, { principal: alice, filter: { involvingMe: false }, cursor: first.nextCursor, limit: 100 }))
    expect([...first.expenses, ...rest.expenses].map((e) => e.id)).toEqual(['e-rent', 'e-pay', 'e-cara', 'e-groceries', 'e-eur'])
    expect(rest.nextCursor).toBeNull()
    // The output encodes with the contract's schema, as the RPC server does.
    expect(() => Schema.encodeSync(FeedPage)(first)).not.toThrow()
  })

  it('shows current account names and the viewer participant', async () => {
    await tx((db) => db.update(user).set({ name: 'Alice Renamed' }).where(eq(user.id, alice.userId)))
    const [row] = (await tx((db) => listFeed(db, { principal: bob, filter: { search: 'costco' }, cursor: null, limit: 10 }))).expenses
    expect(row?.people).toEqual([
      { id: 'pa', name: 'Alice Renamed' },
      { id: 'pb', name: 'Bob' },
      { id: 'pc', name: 'Cara' },
    ])
    expect(row?.participantId).toBe('pb')
    expect(row?.group).toEqual({ id: 'g1', name: 'Flat', slug: 'flat' })
    expect(row?.contextExpenseId).toBeNull()
  })

  it('attributes from create and update events, never the payer, and ignores baselines', async () => {
    const one = async (id: string, p: Principal = alice) =>
      (await tx((db) => listFeed(db, { principal: p, filter: { involvingMe: false }, cursor: null, limit: 100 }))).expenses.find((e) => e.id === id)
    // Bob created it; Alice is the payer.
    const rent = await one('e-rent')
    expect(rent?.attribution.createdBy).toEqual({ userId: bob.userId, name: 'Bob', source: 'agent' })
    expect(rent?.attribution.updatedBy).toBeNull()
    await tx((db) => updateExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e-rent', expectedRevision: 1, idempotencyKey: key(), expense: draft({ title: 'Rent', categoryId: 18, expenseDate: '2026-10-02', payers: [{ participantId: 'pb', amount: '30' }] }) }))
    const edited = await one('e-rent')
    expect(edited?.attribution.updatedBy).toEqual({ userId: alice.userId, name: 'Alice Renamed', source: 'web' })
    expect(edited?.attribution.lastEditedByYouAt).toBe(edited?.attribution.updatedAt)
    expect((await one('e-rent', bob))?.attribution.lastEditedByYouAt).toBeNull()
    // A recurring copy is named "Automatic recurrence"; a legacy expense with only a baseline has no author.
    await tx((db) =>
      db.insert(activities).values({ id: 'act-system', groupId: 'g1', type: 'update_expense', expenseId: 'e-eur', expenseRevision: 2, snapshot: {}, source: 'system' }),
    )
    expect((await one('e-eur'))?.attribution.updatedBy).toEqual({ userId: null, name: 'Automatic recurrence', source: 'system' })
    await tx((db) =>
      db.insert(activities).values({ id: 'act-baseline', groupId: 'g1', type: 'update_expense', expenseId: 'e-cara', expenseRevision: 0, snapshot: {}, actorUserId: alice.userId, actorName: 'Alice' }),
    )
    expect((await one('e-cara'))?.attribution.updatedBy).toBeNull()
  })

  it('returns options and the expense page in the contract shape', async () => {
    const options = await tx((db) => feedOptions(db, { principal: alice }))
    expect(options.categories[18]).toEqual({ id: 18, grouping: 'Home', name: 'Rent' })
    expect(() => Schema.encodeSync(FeedOptions)(options)).not.toThrow()
    const page = await tx((db) => expenseContext(db, { principal: bob, expenseId: 'e-groceries' }))
    expect(page).toMatchObject({ group: { id: 'g1', kind: 'named' }, role: 'member', participantId: 'pb', context: null })
    expect(page.participants.map((p) => p.name)).toEqual(['Alice Renamed', 'Bob', 'Cara'])
    expect(() => Schema.encodeSync(ExpenseContext)(page)).not.toThrow()
  })

  it('reports per-group rows with signs, and zero rows for currencies the user does not share', async () => {
    const summary = await tx((db) => accountBalances(db, { principal: alice }))
    // USD: groceries +20, Bob's rent -10, Bob's payment to Alice -30. EUR: +20.
    expect(summary.balances).toEqual([
      { groupId: 'g1', groupName: 'Flat', kind: 'named', currency: 'EUR', participantId: 'pa', participantName: 'Alice Renamed', amount: '20.00' },
      { groupId: 'g1', groupName: 'Flat', kind: 'named', currency: 'USD', participantId: 'pa', participantName: 'Alice Renamed', amount: '-20.00' },
    ])
    expect(() => Schema.encodeSync(AccountBalances)(summary)).not.toThrow()
  })
})
