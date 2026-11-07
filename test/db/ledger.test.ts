import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { makeDb, type Db } from '~/server/db'
import { listBalances } from '~/server/expenses'
import { createExpense, deleteExpense, getGroup, listExpenses, updateExpense, type Principal } from '~/server/ledger'
import { resetTestDatabase, testUsers } from './setup'

let pool: Pool
const alice: Principal = { userId: 'u-alice', name: 'Alice', email: 'a@example.com', source: 'web', agentKeyId: null }
const mallory: Principal = { userId: 'u-mallory', name: 'Mallory', email: 'm@example.com', source: 'web', agentKeyId: null }

/** Runs `work` in a SERIALIZABLE transaction, as the server does. */
async function tx<A>(work: (db: Db) => Promise<A>): Promise<A> {
  const client = await pool.connect()
  try {
    return await makeDb(client).transaction(work, { isolationLevel: 'serializable' })
  } finally {
    client.release()
  }
}

beforeAll(async () => {
  pool = await resetTestDatabase()
  await tx(async (db) => {
    await db.insert(groups).values({ id: 'g1', kind: 'named', slug: 'home', name: 'Home', defaultCurrency: 'USD' })
    await db.insert(participants).values([
      { id: 'pa', groupId: 'g1', name: 'Alice' },
      { id: 'pb', groupId: 'g1', name: 'Bob' },
      { id: 'pc', groupId: 'g1', name: 'Cara' },
    ])
    await db.insert(user).values(testUsers([alice]))
    await db.insert(memberships).values({ userId: alice.userId, groupId: 'g1', role: 'admin', participantId: 'pa' })
  })
})
afterAll(async () => {
  await pool.end()
})

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  kind: 'expense',
  title: 'Groceries',
  vendor: 'Costco',
  notes: '',
  categoryId: 0,
  expenseDate: '2026-11-01',
  currency: 'USD',
  amount: '100.00',
  payers: [{ participantId: 'pa', amount: '100.00' }],
  splitMode: 'evenly',
  shares: [{ participantId: 'pa', weight: '1' }, { participantId: 'pb', weight: '1' }, { participantId: 'pc', weight: '1' }],
  recurrence: 'none',
  ...over,
})

describe('ledger', () => {
  it('creates an expense, splits it, and gives the payer the leftover cent', async () => {
    const e = await tx((db) => createExpense(db, { principal: alice, group: 'home', expenseId: 'e1', idempotencyKey: 'key-e1-0001', expense: draft() }))
    expect(e.revision).toBe(1)
    expect(e.shares.map((s) => [s.participantId, s.amount])).toEqual([['pa', '33.34'], ['pb', '33.33'], ['pc', '33.33']])
    const { currencies } = await tx((db) => listBalances(db, { principal: alice, group: 'g1' }))
    expect(currencies.flatMap((c) => c.balances).find((b) => b.participantId === 'pa')?.net).toBe('66.66')
  })

  it('returns the stored result when a write is retried with the same key', async () => {
    const again = await tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'e1', idempotencyKey: 'key-e1-0001', expense: draft() }))
    expect(again.id).toBe('e1')
    await expect(
      tx((db) => createExpense(db, { principal: alice, group: 'g1', expenseId: 'e9', idempotencyKey: 'key-e1-0001', expense: draft() })),
    ).rejects.toMatchObject({ _tag: 'Invalid', field: 'idempotencyKey' })
  })

  it('refuses a stale revision and accepts the current one', async () => {
    await expect(
      tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'e1', expectedRevision: 0, idempotencyKey: 'key-u-stale', expense: draft({ title: 'Stale' }) })),
    ).rejects.toMatchObject({ _tag: 'Conflict', currentRevision: 1 })
    const updated = await tx((db) =>
      updateExpense(db, { principal: alice, group: 'g1', expenseId: 'e1', expectedRevision: 1, idempotencyKey: 'key-u-0001', expense: draft({ title: 'Weekly groceries' }) }),
    )
    expect(updated.revision).toBe(2)
  })

  it('records several payers', async () => {
    const e = await tx((db) =>
      createExpense(db, {
        principal: alice,
        group: 'g1',
        expenseId: 'e2',
        idempotencyKey: 'key-e2-0001',
        expense: draft({ expenseDate: '2026-10-01', amount: '90.00', payers: [{ participantId: 'pa', amount: '30.00' }, { participantId: 'pb', amount: '60.00' }] }),
      }),
    )
    expect(e.payers).toEqual([{ participantId: 'pa', amount: '30.00' }, { participantId: 'pb', amount: '60.00' }])
  })

  it('orders by expense date or by last change, and filters', async () => {
    const byDate = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: {}, cursor: null, limit: 10 }))
    expect(byDate.expenses.map((e) => e.id)).toEqual(['e1', 'e2'])
    // Editing the older expense moves it to the top of "recently changed".
    await tx((db) => updateExpense(db, { principal: alice, group: 'g1', expenseId: 'e2', expectedRevision: 1, idempotencyKey: 'key-u-e2-1', expense: draft({ expenseDate: '2026-10-01', amount: '90.00', payers: [{ participantId: 'pa', amount: '30.00' }, { participantId: 'pb', amount: '60.00' }], title: 'Edited' }) }))
    const byUpdate = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { sort: 'updated' }, cursor: null, limit: 10 }))
    expect(byUpdate.expenses.map((e) => e.id)).toEqual(['e2', 'e1'])
    const page = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { sort: 'updated' }, cursor: null, limit: 1 }))
    const next = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { sort: 'updated' }, cursor: page.nextCursor, limit: 1 }))
    expect([...page.expenses, ...next.expenses].map((e) => e.id)).toEqual(['e2', 'e1'])
    const search = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { search: 'cost' }, cursor: null, limit: 10 }))
    expect(search.expenses).toHaveLength(2)
    const payer = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { payerId: 'pb' }, cursor: null, limit: 10 }))
    expect(payer.expenses.map((e) => e.id)).toEqual(['e2'])
    const range = await tx((db) => listExpenses(db, { principal: alice, group: 'g1', filter: { from: '2026-10-15' }, cursor: null, limit: 10 }))
    expect(range.expenses.map((e) => e.id)).toEqual(['e1'])
  })

  it('deletes by tombstone and keeps balances consistent', async () => {
    await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: 'e2', expectedRevision: 2, idempotencyKey: 'key-d-e2-1' }))
    const { currencies } = await tx((db) => listBalances(db, { principal: alice, group: 'g1' }))
    expect(currencies.flatMap((c) => c.balances).reduce((sum, b) => sum + Math.round(Number(b.net) * 100), 0)).toBe(0)
  })

  it('refuses non-members', async () => {
    await expect(tx((db) => getGroup(db, { principal: mallory, group: 'g1' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(tx((db) => listExpenses(db, { principal: mallory, group: 'g1', filter: {}, cursor: null, limit: 10 }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(tx((db) => listExpenses(db, { principal: mallory, group: 'home', filter: { search: 'nothing matches this' }, cursor: null, limit: 10 }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(
      tx((db) => createExpense(db, { principal: mallory, group: 'g1', expenseId: 'e3', idempotencyKey: 'key-m-0001', expense: draft() })),
    ).rejects.toMatchObject({ _tag: 'Forbidden' })
  })
})
