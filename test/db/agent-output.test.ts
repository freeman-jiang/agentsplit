// The server and agent gaps of the parity audit (docs/v2/parity/AUDIT.md), and
// Freeman's agent-output decision, against a real database: private-context
// history and links, exports with agent credentials, one source name, one
// group-denied message, baselines in attribution, historical names, and the
// text of expense events.
import { sql } from 'drizzle-orm'
import { Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, expensePayers, expenses, expenseShares } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { listActivities } from '~/server/history'
import { getGroup } from '~/server/ledger'
import { type Principal } from '~/server/core/access'
import { V2GroupSnapshot } from '~/shared/snapshots'
import { randomId } from '~/server/core/ids'
import { minor } from '~/shared/minor'
import { BASE, failure, ok, startHarness, type Harness } from './mcp-harness'

let h: Harness
let alice: Record<string, string>
let aliceCookie: string
let bobCookie: string

const DENIED = 'Group not found, or you are not a member'
const web = (id: string): Principal => ({ userId: id, name: id, email: `${id}@example.com`, source: 'web', agentKeyId: null })
const id21 = (n: number) => `a${String(n).padStart(20, '0')}`

beforeAll(async () => {
  h = await startHarness()
  aliceCookie = (await h.account('alice', { name: 'Alice' })).cookie
  bobCookie = (await h.account('bob', { name: 'Bob' })).cookie
  await h.group({ id: 'g1', name: 'Home', people: ['pa', 'pb'], members: [['alice', 'pa', 'admin'], ['bob', 'pb', 'member']] })
  await h.group({ id: 'g3', name: 'Bob only', people: ['rb'], members: [['bob', 'rb', 'admin']] })
  await h.privateContext({ owner: 'alice', expenseId: 'private-dinner' })
  alice = { 'x-api-key': await h.apiKey('alice') }
})
afterAll(() => h.close())

const create = (data: { id: number; title?: string; vendor?: string }) =>
  ok(h, {
    name: 'create_expense',
    args: {
      groupId: 'g1',
      expenseId: id21(data.id),
      expense: {
        title: data.title ?? 'Dinner',
        ...(data.vendor ? { vendor: data.vendor } : {}),
        expenseDate: '2026-11-01',
        amount: '30',
        currencyCode: 'USD',
        paidBy: 'pa',
        paidFor: [{ participant: 'pa', shares: '1' }, { participant: 'pb', shares: '1' }],
        isReimbursement: false,
      },
    },
    headers: alice,
  })

type Activity = { id: string; activityType: string; data: string | null; source: string; expenseRevision: number | null; snapshot: Record<string, unknown> | null }
const log = async (args: Record<string, unknown>) => (await ok(h, { name: 'list_activity', args: { order: 'asc', limit: 100, ...args }, headers: alice }))['activities'] as Activity[]
const download = (path: string, headers: Record<string, string> = {}) => h.app.fetch(new Request(`${BASE}${path}`, { headers }))

describe('private contexts', () => {
  it('stores the create_group snapshot in the shape the history reader expects (P-HIST-03)', async () => {
    const [row] = await h.withDb((db) => db.execute<{ snapshot: unknown }>(sql`SELECT snapshot FROM activities WHERE group_id = 'private-dinner' AND type = 'create_group'`)).then((r) => r.rows)
    const snapshot = Schema.decodeUnknownSync(V2GroupSnapshot)(row?.snapshot, { onExcessProperty: 'error' })
    expect(snapshot.group).toMatchObject({ id: 'private-dinner', name: 'Private dinner', slug: null, currency: 'USD', information: '', revision: 1 })
  })

  it('reads the Log and list_activity of a context whose snapshot has the shape stored before the fix (P-HIST-03)', async () => {
    await h.privateContext({ owner: 'alice', expenseId: 'old-dinner' })
    // The shape that v2 stored until the fix: the group row, with defaultCurrency and no currency. Activities are permanent.
    await h.withDb((db) =>
      db.insert(activities).values({
        id: randomId(),
        groupId: 'old-dinner',
        type: 'create_group',
        data: 'Private expense',
        snapshot: {
          schemaVersion: 2,
          kind: 'group',
          group: { id: 'old-dinner', kind: 'private', slug: null, name: 'Private dinner', defaultCurrency: 'EUR', revision: 1, information: '', participants: [{ id: 'old-dinner_me', name: 'alice' }] },
        },
        source: 'web',
        actorName: 'alice',
        actorUserId: 'alice',
      }),
    )
    const page = await h.withDb((db) => listActivities(db, { principal: web('alice'), groupId: 'old-dinner', limit: 10 }))
    const groupStates = page.activities.flatMap((a) => (a.snapshot?._tag === 'group' ? [a.snapshot.group.currency] : []))
    expect(groupStates.sort()).toEqual(['EUR', 'USD'])
    const events = await log({ groupId: 'old-dinner' })
    expect(events.filter((a) => a.activityType === 'CREATE_GROUP').map((a) => (a.snapshot?.['group'] as { currencyCode: string }).currencyCode).sort()).toEqual(['EUR', 'USD'])
  })

  it('tells the client the expense of a private context, and get_group links to the expense page (P-GROUP-47, P-UNGROUP-39)', async () => {
    expect(await h.withDb((db) => getGroup(db, { principal: web('alice'), groupId: 'private-dinner' }))).toMatchObject({ contextExpenseId: 'private-dinner' })
    expect(await h.withDb((db) => getGroup(db, { principal: web('alice'), groupId: 'g1' }))).toMatchObject({ contextExpenseId: null })
    const context = await ok(h, { name: 'get_group', args: { groupId: 'private-dinner' }, headers: alice })
    expect(context['links']).toEqual({
      share: `${BASE}/expenses/private-dinner`,
      csv: `${BASE}/groups/private-dinner/expenses/export/csv`,
      json: `${BASE}/groups/private-dinner/expenses/export/json`,
    })
  })
})

describe('exports', () => {
  it('accept an API key in X-API-Key or Authorization, and the session cookie without one (P-EXPORT-05, P-AUTH-47)', async () => {
    const json = await download('/groups/g1/expenses/export/json', alice)
    expect(json.status).toBe(200)
    expect(json.headers.get('cache-control')).toBe('private, no-store')
    expect(((await json.json()) as { id: string }).id).toBe('g1')
    const csv = await download('/groups/g1/expenses/export/csv', { authorization: `Bearer ${alice['x-api-key']}` })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect((await download('/groups/g1/expenses/export/json', { cookie: aliceCookie })).status).toBe(200)
  })

  it('ignore the session cookie when an agent credential is sent (P-AUTH-45)', async () => {
    const bad = await download('/groups/g1/expenses/export/json', { 'x-api-key': 'agentsplit_not-a-real-key-0123456789abcdef', cookie: aliceCookie })
    expect(bad.status).toBe(401)
    expect(await bad.json()).toEqual({ error: 'Sign in required' })
    expect((await download('/groups/g1/expenses/export/json')).status).toBe(401)
  })

  it('give one message for a missing group and a group of someone else (P-EXPORT-16, P-TOOL-EXPORT-04)', async () => {
    for (const path of ['/groups/g3/expenses/export/json', '/groups/missing-group/expenses/export/csv']) {
      const denied = await download(path, alice)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: DENIED })
    }
    expect((await download('/groups/g3/expenses/export/json', { cookie: bobCookie })).status).toBe(200)
    for (const groupId of ['g3', 'missing-group']) {
      const denied = await failure(h, { name: 'export_group', args: { groupId }, headers: alice })
      expect(denied).toMatchObject({ code: 'FORBIDDEN', message: DENIED, outcomeUnknown: false })
    }
  })
})

describe('agent writes and their history', () => {
  it('stores agent writes as `agent`, and shows rows stored as `mcp` as `agent` everywhere (P-DB-79)', async () => {
    await create({ id: 1, title: 'Coffee', vendor: 'Cafe' })
    const [stored] = await h.withDb((db) => db.execute<{ source: string }>(sql`SELECT source FROM activities WHERE expense_id = ${id21(1)}`)).then((r) => r.rows)
    expect(stored?.source).toBe('agent')
    // A row as v2 wrote it before the fix: source `mcp` and no text.
    await h.withDb((db) =>
      db.insert(activities).values({ id: randomId(), groupId: 'g1', type: 'update_expense', expenseId: id21(1), source: 'mcp', actorName: 'Bob', actorUserId: 'bob', agentKeyId: 'old-key' }),
    )
    const events = await log({ groupId: 'g1', expenseId: id21(1) })
    expect(events.map((a) => a.source)).toEqual(['agent', 'agent'])
    const expense = (await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(1) }, headers: alice }))['expense'] as { attribution: Record<string, { source: string } | null> }
    expect(expense.attribution['updatedBy']).toEqual({ userId: 'bob', name: 'Bob', source: 'agent' })
    const feed = (await ok(h, { name: 'list_all_expenses', args: { involvingMe: false }, headers: alice }))['expenses'] as { id: string; attribution: Record<string, { source: string } | null> }[]
    expect(feed.find((e) => e.id === id21(1))?.attribution['updatedBy']?.source).toBe('agent')
    const exported = (await (await download('/groups/g1/expenses/export/json', alice)).json()) as { activities: { expenseId: string | null; source: string; data: string | null }[] }
    expect(exported.activities.filter((a) => a.expenseId === id21(1))).toEqual([
      expect.objectContaining({ source: 'agent', data: 'Cafe — Coffee' }),
      // The text of a row stored without one comes from the last saved revision (P-EXP-107).
      expect.objectContaining({ source: 'agent', data: 'Cafe — Coffee' }),
    ])
  })

  it('stores "<vendor> — <title>" on every expense event, as the current app (P-EXP-107)', async () => {
    const created = await create({ id: 2, title: 'Pizza' })
    await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: created['revision'], changes: { vendor: 'Luigi' } }, headers: alice })
    await ok(h, { name: 'delete_expense', args: { groupId: 'g1', expenseId: id21(2), expectedRevision: 2 }, headers: alice })
    const events = await log({ groupId: 'g1', expenseId: id21(2) })
    expect(events.map((a) => [a.activityType, a.data])).toEqual([
      ['CREATE_EXPENSE', 'Pizza'],
      ['UPDATE_EXPENSE', 'Luigi — Pizza'],
      ['DELETE_EXPENSE', 'Luigi — Pizza'],
    ])
    const [row] = await h.withDb((db) => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM activities WHERE expense_id = ${id21(2)} AND data IS NULL`)).then((r) => r.rows)
    expect(row?.n).toBe(0)
  })

  it('does not count a v2 baseline as an edit (P-HIST-09, P-DB-16)', async () => {
    // An expense that predates history: revision 0 and no events.
    const id = id21(3)
    await h.withDb((db) =>
      db.transaction(async (tx) => {
        await tx.insert(expenses).values({ id, groupId: 'g1', revision: 0, kind: 'expense', title: 'Legacy', vendor: null, notes: '', categoryId: 0, expenseDate: '2026-10-01', currency: 'USD', amount: minor(1000n), splitMode: 'evenly' })
        await tx.insert(expensePayers).values({ expenseId: id, groupId: 'g1', participantId: 'pa', amount: minor(1000n) })
        await tx.insert(expenseShares).values({ expenseId: id, groupId: 'g1', participantId: 'pa', amount: minor(1000n), weight: '1' })
      }),
    )
    await ok(h, { name: 'update_expense', args: { groupId: 'g1', expenseId: id, expectedRevision: 0, changes: { title: 'Legacy, edited' } }, headers: alice })
    const [baseline, edit] = await log({ groupId: 'g1', expenseId: id })
    expect(baseline).toMatchObject({ activityType: 'UPDATE_EXPENSE', expenseRevision: 0, data: 'Legacy' })
    expect(edit).toMatchObject({ expenseRevision: 1, data: 'Legacy, edited' })
    const atBaseline = (await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id, atActivityId: baseline?.id }, headers: alice }))['expense'] as { attribution: Record<string, unknown> }
    expect(atBaseline.attribution).toMatchObject({ createdBy: null, updatedBy: null })
    const live = (await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id }, headers: alice }))['expense'] as { attribution: Record<string, unknown> }
    expect(live.attribution).toMatchObject({ createdBy: null, updatedBy: { userId: 'alice', name: 'Alice', source: 'agent' } })
  })

  it('names the authors of a historical read as recorded then, and of a live read as now (P-FEED-40)', async () => {
    await create({ id: 4, title: 'Tea' })
    await h.withDb((db) => db.update(user).set({ name: 'Alice Renamed' }).where(sql`${user.id} = 'alice'`))
    const live = (await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(4) }, headers: alice }))['expense'] as { attribution: { createdBy: { name: string } } }
    expect(live.attribution.createdBy.name).toBe('Alice Renamed')
    const saved = (await ok(h, { name: 'get_expense', args: { groupId: 'g1', expenseId: id21(4), revision: 1 }, headers: alice }))['expense'] as { attribution: { createdBy: { name: string } } }
    expect(saved.attribution.createdBy.name).toBe('Alice')
  })
})
