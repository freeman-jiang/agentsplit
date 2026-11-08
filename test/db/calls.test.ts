// The call runner of RPC and MCP (src/server/calls.ts): work queued for after
// a write's commit, a write that conflicts on every attempt, the answer a
// database failure gets on RPC, and dates that do not exist. Each fails
// silently: a purge that runs for a rolled-back write deletes a receipt that
// stays, a busy write answered as an outage tells an agent that the outcome is
// unknown, a raw database error tells the client the schema, and a date
// answered as an outage tells an agent to retry it.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runRead, runWrite } from '~/server/calls'
import { BUSY, ERROR_ANSWERS, GROUP_DENIED, UNAVAILABLE } from '~/shared/errors'
import { draft } from '../kit/drafts'
import { counter, id21Counter } from '../kit/ids'
import { principal } from '../kit/people'
import { BASE, startHarness, webRpc, type Harness } from './harness'

let h: Harness
let cookie: string
beforeAll(async () => {
  h = await startHarness()
  cookie = (await h.account('alice', { name: 'Alice' })).cookie
  await h.group({ id: 'g1', name: 'Home', people: ['pa'], members: [['alice', 'pa', 'admin']] })
})
afterAll(() => h.close())

const call = { name: 'calls.test' }
const alice = principal('alice')

describe('work after the commit', () => {
  it('runs once after a write that was retried, with only the last attempt’s work', async () => {
    const ran: number[] = []
    let attempts = 0
    await h.withDb((db) =>
      runWrite({
        db,
        principal: alice,
        call,
        work: async (tx, afterCommit) => {
          const attempt = ++attempts
          afterCommit(async () => void ran.push(attempt))
          // The first attempt fails as a concurrent SERIALIZABLE write would.
          if (attempt === 1) await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'could not serialize access' USING ERRCODE = 'serialization_failure'; END $$`)
        },
      }),
    )
    expect({ attempts, ran }).toEqual({ attempts: 2, ran: [2] })
  })

  it('does not run for a write that rolled back', async () => {
    const ran: string[] = []
    const write = h.withDb((db) =>
      runWrite({
        db,
        principal: alice,
        call,
        work: async (tx, afterCommit) => {
          afterCommit(async () => void ran.push('purge'))
          await tx.execute(sql`SELECT 1 / 0`)
        },
      }),
    )
    await expect(write).rejects.toMatchObject({ _tag: 'Unavailable' })
    expect(ran).toEqual([])
  })
})

describe('a write that conflicts on every attempt', () => {
  it('stops after 10 attempts and answers busy, so the caller knows that nothing changed and can retry', async () => {
    let attempts = 0
    const write = h.withDb((db) =>
      runWrite({
        db,
        principal: alice,
        call,
        work: async (tx) => {
          attempts++
          await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'could not serialize access' USING ERRCODE = 'serialization_failure'; END $$`)
        },
      }),
    )
    await expect(write).rejects.toMatchObject({ _tag: 'Invalid', reason: 'busy', message: BUSY })
    expect(attempts).toBe(10)
    expect(ERROR_ANSWERS['Invalid.busy']).toEqual({ answer: true, mcp: 'CONFLICT', recovery: 'retry_later', http: 409 })
  })
})

describe('database failures over RPC', () => {
  const expenseId = id21Counter('c')
  const keys = counter('rpc-key')
  /** expenses.create over RPC with a draft titled `title`; returns the exit as JSON text. */
  const create = async (title: string) => {
    const { exit } = await webRpc(h, {
      tag: 'expenses.create',
      cookie,
      payload: { groupId: 'g1', expenseId: expenseId(), idempotencyKey: `${keys()}-0000`, expense: draft({ payer: 'pa', people: ['pa'], title }) },
    })
    return { tag: exit._tag, text: JSON.stringify(exit) }
  }

  it('answers a database rule as Invalid, and any other failure as Unavailable, without the database’s text', async () => {
    await h.withDb((db) =>
      db.execute(sql`
        ALTER TABLE expenses ADD CONSTRAINT refused_for_test CHECK (title <> 'Refused by the database') NOT VALID;
        CREATE FUNCTION fail_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'secret_table_detail'; END $$;
        CREATE TRIGGER fail_for_test BEFORE INSERT ON expenses FOR EACH ROW WHEN (NEW.title = 'Broken') EXECUTE FUNCTION fail_for_test();`),
    )
    try {
      const refused = await create('Refused by the database')
      expect(refused.tag).toBe('Failure')
      expect(refused.text).toContain('"_tag":"Invalid"')
      expect(refused.text).toContain('The change breaks a rule of the ledger.')
      expect(refused.text).not.toContain('refused_for_test')

      const broken = await create('Broken')
      expect(broken.tag).toBe('Failure')
      expect(broken.text).toContain('"_tag":"Unavailable"')
      expect(broken.text).toContain(UNAVAILABLE)
      expect(broken.text).not.toContain('secret_table_detail')
    } finally {
      await h.withDb((db) => db.execute(sql`ALTER TABLE expenses DROP CONSTRAINT refused_for_test; DROP TRIGGER fail_for_test ON expenses; DROP FUNCTION fail_for_test();`))
    }
  })
})

describe('group references', () => {
  it('denies a reference with a NUL byte, which PostgreSQL text cannot hold, on RPC and the export route', async () => {
    const { exit } = await webRpc(h, { tag: 'groups.get', cookie, payload: { groupId: 'g1\u0000x' } })
    expect(JSON.stringify(exit)).toContain(GROUP_DENIED)
    const download = await h.fetch(new Request(`${BASE}/groups/g1%00x/expenses/export/json`, { headers: { cookie } }))
    expect(download.status).toBe(403)
  })
})

describe('dates and times that do not exist', () => {
  // Bun's Date.parse rolls 2026-02-30 into March, but PostgreSQL refuses the cast.
  const day = '2026-02-30'
  const time = `${day}T12:00:00Z`
  let key: Record<string, string>
  beforeAll(async () => {
    key = { 'x-api-key': await h.apiKey('alice') }
  })

  it('refuses them on RPC as a request problem', async () => {
    const tampered = btoa(JSON.stringify({ k: day, c: '2026-01-01T00:00:00.000000Z', i: 'e1' }))
    const calls = [
      { tag: 'history.balances', payload: { groupId: 'g1', asOf: time } },
      { tag: 'history.activities', payload: { groupId: 'g1', limit: 5, recordedFrom: time } },
      { tag: 'feed.list', payload: { filter: {}, limit: 5, cursor: { date: '2026-01-01', createdAt: '2026-01-01T25:00:00Z', id: 'e1' } } },
      { tag: 'feed.list', payload: { filter: {}, limit: 5, cursor: { date: '2026-01-01', createdAt: `${day}T00:00:00Z`, id: 'e1' } } },
      { tag: 'expenses.list', payload: { groupId: 'g1', filter: {}, cursor: tampered, limit: 5 } },
    ]
    const outages = []
    for (const c of calls) {
      const { exit } = await webRpc(h, { ...c, cookie })
      if (exit._tag !== 'Failure' || JSON.stringify(exit).includes('Unavailable')) outages.push(c)
    }
    expect(outages).toEqual([])
  })

  it('refuses them on MCP as a request problem', async () => {
    const calls = [
      { name: 'get_balances', args: { groupId: 'g1', asOf: time } },
      { name: 'list_activity', args: { groupId: 'g1', recordedTo: time } },
      { name: 'list_receipts', args: { olderThan: time } },
      { name: 'list_all_expenses', args: { cursor: { date: day, createdAt: '2026-01-01T00:00:00.000000Z', id: 'e1' } } },
      { name: 'list_all_expenses', args: { cursor: { date: `${day}T00:00:00.000Z`, createdAt: '2026-01-01T00:00:00.000000Z', id: 'e1' } } },
    ]
    const outages = []
    for (const c of calls) if ((await h.mcp.failure({ ...c, headers: key })).code === 'INTERNAL_SERVER_ERROR') outages.push(c)
    expect(outages).toEqual([])
  })

  it('answers a value that the database cannot read as Invalid, also on a read', async () => {
    const read = h.withDb((db) => runRead({ db, call, work: (d) => d.execute(sql`SELECT ${day}::date`) }))
    await expect(read).rejects.toMatchObject({ _tag: 'Invalid' })
  })
})
