// The rules of migration 0009 (docs/v2/parity/AUDIT.md, gaps 12 to 17). A
// missing constraint fails silently, so each test proves a refusal.
// Runs against a disposable local database: TEST_DATABASE_URL (default agentsplit_test).
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetTestDatabase } from './setup'

let pool: Pool
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

const run = (text: string, values: string[] = []) => tx(async (c) => void (await c.query(text, values)))
/** 23503: foreign key, 23001: delete of a row that a RESTRICT key names, 23505: unique key, 23514: check or trigger. */
const refuses = (code: '23503' | '23001' | '23505' | '23514', text: string, values: string[] = []) =>
  expect(run(text, values)).rejects.toMatchObject({ code })

const group = id('g')
const other = id('g')
const alice = id('alice')
const carol = id('carol')
const expense = id('e')
const owner = id('user')

async function insertUser(userId: string) {
  await run(`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Test', $2, now(), now())`, [userId, `${userId}@example.com`])
}

async function insertClient(clientId: string) {
  await run(`INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ($1, $1, '{}')`, [clientId])
}

beforeAll(async () => {
  pool = await resetTestDatabase()
  await tx(async (c) => {
    await c.query(`INSERT INTO groups (id, kind, name, default_currency) VALUES ($1, 'named', 'Test', 'USD'), ($2, 'named', 'Other', 'USD')`, [group, other])
    await c.query(`INSERT INTO participants (id, group_id, name) VALUES ($1, $2, 'Alice'), ($3, $4, 'Carol')`, [alice, group, carol, other])
    await c.query(
      `INSERT INTO expenses (id, group_id, revision, kind, title, expense_date, currency, amount, split_mode) VALUES ($1, $2, 1, 'expense', 'Dinner', '2026-11-05', 'USD', 100, 'evenly')`,
      [expense, group],
    )
    await c.query(`INSERT INTO activities (id, group_id, type, expense_id, expense_revision, snapshot) VALUES ($1, $2, 'create_expense', $3, 1, '{}'::jsonb)`, [
      id('act'),
      group,
      expense,
    ])
    await c.query(`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount) VALUES ($1, $2, $3, 100)`, [expense, group, alice])
    await c.query(`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount) VALUES ($1, $2, $3, 100)`, [expense, group, alice])
  })
  await insertUser(owner)
})
afterAll(async () => {
  await pool.end()
})

describe('foreign keys', () => {
  it('refuses an activity for a missing expense or an expense of another group', async () => {
    await refuses('23503', `INSERT INTO activities (id, group_id, type, expense_id) VALUES ($1, $2, 'update_group', 'missing')`, [id('act'), group])
    await refuses('23503', `INSERT INTO activities (id, group_id, type, expense_id) VALUES ($1, $2, 'update_group', $3)`, [id('act'), other, expense])
  })

  it('refuses an activity for a participant of another group', async () => {
    await refuses('23503', `INSERT INTO activities (id, group_id, type, participant_id) VALUES ($1, $2, 'join_group', $3)`, [id('act'), group, carol])
  })

  it('refuses to delete a participant that an activity names', async () => {
    const dave = id('dave')
    await run(`INSERT INTO participants (id, group_id, name) VALUES ($1, $2, 'Dave')`, [dave, group])
    await run(`INSERT INTO activities (id, group_id, type, participant_id) VALUES ($1, $2, 'update_group', $3)`, [id('act'), group, dave])
    await refuses('23001', `DELETE FROM participants WHERE id = $1`, [dave])
  })

  it('refuses a recurring link in another group than its expense', async () => {
    await refuses('23503', `INSERT INTO recurring_links (id, group_id, current_frame_expense_id, next_expense_date, anchor_day) VALUES ($1, $2, $3, '2026-12-05', 5)`, [
      id('link'),
      other,
      expense,
    ])
  })

  it('refuses a membership, an API key or an agent connection of a missing user', async () => {
    const client = id('client')
    await insertClient(client)
    await refuses('23503', `INSERT INTO memberships (user_id, group_id) VALUES ('missing', $1)`, [group])
    await refuses('23503', `INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, 'missing', $2, now(), now())`, [id('key'), id('hash')])
    await refuses('23503', `INSERT INTO oauth_connections (id, authorization_code_id, user_id, client_id, scopes) VALUES ($1, $2, 'missing', $3, '{}')`, [
      id('conn'),
      id('code'),
      client,
    ])
  })

  it('refuses an agent connection of a missing OAuth client', async () => {
    await refuses('23503', `INSERT INTO oauth_connections (id, authorization_code_id, user_id, client_id, scopes) VALUES ($1, $2, $3, 'missing', '{}')`, [
      id('conn'),
      id('code'),
      owner,
    ])
  })

  it('removes the keys and connections of a deleted user, but refuses to delete a member', async () => {
    const user = id('user')
    const client = id('client')
    await insertUser(user)
    await insertClient(client)
    await run(`INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`, [id('key'), user, id('hash')])
    await run(`INSERT INTO oauth_connections (id, authorization_code_id, user_id, client_id, scopes) VALUES ($1, $2, $3, $4, '{}')`, [
      id('conn'),
      id('code'),
      user,
      client,
    ])
    await run(`DELETE FROM "user" WHERE id = $1`, [user])
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM apikey WHERE reference_id = $1)::int AS keys, (SELECT count(*) FROM oauth_connections WHERE user_id = $1)::int AS connections`,
      [user],
    )
    expect(left.rows[0]).toEqual({ keys: 0, connections: 0 })

    const member = id('user')
    await insertUser(member)
    await run(`INSERT INTO memberships (user_id, group_id) VALUES ($1, $2)`, [member, group])
    await refuses('23001', `DELETE FROM "user" WHERE id = $1`, [member])
  })
})

describe('value lists', () => {
  const insertExpense = (column: 'split_mode' | 'recurrence', value: string) =>
    tx(async (c) => {
      const e = id('e')
      await c.query(
        `INSERT INTO expenses (id, group_id, kind, title, expense_date, currency, amount, split_mode, recurrence) VALUES ($1, $2, 'expense', 'x', '2026-11-05', 'USD', 1, $3, $4)`,
        [e, group, column === 'split_mode' ? value : 'evenly', column === 'recurrence' ? value : 'none'],
      )
    })

  it('refuses an unknown split mode or recurrence, such as the current app enum names', async () => {
    // The constraint name matters: this expense has no payers, which the allocation trigger also refuses at commit.
    await expect(insertExpense('split_mode', 'EVENLY')).rejects.toMatchObject({ code: '23514', constraint: 'expenses_split_mode' })
    await expect(insertExpense('recurrence', 'yearly')).rejects.toMatchObject({ code: '23514', constraint: 'expenses_recurrence' })
  })

  it('refuses an unknown activity type', async () => {
    await refuses('23514', `INSERT INTO activities (id, group_id, type) VALUES ($1, $2, 'CREATE_GROUP')`, [id('act'), group])
  })

  it('refuses a role other than admin or member', async () => {
    const user = id('user')
    await insertUser(user)
    await refuses('23514', `INSERT INTO memberships (user_id, group_id, role) VALUES ($1, $2, 'owner')`, [user, group])
  })
})

describe('unique keys', () => {
  it('refuses to link one provider account to two users', async () => {
    const user = id('user')
    await insertUser(user)
    const insert = `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ($1, 'google-123', 'google', $2, now(), now())`
    await run(insert, [id('account'), owner])
    await refuses('23505', insert, [id('account'), user])
  })

  it('refuses two API keys with the same hash', async () => {
    const insert = `INSERT INTO apikey (id, reference_id, key, created_at, updated_at) VALUES ($1, $2, 'same-hash', now(), now())`
    await run(insert, [id('key'), owner])
    await refuses('23505', insert, [id('key'), owner])
  })

  it('refuses to link one OAuth client to one resource twice', async () => {
    const client = id('client')
    await insertClient(client)
    await run(`INSERT INTO oauth_resource (id, identifier, name) VALUES ($1, 'https://app.example/api/mcp', 'MCP')`, [id('resource')])
    const insert = `INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ($1, $2, 'https://app.example/api/mcp')`
    await run(insert, [id('link'), client])
    await refuses('23505', insert, [id('link'), client])
  })
})

describe('receipts', () => {
  it('refuses to change, delete or truncate a receipt row', async () => {
    const receipt = id('receipt')
    await run(`INSERT INTO receipts (id, group_id, url) VALUES ($1, $2, $3)`, [receipt, group, `https://app.example/api/receipts?key=${receipt}`])
    await refuses('23514', `UPDATE receipts SET created_by = 'someone' WHERE id = $1`, [receipt])
    await refuses('23514', `DELETE FROM receipts WHERE id = $1`, [receipt])
    await refuses('23514', `TRUNCATE receipts`)
  })
})
