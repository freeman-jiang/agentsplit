// The database's own rules, by the migration that adds them. The database must
// refuse ledger corruption whatever the app does, and a missing rule fails
// silently, so each test proves a refusal (or the one case a rule must allow).
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as app from '../../db/schema/app'
import { CURRENCIES } from '~/shared/currencies'
import { LIMITS } from '~/shared/limits'
import { DECIMAL } from '~/shared/minor'
import { WEIGHT } from '~/shared/split'
import { testDatabase, type TestDatabase } from '../kit/database'
import { counter } from '../kit/ids'

let database: TestDatabase
beforeAll(async () => {
  database = await testDatabase()
})
afterAll(() => database.close())

const next = counter('row')
const id = (prefix: string) => `${prefix}-${next()}`

/** Runs `work` in one transaction, so the deferred triggers run at its COMMIT. */
async function tx(work: (c: PoolClient) => Promise<unknown>) {
  const c = await database.pool.connect()
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
const run = (text: string, values: unknown[] = []) => tx((c) => c.query(text, values))
/** 23503: foreign key, 23001: delete of a row that a RESTRICT key names, 23505: unique key, 23514: check or trigger. */
type Code = '23503' | '23001' | '23505' | '23514'
const refuses = (code: Code, text: string, values: unknown[] = []) => expect(run(text, values)).rejects.toMatchObject({ code })
const refusesAll = (code: Code, work: (c: PoolClient) => Promise<unknown>) => expect(tx(work)).rejects.toMatchObject({ code })
/** The column name in SQL: Drizzle's camelCase key in snake case. */
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

const insertUser = (userId: string) => run(`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Test', $2, now(), now())`, [userId, `${userId}@example.com`])
const insertClient = (clientId: string) => run(`INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ($1, $1, '{}')`, [clientId])

/** A new named group with two people. */
async function newGroup() {
  const group = id('g')
  const [alice, bob] = [id('alice'), id('bob')]
  await tx(async (c) => {
    await c.query(`INSERT INTO groups (id, kind, name, default_currency) VALUES ($1, 'named', 'Test', 'USD')`, [group])
    await c.query(`INSERT INTO participants (id, group_id, name) VALUES ($1, $3, 'Alice'), ($2, $3, 'Bob')`, [alice, bob, group])
  })
  return { group, alice, bob }
}
type Group = Awaited<ReturnType<typeof newGroup>>

/**
 * Inserts an expense of `amount` cents at revision 1 with its activity, paid by
 * Alice unless `payers` says otherwise, split as `shares` (by amount unless
 * `splitMode` says otherwise; a share's weight is its amount unless given).
 */
async function insertExpense(
  c: PoolClient,
  g: Group,
  data: { expense: string; amount: number; shares: [string, number, string?][]; payers?: [string, number, string?][]; splitMode?: string },
) {
  await c.query(
    `INSERT INTO expenses (id, group_id, revision, kind, title, expense_date, currency, amount, split_mode) VALUES ($1, $2, 1, 'expense', 'Dinner', '2026-11-05', 'USD', $3, $4)`,
    [data.expense, g.group, data.amount, data.splitMode ?? 'amount'],
  )
  await c.query(`INSERT INTO activities (id, group_id, type, expense_id, expense_revision, snapshot) VALUES ($1, $2, 'create_expense', $3, 1, '{}'::jsonb)`, [id('act'), g.group, data.expense])
  for (const [participant, amount, weight = '1'] of data.payers ?? [[g.alice, data.amount]])
    await c.query(`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount, weight, currency, live) VALUES ($1, $2, $3, $4, $5, 'USD', true)`, [data.expense, g.group, participant, amount, weight])
  for (const [participant, amount, weight = String(amount)] of data.shares)
    await c.query(`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount, weight, currency, live) VALUES ($1, $2, $3, $4, $5, 'USD', true)`, [data.expense, g.group, participant, amount, weight])
}
const newExpense = async (g: Group) => {
  const expense = id('e')
  await tx((c) => insertExpense(c, g, { expense, amount: 100, shares: [[g.alice, 100]] }))
  return expense
}

describe('0001: ledger invariants', () => {
  it('accepts payers and shares that each sum to the amount, also with several payers', async () => {
    const g = await newGroup()
    await tx((c) => insertExpense(c, g, { expense: id('e'), amount: 1001, shares: [[g.alice, 501], [g.bob, 500]] }))
    await tx((c) => insertExpense(c, g, { expense: id('e'), amount: 900, payers: [[g.alice, 600], [g.bob, 300]], shares: [[g.alice, 450], [g.bob, 450]] }))
  })

  it('refuses shares or payments that do not sum to the amount, and an expense without shares', async () => {
    const g = await newGroup()
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 1001, shares: [[g.alice, 500], [g.bob, 500]] }))
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 900, payers: [[g.alice, 600]], shares: [[g.alice, 450], [g.bob, 450]] }))
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 900, shares: [] }))
  })

  it('refuses a later change that unbalances an expense', async () => {
    const g = await newGroup()
    const expense = id('e')
    await tx((c) => insertExpense(c, g, { expense, amount: 1000, shares: [[g.alice, 500], [g.bob, 500]] }))
    await refuses('23514', `UPDATE expense_shares SET amount = 400 WHERE expense_id = $1 AND participant_id = $2`, [expense, g.bob])
  })

  it('refuses a participant from another group', async () => {
    const [g, other] = [await newGroup(), await newGroup()]
    await refusesAll('23503', (c) => insertExpense(c, g, { expense: id('e'), amount: 100, shares: [[other.alice, 100]] }))
  })

  it('refuses an unsupported currency in an expense, its original amount and a group', async () => {
    const g = await newGroup()
    const insert = `INSERT INTO expenses (id, group_id, kind, title, expense_date, currency, amount, split_mode, original_amount, original_currency, conversion_rate) VALUES ($1, $2, 'expense', 'x', '2026-11-05', $3, 1, 'evenly', $4, $5, $6)`
    await refuses('23514', insert, [id('e'), g.group, 'XXX', null, null, null])
    await refuses('23514', insert, [id('e'), g.group, 'USD', 1, 'XXX', '1'])
    await refuses('23514', `INSERT INTO groups (id, kind, name, default_currency) VALUES ($1, 'named', 'x', 'XXX')`, [id('g')])
  })

  it('refuses a weight that is not decimal text, and a payer weight with a sign', async () => {
    const g = await newGroup()
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 100, payers: [[g.alice, 100, '-1']], shares: [[g.alice, 100]] }))
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 100, payers: [[g.alice, 100, '1.']], shares: [[g.alice, 100]] }))
  })

  it('refuses to change, remove or truncate an activity', async () => {
    const expense = await newExpense(await newGroup())
    await refuses('23514', `UPDATE activities SET data = 'x' WHERE expense_id = $1`, [expense])
    await refuses('23514', `DELETE FROM activities WHERE expense_id = $1`, [expense])
    await refuses('23514', `TRUNCATE activities CASCADE`)
  })

  it('refuses to hard-delete an expense', async () => {
    const expense = await newExpense(await newGroup())
    await refuses('23514', `DELETE FROM expenses WHERE id = $1`, [expense])
  })

  it('refuses an edit without the next revision and its activity', async () => {
    const expense = await newExpense(await newGroup())
    await refuses('23514', `UPDATE expenses SET title = 'Edited' WHERE id = $1`, [expense])
    await refuses('23514', `UPDATE expenses SET title = 'Edited', revision = 2 WHERE id = $1`, [expense])
  })

  it('accepts an edit with its activity, and moves updated_at', async () => {
    const g = await newGroup()
    const expense = await newExpense(g)
    const before = await database.pool.query(`SELECT updated_at FROM expenses WHERE id = $1`, [expense])
    await tx(async (c) => {
      await c.query(`UPDATE expenses SET title = 'Edited', revision = 2 WHERE id = $1`, [expense])
      await c.query(`INSERT INTO activities (id, group_id, type, expense_id, expense_revision, snapshot) VALUES ($1, $2, 'update_expense', $3, 2, '{}'::jsonb)`, [id('act'), g.group, expense])
    })
    const after = await database.pool.query(`SELECT updated_at, revision FROM expenses WHERE id = $1`, [expense])
    expect(after.rows[0].revision).toBe(2)
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime())
  })

  it('freezes a deleted expense and its allocations', async () => {
    const g = await newGroup()
    const expense = await newExpense(g)
    await tx(async (c) => {
      await c.query(`UPDATE expenses SET deleted_at = now(), revision = 2 WHERE id = $1`, [expense])
      await c.query(`INSERT INTO activities (id, group_id, type, expense_id, expense_revision) VALUES ($1, $2, 'delete_expense', $3, 2)`, [id('act'), g.group, expense])
    })
    await refuses('23514', `DELETE FROM expense_shares WHERE expense_id = $1`, [expense])
    await refuses('23514', `UPDATE expenses SET title = 'Back', revision = 3, deleted_at = NULL WHERE id = $1`, [expense])
  })

  it('refuses to delete a participant who is part of an expense', async () => {
    const g = await newGroup()
    await tx((c) => insertExpense(c, g, { expense: id('e'), amount: 100, shares: [[g.bob, 100]] }))
    await refuses('23001', `DELETE FROM participants WHERE id = $1`, [g.bob])
  })

  it('refuses to reassign a bound member', async () => {
    const g = await newGroup()
    const user = id('u')
    await insertUser(user)
    await run(`INSERT INTO memberships (user_id, group_id, participant_id) VALUES ($1, $2, $3)`, [user, g.group, g.alice])
    await refuses('23514', `UPDATE memberships SET participant_id = $1 WHERE group_id = $2`, [g.bob, g.group])
  })

  it('refuses to delete a group', async () => {
    const g = await newGroup()
    await refuses('23514', `DELETE FROM groups WHERE id = $1`, [g.group])
  })
})

describe('0004: group audit', () => {
  // A new column that the audit leaves out would change without a revision or an activity, silently.
  it('refuses a change to any group column other than id and created_at without the next revision and its activity', async () => {
    const changed: Record<string, string> = { kind: `'private'`, slug: `'changed-slug'`, name: `'Changed'`, information: `'Changed'`, default_currency: `'EUR'`, revision: 'revision + 1' }
    const columns = getTableConfig(app.groups).columns.map((c) => snake(c.name)).filter((name) => name !== 'id' && name !== 'created_at')
    expect(columns.filter((name) => !(name in changed))).toEqual([])
    for (const column of columns) {
      const g = await newGroup()
      await expect(run(`UPDATE groups SET ${column} = ${changed[column]} WHERE id = $1`, [g.group]), column).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('accepts a group edit with the next revision and its update_group activity', async () => {
    const g = await newGroup()
    await tx(async (c) => {
      await c.query(`UPDATE groups SET name = 'Renamed', revision = 1 WHERE id = $1`, [g.group])
      await c.query(`INSERT INTO activities (id, group_id, type, group_revision, snapshot) VALUES ($1, $2, 'update_group', 1, '{}'::jsonb)`, [id('act'), g.group])
    })
  })
})

describe('0009: references, value lists, unique keys and permanent receipts', () => {
  it('refuses an activity for a missing expense, an expense or a participant of another group', async () => {
    const [g, other] = [await newGroup(), await newGroup()]
    const expense = await newExpense(g)
    await refuses('23503', `INSERT INTO activities (id, group_id, type, expense_id) VALUES ($1, $2, 'update_group', 'missing')`, [id('act'), g.group])
    await refuses('23503', `INSERT INTO activities (id, group_id, type, expense_id) VALUES ($1, $2, 'update_group', $3)`, [id('act'), other.group, expense])
    await refuses('23503', `INSERT INTO activities (id, group_id, type, participant_id) VALUES ($1, $2, 'join_group', $3)`, [id('act'), g.group, other.alice])
  })

  it('refuses to delete a participant that an activity names', async () => {
    const g = await newGroup()
    await run(`INSERT INTO activities (id, group_id, type, participant_id) VALUES ($1, $2, 'update_group', $3)`, [id('act'), g.group, g.bob])
    await refuses('23001', `DELETE FROM participants WHERE id = $1`, [g.bob])
  })

  it('refuses a recurring link in another group than its expense', async () => {
    const [g, other] = [await newGroup(), await newGroup()]
    const expense = await newExpense(g)
    await refuses('23503', `INSERT INTO recurring_links (id, group_id, current_frame_expense_id, next_expense_date, anchor_day) VALUES ($1, $2, $3, '2026-12-05', 5)`, [id('link'), other.group, expense])
  })

  it('refuses a membership, an API key or an agent connection of a missing user or client', async () => {
    const g = await newGroup()
    const [client, owner] = [id('client'), id('user')]
    await insertClient(client)
    await insertUser(owner)
    await refuses('23503', `INSERT INTO memberships (user_id, group_id) VALUES ('missing', $1)`, [g.group])
    await refuses('23503', `INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, 'missing', $2, now(), now())`, [id('key'), id('hash')])
    const connection = `INSERT INTO oauth_connections (id, authorization_code_id, user_id, client_id, scopes) VALUES ($1, $2, $3, $4, '{}')`
    await refuses('23503', connection, [id('conn'), id('code'), 'missing', client])
    await refuses('23503', connection, [id('conn'), id('code'), owner, 'missing'])
  })

  it('removes the keys and connections of a deleted user, but refuses to delete a member', async () => {
    const g = await newGroup()
    const [user, client] = [id('user'), id('client')]
    await insertUser(user)
    await insertClient(client)
    await run(`INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`, [id('key'), user, id('hash')])
    await run(`INSERT INTO oauth_connections (id, authorization_code_id, user_id, client_id, scopes) VALUES ($1, $2, $3, $4, '{}')`, [id('conn'), id('code'), user, client])
    await run(`DELETE FROM "user" WHERE id = $1`, [user])
    const left = await database.pool.query(
      `SELECT (SELECT count(*) FROM apikey WHERE reference_id = $1)::int AS keys, (SELECT count(*) FROM oauth_connections WHERE user_id = $1)::int AS connections`,
      [user],
    )
    expect(left.rows[0]).toEqual({ keys: 0, connections: 0 })
    const member = id('user')
    await insertUser(member)
    await run(`INSERT INTO memberships (user_id, group_id) VALUES ($1, $2)`, [member, g.group])
    await refuses('23001', `DELETE FROM "user" WHERE id = $1`, [member])
  })

  it('refuses an unknown split mode, recurrence, activity type or role, such as v1’s enum names', async () => {
    const g = await newGroup()
    const insert = (column: 'split_mode' | 'recurrence', value: string) =>
      run(`INSERT INTO expenses (id, group_id, kind, title, expense_date, currency, amount, split_mode, recurrence) VALUES ($1, $2, 'expense', 'x', '2026-11-05', 'USD', 1, $3, $4)`, [
        id('e'),
        g.group,
        column === 'split_mode' ? value : 'evenly',
        column === 'recurrence' ? value : 'none',
      ])
    // The constraint name matters: this expense has no payers, which the allocation trigger also refuses at commit.
    await expect(insert('split_mode', 'EVENLY')).rejects.toMatchObject({ code: '23514', constraint: 'expenses_split_mode' })
    await expect(insert('recurrence', 'yearly')).rejects.toMatchObject({ code: '23514', constraint: 'expenses_recurrence' })
    await refuses('23514', `INSERT INTO activities (id, group_id, type) VALUES ($1, $2, 'CREATE_GROUP')`, [id('act'), g.group])
    const user = id('user')
    await insertUser(user)
    await refuses('23514', `INSERT INTO memberships (user_id, group_id, role) VALUES ($1, $2, 'owner')`, [user, g.group])
  })

  it('refuses to link one provider account to two users, two API keys with one hash, and one OAuth client to one resource twice', async () => {
    const [owner, user] = [id('user'), id('user')]
    await insertUser(owner)
    await insertUser(user)
    const account = `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ($1, 'google-123', 'google', $2, now(), now())`
    await run(account, [id('account'), owner])
    await refuses('23505', account, [id('account'), user])
    const key = `INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, $2, 'same-hash', now(), now())`
    await run(key, [id('key'), owner])
    await refuses('23505', key, [id('key'), owner])
    const client = id('client')
    await insertClient(client)
    await run(`INSERT INTO oauth_resource (id, identifier, name) VALUES ($1, 'https://app.example/api/mcp', 'MCP')`, [id('resource')])
    const link = `INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ($1, $2, 'https://app.example/api/mcp')`
    await run(link, [id('link'), client])
    await refuses('23505', link, [id('link'), client])
  })

  it('refuses to change, delete or truncate a receipt row', async () => {
    const g = await newGroup()
    const receipt = id('receipt')
    await run(`INSERT INTO receipts (id, group_id, url) VALUES ($1, $2, $3)`, [receipt, g.group, `https://app.example/api/receipts?key=${receipt}`])
    await refuses('23514', `UPDATE receipts SET created_by = 'someone' WHERE id = $1`, [receipt])
    await refuses('23514', `DELETE FROM receipts WHERE id = $1`, [receipt])
    // The deletion table's foreign key alone refuses a plain TRUNCATE; CASCADE reaches the trigger.
    await refuses('23514', `TRUNCATE receipts CASCADE`)
  })
})

describe('0012: receipt sizes and deletions', () => {
  it('refuses to change the size of a receipt, also one stored before sizes were recorded', async () => {
    const g = await newGroup()
    const receipt = id('receipt')
    await run(`INSERT INTO receipts (id, group_id, url) VALUES ($1, $2, $3)`, [receipt, g.group, `r2://agentsplit-receipts/receipts/${receipt}.png`])
    await refuses('23514', `UPDATE receipts SET bytes = 1234 WHERE id = $1`, [receipt])
  })

  it('keeps a receipt deletion: only its purge time can be set, once', async () => {
    const g = await newGroup()
    const [receipt, deleter] = [id('receipt'), id('user')]
    await run(`INSERT INTO receipts (id, group_id, url, bytes) VALUES ($1, $2, $3, 10)`, [receipt, g.group, `r2://agentsplit-receipts/receipts/${receipt}.png`])
    await insertUser(deleter)
    await run(`INSERT INTO deleted_receipts (receipt_id, deleted_by) VALUES ($1, $2)`, [receipt, deleter])
    await refuses('23514', `DELETE FROM deleted_receipts WHERE receipt_id = $1`, [receipt])
    await refuses('23514', `UPDATE deleted_receipts SET deleted_at = now() - interval '1 day' WHERE receipt_id = $1`, [receipt])
    await run(`UPDATE deleted_receipts SET purged_at = now() WHERE receipt_id = $1`, [receipt])
    await refuses('23514', `UPDATE deleted_receipts SET purged_at = NULL WHERE receipt_id = $1`, [receipt])
    await refuses('23514', `TRUNCATE deleted_receipts`)
  })
})

describe('0015: a private context’s expense, checked at commit', () => {
  it('accepts the context before its expense in the transaction, and refuses it at commit if the expense never comes', async () => {
    const g = await newGroup()
    const c = await database.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO private_contexts (group_id, expense_id) VALUES ($1, 'missing')`, [g.group])
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23503' })
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })
})

describe('0017: signed amount split weights', () => {
  it('accepts a negative amount split by amount, with each share’s signed amount as its weight', async () => {
    const g = await newGroup()
    const expense = id('e')
    await tx((c) => insertExpense(c, g, { expense, amount: -3000, payers: [[g.alice, -3000]], shares: [[g.alice, -1000], [g.bob, -2000]] }))
    const stored = await database.pool.query(`SELECT weight FROM expense_shares WHERE expense_id = $1 ORDER BY weight`, [expense])
    expect(stored.rows).toEqual([{ weight: '-1000' }, { weight: '-2000' }])
  })
})

describe('0019: a signed share weight only for a negative amount split by amount', () => {
  it('refuses a signed share weight in any other expense, and a malformed signed weight', async () => {
    const g = await newGroup()
    const refund = { amount: -100, payers: [[g.alice, -100]] as [string, number][] }
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), ...refund, splitMode: 'shares', shares: [[g.alice, -100, '-1']] }))
    await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), amount: 100, shares: [[g.alice, 100, '-100']] }))
    for (const weight of ['1.', '--1', '-', '-01'])
      await refusesAll('23514', (c) => insertExpense(c, g, { expense: id('e'), ...refund, shares: [[g.alice, -100, weight]] }))
  })
})

describe('the shared value lists and limits', () => {
  type Check = { table: string; name: string; columns: string[]; definition: string }
  const checks = async () =>
    (
      await database.pool.query<Check>(`
        SELECT c.conrelid::regclass::text AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS definition,
          array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS columns
        FROM pg_constraint c WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace`)
    ).rows
  const listed = (definition: string) => [...new Set([...definition.matchAll(/'([^']*)'::text/g)].map((m) => m[1]))].sort()

  it('checks payer and share weights with the regexes of src/shared', async () => {
    const all = await checks()
    const pattern = (name: string) => all.find((c) => c.name === name)?.definition.match(/~ '(.*)'::text/)?.[1]
    expect(pattern('expense_payers_weight_decimal')).toBe(WEIGHT.source)
    expect(pattern('expense_shares_weight_decimal')).toBe(DECIMAL.source)
  })

  // The lists come from src/shared; an old migration that disagrees with them fails silently until a write is refused, or accepted.
  it('checks every Drizzle enum column with exactly the shared list', async () => {
    const all = await checks()
    const columns = Object.values(app)
      .filter((value) => is(value, PgTable))
      .flatMap((table) => getTableConfig(table).columns.filter((c) => c.enumValues?.length).map((c) => ({ table: getTableConfig(table).name, column: snake(c.name), values: c.enumValues ?? [] })))
    expect(columns.length).toBeGreaterThanOrEqual(9)
    for (const { table, column, values } of columns) {
      const found = all.filter((c) => c.table === table && c.columns.includes(column) && listed(c.definition).length > 0)
      expect(found.map((c) => listed(c.definition)), `${table}.${column}`).toEqual([[...values].sort()])
    }
  })

  it('checks the currencies with the shared registry, and the upload size with the receipt limit', async () => {
    const all = await checks()
    const codes = Object.keys(CURRENCIES).sort()
    for (const name of ['expenses_currency_supported', 'expenses_original_currency_supported', 'groups_currency_supported'])
      expect(listed(all.find((c) => c.name === name)?.definition ?? ''), name).toEqual(codes)
    expect(all.find((c) => c.name === 'receipt_uploads_bytes')?.definition).toBe(`CHECK (((bytes >= 1) AND (bytes <= ${LIMITS.receiptBytes})))`)
  })
})
