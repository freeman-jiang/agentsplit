// The database itself must refuse ledger corruption, whatever the app does.
// Runs against a disposable local database: TEST_DATABASE_URL (default agentsplit_test).
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase } from './setup'

let pool: Pool
beforeAll(async () => {
  pool = await resetTestDatabase()
})
afterAll(async () => {
  await pool.end()
})

let n = 0
const id = (prefix: string) => `${prefix}-${++n}`

async function tx(work: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await work(c)
    await c.query('COMMIT')
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    c.release()
  }
}

const rejects = (work: (c: PoolClient) => Promise<void>) => expect(tx(work)).rejects.toMatchObject({ code: '23514' })

let group: string
let alice: string
let bob: string
beforeEach(async () => {
  group = id('g')
  alice = id('alice')
  bob = id('bob')
  await tx(async (c) => {
    await c.query(`INSERT INTO groups (id, kind, name, default_currency) VALUES ($1, 'named', 'Test', 'USD')`, [group])
    await c.query(`INSERT INTO participants (id, group_id, name) VALUES ($1, $3, 'Alice'), ($2, $3, 'Bob')`, [alice, bob, group])
  })
})

/** Inserts an expense of `amount` cents at revision 1 with its activity, paid by Alice, split as given. */
async function insertExpense(c: PoolClient, data: { expense: string; amount: number; shares: [string, number][]; payers?: [string, number][] }) {
  await c.query(
    `INSERT INTO expenses (id, group_id, revision, kind, title, expense_date, currency, amount, split_mode) VALUES ($1, $2, 1, 'expense', 'Dinner', '2026-11-05', 'USD', $3, 'amount')`,
    [data.expense, group, data.amount],
  )
  await c.query(
    `INSERT INTO activities (id, group_id, type, expense_id, expense_revision, snapshot) VALUES ($1, $2, 'create_expense', $3, 1, '{}'::jsonb)`,
    [id('act'), group, data.expense],
  )
  for (const [participant, amount] of data.payers ?? [[alice, data.amount]])
    await c.query(`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount) VALUES ($1, $2, $3, $4)`, [data.expense, group, participant, amount])
  for (const [participant, amount] of data.shares)
    await c.query(`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount, weight) VALUES ($1, $2, $3, $4, $5)`, [
      data.expense,
      group,
      participant,
      amount,
      String(amount),
    ])
}

describe('allocations', () => {
  it('accepts payers and shares that each sum to the amount', async () => {
    await tx((c) => insertExpense(c, { expense: id('e'), amount: 1001, shares: [[alice, 501], [bob, 500]] }))
  })

  it('accepts several payers', async () => {
    await tx((c) => insertExpense(c, { expense: id('e'), amount: 900, payers: [[alice, 600], [bob, 300]], shares: [[alice, 450], [bob, 450]] }))
  })

  it('refuses shares that do not sum to the amount', async () => {
    await rejects((c) => insertExpense(c, { expense: id('e'), amount: 1001, shares: [[alice, 500], [bob, 500]] }))
  })

  it('refuses payments that do not sum to the amount', async () => {
    await rejects((c) => insertExpense(c, { expense: id('e'), amount: 900, payers: [[alice, 600]], shares: [[alice, 450], [bob, 450]] }))
  })

  it('refuses an expense with no shares', async () => {
    await rejects((c) => insertExpense(c, { expense: id('e'), amount: 900, shares: [] }))
  })

  it('refuses a later change that unbalances an expense', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 1000, shares: [[alice, 500], [bob, 500]] }))
    await rejects(async (c) => {
      await c.query(`UPDATE expense_shares SET amount = 400 WHERE expense_id = $1 AND participant_id = $2`, [expense, bob])
    })
  })

  it('refuses a participant from another group', async () => {
    const other = id('g')
    const carol = id('carol')
    await tx(async (c) => {
      await c.query(`INSERT INTO groups (id, kind, name, default_currency) VALUES ($1, 'named', 'Other', 'USD')`, [other])
      await c.query(`INSERT INTO participants (id, group_id, name) VALUES ($1, $2, 'Carol')`, [carol, other])
    })
    await expect(tx((c) => insertExpense(c, { expense: id('e'), amount: 100, shares: [[carol, 100]] }))).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses an unsupported currency', async () => {
    await expect(
      tx((c) =>
        c.query(
          `INSERT INTO expenses (id, group_id, kind, title, expense_date, currency, amount, split_mode) VALUES ($1, $2, 'expense', 'x', '2026-11-05', 'XXX', 1, 'evenly')`,
          [id('e'), group],
        ).then(() => {}),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('history', () => {
  it('refuses to change or remove an activity', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 100, shares: [[alice, 100]] }))
    await rejects((c) => c.query(`UPDATE activities SET data = 'x' WHERE expense_id = $1`, [expense]).then(() => {}))
    await rejects((c) => c.query(`DELETE FROM activities WHERE expense_id = $1`, [expense]).then(() => {}))
    await rejects((c) => c.query(`TRUNCATE activities CASCADE`).then(() => {}))
  })

  it('refuses to hard-delete an expense', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 100, shares: [[alice, 100]] }))
    await rejects((c) => c.query(`DELETE FROM expenses WHERE id = $1`, [expense]).then(() => {}))
  })

  it('refuses an edit without the next revision and its activity', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 100, shares: [[alice, 100]] }))
    await rejects((c) => c.query(`UPDATE expenses SET title = 'Edited' WHERE id = $1`, [expense]).then(() => {}))
    await rejects((c) => c.query(`UPDATE expenses SET title = 'Edited', revision = 2 WHERE id = $1`, [expense]).then(() => {}))
  })

  it('accepts an edit with its activity, and moves updated_at', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 100, shares: [[alice, 100]] }))
    const before = await pool.query(`SELECT updated_at FROM expenses WHERE id = $1`, [expense])
    await tx(async (c) => {
      await c.query(`UPDATE expenses SET title = 'Edited', revision = 2 WHERE id = $1`, [expense])
      await c.query(
        `INSERT INTO activities (id, group_id, type, expense_id, expense_revision, snapshot) VALUES ($1, $2, 'update_expense', $3, 2, '{}'::jsonb)`,
        [id('act'), group, expense],
      )
    })
    const after = await pool.query(`SELECT updated_at, revision FROM expenses WHERE id = $1`, [expense])
    expect(after.rows[0].revision).toBe(2)
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime())
  })

  it('freezes a deleted expense and its allocations', async () => {
    const expense = id('e')
    await tx((c) => insertExpense(c, { expense, amount: 100, shares: [[alice, 100]] }))
    await tx(async (c) => {
      await c.query(`UPDATE expenses SET deleted_at = now(), revision = 2 WHERE id = $1`, [expense])
      await c.query(`INSERT INTO activities (id, group_id, type, expense_id, expense_revision) VALUES ($1, $2, 'delete_expense', $3, 2)`, [
        id('act'),
        group,
        expense,
      ])
    })
    await rejects((c) => c.query(`DELETE FROM expense_shares WHERE expense_id = $1`, [expense]).then(() => {}))
    await rejects(async (c) => {
      await c.query(`UPDATE expenses SET title = 'Back', revision = 3, deleted_at = NULL WHERE id = $1`, [expense])
    })
  })
})

describe('people', () => {
  it('refuses to delete a participant who is part of an expense', async () => {
    await tx((c) => insertExpense(c, { expense: id('e'), amount: 100, shares: [[bob, 100]] }))
    await expect(tx((c) => c.query(`DELETE FROM participants WHERE id = $1`, [bob]).then(() => {}))).rejects.toMatchObject({ code: '23001' })
  })

  it('refuses to reassign a bound member', async () => {
    await tx((c) => c.query(`INSERT INTO memberships (user_id, group_id, participant_id) VALUES ('u1', $1, $2)`, [group, alice]).then(() => {}))
    await rejects((c) => c.query(`UPDATE memberships SET participant_id = $1 WHERE group_id = $2`, [bob, group]).then(() => {}))
  })

  it('refuses to delete a group', async () => {
    await rejects((c) => c.query(`DELETE FROM groups WHERE id = $1`, [group]).then(() => {}))
  })
})
