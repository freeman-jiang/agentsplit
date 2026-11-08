// The call runner of RPC and MCP (src/server/calls.ts): work queued for after
// a write's commit, and the answer a database failure gets on RPC. Both fail
// silently: a purge that runs for a rolled-back write deletes a receipt that
// stays, and a raw database error tells the client the schema.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runWrite } from '~/server/calls'
import { GROUP_DENIED, UNAVAILABLE } from '~/shared/errors'
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
