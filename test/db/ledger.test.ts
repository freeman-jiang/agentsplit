// The ledger against a real database: create, retry, update, list and delete,
// and the membership check. Each test that writes works in its own group.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { listBalances } from '~/server/balances'
import { createExpense, deleteExpense, getGroup, listExpenses, updateExpense } from '~/server/ledger'
import { testDatabase, type TestDatabase } from '../kit/database'
import { draft } from '../kit/drafts'
import { counter } from '../kit/ids'
import { principal } from '../kit/people'
import { seedHousehold } from '../kit/seed'

let database: TestDatabase
const tx: TestDatabase['tx'] = (work) => database.tx(work)
const alice = principal('u-alice', { name: 'Alice' })
const mallory = principal('u-mallory', { name: 'Mallory' })
const nextGroup = counter('lg')
const key = counter('ledger-key')

/** A new group "Home" with Alice (its admin), Bob and Cara, and a Costco draft of 100.00 that Alice pays. */
async function household() {
  const groupId = nextGroup()
  const slug = `${groupId}-home`
  const [pa, pb, pc] = [`${groupId}-pa`, `${groupId}-pb`, `${groupId}-pc`]
  await tx((db) => seedHousehold(db, { groupId, slug, name: 'Home', people: [{ id: pa, name: 'Alice', userId: alice.userId }, { id: pb, name: 'Bob' }, { id: pc, name: 'Cara' }] }))
  const expense = (over: Partial<ExpenseDraft> = {}) => draft({ payer: pa, people: [pa, pb, pc], vendor: 'Costco', amount: '100.00', ...over })
  const nets = async () => (await tx((db) => listBalances(db, { principal: alice, groupId }))).currencies.flatMap((c) => c.balances).map((b) => [b.participantId, b.net])
  return { groupId, slug, pa, pb, pc, expense, nets }
}
let shared: Awaited<ReturnType<typeof household>>

beforeAll(async () => {
  database = await testDatabase()
  shared = await household()
})
afterAll(async () => {
  await database.close()
})

describe('ledger', () => {
  it('creates an expense, splits it, and gives the payer the leftover cent', async () => {
    const h = await household()
    const e = await tx((db) => createExpense(db, { principal: alice, groupId: h.slug, expenseId: `${h.groupId}-e`, idempotencyKey: key(), expense: h.expense() }))
    expect(e.revision).toBe(1)
    expect(e.shares.map((s) => [s.participantId, s.amount])).toEqual([[h.pa, '33.34'], [h.pb, '33.33'], [h.pc, '33.33']])
    expect((await h.nets()).find(([id]) => id === h.pa)?.[1]).toBe('66.66')
  })

  it('returns the stored result when a write is retried with the same key', async () => {
    const h = await household()
    const k = key()
    const first = await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: `${h.groupId}-e`, idempotencyKey: k, expense: h.expense() }))
    const again = await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: `${h.groupId}-e`, idempotencyKey: k, expense: h.expense() }))
    expect(again).toEqual(first)
    await expect(
      tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: `${h.groupId}-other`, idempotencyKey: k, expense: h.expense() })),
    ).rejects.toMatchObject({ _tag: 'Invalid', field: 'idempotencyKey' })
  })

  it('refuses a stale revision and accepts the current one', async () => {
    const h = await household()
    const expenseId = `${h.groupId}-e`
    await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId, idempotencyKey: key(), expense: h.expense() }))
    await expect(
      tx((db) => updateExpense(db, { principal: alice, groupId: h.groupId, expenseId, expectedRevision: 0, idempotencyKey: key(), expense: h.expense({ title: 'Stale' }) })),
    ).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 1 })
    const updated = await tx((db) => updateExpense(db, { principal: alice, groupId: h.groupId, expenseId, expectedRevision: 1, idempotencyKey: key(), expense: h.expense({ title: 'Weekly groceries' }) }))
    expect(updated.revision).toBe(2)
  })

  it('records several payers', async () => {
    const h = await household()
    const payers = [{ participantId: h.pa, amount: '30.00' }, { participantId: h.pb, amount: '60.00' }]
    const e = await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: `${h.groupId}-e`, idempotencyKey: key(), expense: h.expense({ amount: '90.00', payers }) }))
    expect(e.payers).toEqual(payers)
  })

  it('orders by expense date or by last change, and filters', async () => {
    const h = await household()
    const [newer, older] = [`${h.groupId}-newer`, `${h.groupId}-older`]
    const olderDraft = (over: Partial<ExpenseDraft> = {}) =>
      h.expense({ expenseDate: '2026-10-01', amount: '90.00', payers: [{ participantId: h.pa, amount: '30.00' }, { participantId: h.pb, amount: '60.00' }], ...over })
    await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: older, idempotencyKey: key(), expense: olderDraft() }))
    await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: newer, idempotencyKey: key(), expense: h.expense() }))
    const list = async (filter: Parameters<typeof listExpenses>[1]['filter'], data: { cursor?: Parameters<typeof listExpenses>[1]['cursor']; limit?: number } = {}) =>
      tx((db) => listExpenses(db, { principal: alice, groupId: h.groupId, filter, cursor: data.cursor ?? null, limit: data.limit ?? 10 }))
    const ids = async (filter: Parameters<typeof listExpenses>[1]['filter']) => (await list(filter)).expenses.map((e) => e.id)
    expect(await ids({})).toEqual([newer, older])
    expect(await ids({ sort: 'updated' })).toEqual([newer, older])
    // Editing the older expense moves it to the top of "recently changed".
    await tx((db) => updateExpense(db, { principal: alice, groupId: h.groupId, expenseId: older, expectedRevision: 1, idempotencyKey: key(), expense: olderDraft({ title: 'Edited' }) }))
    expect(await ids({ sort: 'updated' })).toEqual([older, newer])
    const page = await list({ sort: 'updated' }, { limit: 1 })
    const next = await list({ sort: 'updated' }, { cursor: page.nextCursor, limit: 1 })
    expect([...page.expenses, ...next.expenses].map((e) => e.id)).toEqual([older, newer])
    expect(await ids({ search: 'cost' })).toHaveLength(2)
    expect(await ids({ payerId: h.pb })).toEqual([older])
    expect(await ids({ from: '2026-10-15' })).toEqual([newer])
  })

  it('deletes by tombstone and keeps balances consistent', async () => {
    const h = await household()
    const [kept, removed] = [`${h.groupId}-kept`, `${h.groupId}-removed`]
    await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: kept, idempotencyKey: key(), expense: h.expense() }))
    await tx((db) => createExpense(db, { principal: alice, groupId: h.groupId, expenseId: removed, idempotencyKey: key(), expense: h.expense({ amount: '90.00', payers: [{ participantId: h.pb, amount: '90.00' }] }) }))
    await tx((db) => deleteExpense(db, { principal: alice, groupId: h.groupId, expenseId: removed, expectedRevision: 1, idempotencyKey: key() }))
    const live = await tx((db) => listExpenses(db, { principal: alice, groupId: h.groupId, filter: {}, cursor: null, limit: 10 }))
    expect(live.expenses.map((e) => e.id)).toEqual([kept])
    // Only the live expense counts, and the balances sum to zero.
    expect(await h.nets()).toEqual([[h.pa, '66.66'], [h.pb, '-33.33'], [h.pc, '-33.33']])
  })

  it('refuses non-members', async () => {
    const forbidden = { _tag: 'Forbidden' }
    await expect(tx((db) => getGroup(db, { principal: mallory, groupId: shared.groupId }))).rejects.toMatchObject(forbidden)
    await expect(tx((db) => listExpenses(db, { principal: mallory, groupId: shared.groupId, filter: {}, cursor: null, limit: 10 }))).rejects.toMatchObject(forbidden)
    await expect(tx((db) => listExpenses(db, { principal: mallory, groupId: shared.slug, filter: { search: 'nothing matches this' }, cursor: null, limit: 10 }))).rejects.toMatchObject(forbidden)
    await expect(
      tx((db) => createExpense(db, { principal: mallory, groupId: shared.groupId, expenseId: `${shared.groupId}-m`, idempotencyKey: key(), expense: shared.expense() })),
    ).rejects.toMatchObject(forbidden)
  })
})
