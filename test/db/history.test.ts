// History reads against a real database. The scenarios port the current app's
// scripts/test-history-queries.ts and scripts/test-expense-history.ts. The v1
// rows are synthetic, in the format the importer wrote (history-fixtures.ts).
import { eq, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, expensePayers, expenses, expenseShares, groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { savedBalances } from '~/server/balances'
import { getSavedExpense, historicalLedger, listActivities, listSavedExpenses } from '~/server/history'
import { createExpense, deleteExpense, getExpense, updateExpense } from '~/server/ledger'
import { RecordedTime } from '~/shared/api'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { describeRevision } from '~/shared/history'
import { minor } from '~/shared/minor'
import { insertImportedExpense, v1GroupSnapshot } from './history-fixtures'
import { testDatabase, type TestDatabase } from '../kit/database'
import { draft } from '../kit/drafts'
import { counter } from '../kit/ids'
import { principal, userRows } from '../kit/people'
import { waitFor } from '../kit/wait'

let database: TestDatabase
const alice = principal('u-alice', { name: 'Alice Account' })
const agent = principal('u-alice', { name: 'Alice Account', source: 'agent', agentKeyId: 'key-123' })
const other = principal('u-other', { name: 'Other' })

const tx: TestDatabase['tx'] = (work) => database.tx(work)
/** Waits until the database clock is past the millisecond of `event`, so the next event has a later recorded time. */
const after = (event: Event) =>
  waitFor(async () => (await database.pool.query<{ past: boolean }>(`SELECT date_trunc('milliseconds', clock_timestamp()) > $1::timestamptz AS past`, [event.time])).rows[0]?.past === true, {
    what: `a time after ${event.time}`,
  })
const key = counter('key-history')
const next = counter('h')

type Group = { id: string; alice: string; bob: string; created: string }

/** A group "Home" of Alice and Bob from 2019, with its v1 creation event. Alice is its admin. */
async function newGroup(id = next()): Promise<Group> {
  const g = { id, alice: `${id}-a`, bob: `${id}-b`, created: `${id}-created` }
  const people = [
    { id: g.alice, name: 'Alice' },
    { id: g.bob, name: 'Bob' },
  ]
  await tx(async (db) => {
    await db.insert(groups).values({ id, kind: 'named', slug: id, name: 'Home', defaultCurrency: 'USD', createdAt: new Date('2019-06-01T00:00:00Z') })
    await db.insert(participants).values(people.map((p) => ({ ...p, groupId: id })))
    await db.insert(memberships).values({ userId: alice.userId, groupId: id, role: 'admin', participantId: g.alice })
    await db.insert(activities).values({
      id: g.created,
      groupId: id,
      time: new Date('2019-06-01T00:00:00Z'),
      type: 'create_group',
      data: 'Home',
      snapshot: v1GroupSnapshot({ id, name: 'Home', slug: id, information: 'Our flat', participants: people }),
      actorName: alice.name,
      actorUserId: alice.userId,
    })
  })
  return g
}

/** A dinner of 60 that Alice pays and shares evenly with Bob. */
const dinner = (data: { group: Group } & Partial<ExpenseDraft>) => {
  const { group, ...over } = data
  return draft({ payer: group.alice, people: [group.alice, group.bob], title: 'Original dinner', notes: 'original', expenseDate: '2020-01-01', amount: '60', ...over })
}
const create = (data: { group: Group; expenseId: string } & Partial<ExpenseDraft>) => {
  const { expenseId, ...expense } = data
  return tx((db) => createExpense(db, { principal: alice, groupId: data.group.id, expenseId, idempotencyKey: key(), expense: dinner(expense) }))
}
const update = (data: { group: Group; expenseId: string; expectedRevision: number } & Partial<ExpenseDraft>) => {
  const { expenseId, expectedRevision, ...expense } = data
  return tx((db) => updateExpense(db, { principal: alice, groupId: data.group.id, expenseId, expectedRevision, idempotencyKey: key(), expense: dinner(expense) }))
}

/** An expense row of 12.00 without any history, as imported rows are before their baseline. */
async function insertLegacy(g: Group): Promise<string> {
  const id = next()
  await tx(async (db) => {
    await db.insert(expenses).values({ id, groupId: g.id, revision: 0, kind: 'expense', title: 'Legacy unknown history', categoryId: 0, expenseDate: '2001-01-01', currency: 'USD', amount: minor(1200n), splitMode: 'evenly', createdAt: new Date('2001-01-01T00:00:00Z') })
    await db.insert(expensePayers).values({ expenseId: id, groupId: g.id, participantId: g.alice, amount: minor(1200n) })
    await db.insert(expenseShares).values([g.alice, g.bob].map((participantId) => ({ expenseId: id, groupId: g.id, participantId, amount: minor(600n), weight: '1' })))
  })
  return id
}

type Event = { id: string; time: string }
async function latestEvent(groupId: string): Promise<Event> {
  const [row] = await tx((db) =>
    db.execute<Event>(sql`SELECT id, to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time FROM activities WHERE group_id = ${groupId} ORDER BY sequence DESC LIMIT 1`),
  ).then((r) => r.rows)
  if (!row) throw new Error('No event')
  return row
}
async function counts() {
  return tx(async (db) => ({
    activities: (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM activities`)).rows[0]?.n,
    revisions: (await db.select({ id: expenses.id, revision: expenses.revision }).from(expenses).orderBy(expenses.id)).map((e) => `${e.id}:${e.revision}`),
  }))
}

// The read-only fixture: in g1, e1 is created, edited by an agent and deleted,
// and Bob is renamed between the edit and the deletion. "later" stays live.
let home: Group
let creation: Event, initial: Event, edited: Event, deletion: Event

beforeAll(async () => {
  database = await testDatabase()
  await tx(async (db) => {
    await db.insert(user).values(userRows([alice, other]))
    await db.insert(groups).values([
      { id: 'g2', kind: 'named', slug: 'imported', name: 'Imported', defaultCurrency: 'USD', createdAt: new Date('2019-06-01T00:00:00Z') },
      { id: 'other', kind: 'named', slug: null, name: 'Other', defaultCurrency: 'USD' },
    ])
    await db.insert(participants).values([
      { id: 'qa', groupId: 'g2', name: 'Ann' },
      { id: 'qb', groupId: 'g2', name: 'Ben' },
      { id: 'qc', groupId: 'g2', name: 'Cal' },
      { id: 'oa', groupId: 'other', name: 'Other' },
    ])
    await db.insert(memberships).values([
      { userId: alice.userId, groupId: 'g2', role: 'admin', participantId: 'qa' },
      { userId: other.userId, groupId: 'other', role: 'admin', participantId: 'oa' },
    ])
    await db.insert(activities).values({ id: 'act-create-other', groupId: 'other', time: new Date('2019-06-01T00:00:00Z'), type: 'create_group', data: 'Other' })
  })
  home = await newGroup('g1')
  creation = await latestEvent(home.id)
  await create({ group: home, expenseId: 'e1' })
  initial = await latestEvent(home.id)
  await after(initial)
  await tx((db) => updateExpense(db, { principal: agent, groupId: home.id, expenseId: 'e1', expectedRevision: 1, idempotencyKey: key(), expense: dinner({ group: home, amount: '90', notes: 'edited' }) }))
  edited = await latestEvent(home.id)
  await after(edited)
  // A rename changes current names only; snapshots keep the names they saved.
  await tx((db) => db.update(participants).set({ name: 'Renamed Bob' }).where(eq(participants.id, home.bob)))
  await tx((db) => deleteExpense(db, { principal: alice, groupId: home.id, expenseId: 'e1', expectedRevision: 2, idempotencyKey: key() }))
  deletion = await latestEvent(home.id)
  await create({ group: home, expenseId: 'later', title: 'Later backdated entry' })
})
afterAll(async () => {
  await database.close()
})

describe('saved revisions (P-HIST-44 to P-HIST-49)', () => {
  it('returns the values and names of a revision', async () => {
    const r = await tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', revision: 1 }))
    expect(r.expense.amount).toBe('60.00')
    expect(r.expense.payers[0]?.name).toBe('Alice')
    expect(r.expense.shares.find((s) => s.participantId === home.bob)?.name).toBe('Bob')
    expect(r.history).toMatchObject({ revision: 1, deleted: false })
    expect(r.deletedAt).toBeNull()
  })

  it('returns the revision in effect at a time, after later edits and the deletion', async () => {
    const r = await tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', asOf: initial.time }))
    expect(r.expense.amount).toBe('60.00')
    expect(r.history.activityId).toBe(initial.id)
  })

  it('returns the last saved state for the deletion revision', async () => {
    const r = await tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', revision: 3 }))
    expect(r.expense.amount).toBe('90.00')
    expect(r.expense.revision).toBe(2)
    expect(r.history).toMatchObject({ revision: 3, deleted: true })
    expect(r.deletedAt).toBe(deletion.time)
  })

  it('keeps hiding a deleted expense from current reads (P-HIST-07, P-HIST-88)', async () => {
    await expect(tx((db) => getExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1' }))).rejects.toMatchObject({ _tag: 'NotFound' })
  })

  it('accepts only one selector and reports a missing revision', async () => {
    await expect(tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', revision: 1, asOf: initial.time }))).rejects.toMatchObject({ _tag: 'Invalid' })
    await expect(tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', revision: 55 }))).rejects.toMatchObject({ _tag: 'NotFound' })
  })
})

describe('the ledger at a boundary (P-HIST-50 to P-HIST-58)', () => {
  it('does not infer an expense from its expense date', async () => {
    const page = await tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', atActivityId: creation.id, filter: {} }))
    expect(page.expenses).toEqual([])
    expect(page.history.complete).toBe(true)
  })

  it('shows the expense before its deletion and not after', async () => {
    const before = await tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', atActivityId: edited.id, filter: {} }))
    expect(before.expenses.map((e) => e.amount)).toEqual(['90.00'])
    const after = await tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', atActivityId: deletion.id, filter: {} }))
    expect(after.expenses).toEqual([])
  })

  it('computes balances from the saved splits', async () => {
    const at = async (atActivityId: string) =>
      (await tx((db) => savedBalances(db, { principal: alice, groupId: 'g1', atActivityId }))).balances.map((b) => [b.participantId, b.net])
    expect(await at(initial.id)).toEqual([
      [home.alice, '30.00'],
      [home.bob, '-30.00'],
    ])
    expect(await at(edited.id)).toEqual([
      [home.alice, '45.00'],
      [home.bob, '-45.00'],
    ])
  })

  it('filters saved values before paging', async () => {
    const list = (filter: Parameters<typeof listSavedExpenses>[1]['filter']) =>
      tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', atActivityId: initial.id, filter, limit: 1 }))
    expect((await list({ search: 'original', currency: 'USD', from: '2020-01-01', to: '2020-01-01', participantId: home.bob })).expenses).toHaveLength(1)
    expect((await list({ currency: 'JPY' })).expenses).toHaveLength(0)
    expect((await list({ payerId: home.bob })).expenses).toHaveLength(0)
  })

  it('rejects bad boundaries', async () => {
    await expect(tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', asOf: '2999-01-01T00:00:00Z', filter: {} }))).rejects.toMatchObject({ message: 'asOf cannot be in the future' })
    await expect(tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', asOf: '2000-01-01T00:00:00Z', filter: {} }))).rejects.toMatchObject({ _tag: 'NotFound', entity: 'groupAtTime' })
    await expect(tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', atActivityId: 'act-create-other', filter: {} }))).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'other', asOf: initial.time, filter: {} }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(tx((db) => getSavedExpense(db, { principal: alice, groupId: 'other', expenseId: 'e1', revision: 1 }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('accepts only timestamps with a time zone and at most milliseconds (P-HIST-40)', () => {
    const valid = Schema.is(RecordedTime)
    expect(valid('2026-10-01T15:00:00Z')).toBe(true)
    expect(valid('2026-10-01T15:00:00.123+02:00')).toBe(true)
    expect(valid('2026-10-01')).toBe(false)
    expect(valid('2026-10-01T00:00:00.123456Z')).toBe(false)
    expect(valid('2026-10-01T00:00:00')).toBe(false)
  })

  it('keeps currencies separate and frozen after a currency edit (P-HIST-58)', async () => {
    const g = await newGroup()
    const ramen = next()
    await create({ group: g, expenseId: next() })
    await create({ group: g, expenseId: ramen, title: 'Ramen', amount: '100', currency: 'JPY' })
    const head = await latestEvent(g.id)
    const before = await tx((db) => savedBalances(db, { principal: alice, groupId: g.id, atActivityId: head.id }))
    expect([...new Set(before.balances.map((b) => b.currency))]).toEqual(['JPY', 'USD'])
    await update({ group: g, expenseId: ramen, expectedRevision: 1, title: 'Ramen', amount: '100' })
    expect(await tx((db) => savedBalances(db, { principal: alice, groupId: g.id, atActivityId: head.id }))).toEqual(before)
    const now = await tx((db) => savedBalances(db, { principal: alice, groupId: g.id, asOf: new Date().toISOString() }))
    expect([...new Set(now.balances.map((b) => b.currency))]).toEqual(['USD'])
  })

  it('pages a saved boundary stably after live edits reorder expenses (P-HIST-55)', async () => {
    const g = await newGroup()
    const moved = next()
    await create({ group: g, expenseId: next(), expenseDate: '2001-01-01' })
    await create({ group: g, expenseId: moved, expenseDate: '2020-01-01' })
    const head = await latestEvent(g.id)
    const page = (data: Pick<Parameters<typeof listSavedExpenses>[1], 'limit' | 'cursor'>) => tx((db) => listSavedExpenses(db, { principal: alice, groupId: g.id, atActivityId: head.id, filter: {}, ...data }))
    const all = await page({ limit: 100 })
    const first = await page({ limit: 1 })
    // The edit moves the newest expense behind the other one in the live order.
    await update({ group: g, expenseId: moved, expectedRevision: 1, expenseDate: '2000-01-01' })
    const second = await page({ limit: 1, cursor: first.nextCursor })
    expect([first.expenses[0]?.id, second.expenses[0]?.id]).toEqual(all.expenses.map((e) => e.id))
  })
})

describe('the Log (P-HIST-28 to P-HIST-39)', () => {
  it('keeps pages fixed at the returned boundary while events are added', async () => {
    const g = await newGroup()
    const expenseId = next()
    await create({ group: g, expenseId })
    await update({ group: g, expenseId, expectedRevision: 1, amount: '90' })
    const first = await tx((db) => listActivities(db, { principal: alice, groupId: g.id, limit: 1 }))
    const boundary = first.atActivityId ?? ''
    const full = await tx((db) => listActivities(db, { principal: alice, groupId: g.id, limit: 100, atActivityId: boundary }))
    const added = next()
    await create({ group: g, expenseId: added })
    const page = await tx((db) => listActivities(db, { principal: alice, groupId: g.id, limit: 1, cursor: first.nextCursor, atActivityId: boundary }))
    expect(page.activities[0]?.id).toBe(full.activities[1]?.id)
    const frozen = await tx((db) => listActivities(db, { principal: alice, groupId: g.id, limit: 100, atActivityId: boundary }))
    expect(frozen.activities.some((a) => a.expenseId === added)).toBe(false)
    expect(frozen.activities.map((a) => a.id)).toEqual(full.activities.map((a) => a.id))
  })

  it('filters by recording time in either order and caps at asOf', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', expenseId: 'e1', recordedFrom: edited.time, recordedTo: deletion.time, order: 'asc' }))
    expect(r.activities.map((a) => a.expenseRevision)).toEqual([2, 3])
    const capped = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', expenseId: 'e1', asOf: initial.time }))
    expect(capped.activities.map((a) => a.expenseRevision)).toEqual([1])
    await expect(tx((db) => listActivities(db, { principal: alice, groupId: 'g1', recordedFrom: deletion.time, recordedTo: initial.time }))).rejects.toMatchObject({ _tag: 'Invalid' })
    await expect(tx((db) => listActivities(db, { principal: alice, groupId: 'g1', from: '2026-02-01', to: '2026-01-01' }))).rejects.toMatchObject({ message: 'from must be on or before to' })
  })

  it('filters by UTC recording day and type', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', from: today, to: today, type: 'update_expense', limit: 100 }))
    expect(r.activities.map((a) => a.expenseRevision)).toEqual([2])
    const old = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', from: '2019-06-01', to: '2019-06-01' }))
    expect(old.activities.map((a) => a.type)).toEqual(['create_group'])
  })

  it('never attaches live expense state to a historical read', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', asOf: initial.time, limit: 100 }))
    expect(r.activities.every((a) => a.expense === null)).toBe(true)
    expect(JSON.stringify(r)).not.toContain('Later backdated entry')
    const current = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', limit: 100 }))
    expect(current.activities.find((a) => a.expenseId === 'later')?.expense).toEqual({ kind: 'expense' })
    // A deleted expense has no live state, so its events do not link (P-HIST-70).
    expect(current.activities.filter((a) => a.expenseId === 'e1').every((a) => a.expense === null)).toBe(true)
  })

  it('returns the deletion first, with the last saved state as the previous snapshot (P-HIST-39)', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', expenseId: 'e1', limit: 100 }))
    const [first] = r.activities
    expect(first).toMatchObject({ type: 'delete_expense', snapshot: null })
    expect(first?.previousSnapshot?._tag === 'expense' && first.previousSnapshot.expense.amount).toBe('90.00')
  })

  it('reports who made each change without user IDs', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', expenseId: 'e1', order: 'asc', limit: 100 }))
    expect(r.activities.map((a) => [a.actorName, a.verified, a.agent])).toEqual([
      ['Alice Account', true, false],
      ['Alice Account', true, true],
      ['Alice Account', true, false],
    ])
    expect(JSON.stringify(r)).not.toContain('u-alice')
    expect(JSON.stringify(r)).not.toContain('key-123')
  })

  it('returns nothing for an expense of another group', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'other', expenseId: 'e1' }).catch((e: unknown) => e))
    expect(r).toMatchObject({ _tag: 'Forbidden' })
    const mine = await tx((db) => listActivities(db, { principal: alice, groupId: 'g2', expenseId: 'e1' }))
    expect(mine.activities).toEqual([])
  })

  it('shows group snapshots and hides the targets of access changes (P-ACCESS-30)', async () => {
    const g = await newGroup()
    await tx((db) =>
      db.insert(activities).values([
        { id: `${g.id}-invite`, groupId: g.id, type: 'update_group', data: 'Invitation created: bob@example.com', actorName: 'Alice Account', actorUserId: alice.userId, source: 'web' },
        { id: `${g.id}-join`, groupId: g.id, type: 'join_group', data: 'join: u-bob', actorName: 'Bob Account', actorUserId: 'u-bob', source: 'web' },
        { id: `${g.id}-bind`, groupId: g.id, type: 'update_group', data: `Member identity bound: u-bob / bob@example.com / ${g.bob} / Bob`, actorName: 'Alice Account', actorUserId: alice.userId, source: 'web' },
      ]),
    )
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: g.id, limit: 100 }))
    expect(r.activities.slice(0, 3).map((a) => a.data)).toEqual(['Member identity bound', 'join', 'Invitation created'])
    expect(JSON.stringify(r)).not.toMatch(/example\.com|u-bob/)
    const group = r.activities.find((a) => a.type === 'create_group')
    expect(group?.snapshot).toEqual({
      _tag: 'group',
      group: {
        schemaVersion: 1,
        name: 'Home',
        slug: g.id,
        currency: 'USD',
        information: 'Our flat',
        participants: [
          { id: g.alice, name: 'Alice' },
          { id: g.bob, name: 'Bob' },
        ],
      },
    })
  })
})

describe('imported expenses and v1 snapshots', () => {
  const v1 = {
    id: 'v1x',
    groupId: 'g2',
    title: 'Hardware store',
    amount: '100.01',
    currencyCode: 'USD',
    expenseDate: '2025-03-04',
    createdAt: '2025-03-04T10:00:00.000Z',
    categoryId: 14,
    category: { id: 14, grouping: 'Home', name: 'Household Supplies' },
    paidBy: { id: 'qa', name: 'Ann' },
    isReimbursement: false,
    notes: null,
    recurrenceRule: 'NONE' as const,
    documents: [{ id: 'd1', url: 'https://receipts.example/a.jpg', width: 10, height: 10 }],
  }

  beforeAll(async () => {
    await tx((db) =>
      insertImportedExpense(db, {
        revisions: [
          {
            type: 'create_expense',
            time: '2025-03-04T10:00:00.000Z',
            actorName: 'Ann',
            snapshot: { ...v1, revision: 1, splitMode: 'BY_SHARES', paidFor: [{ participantId: 'qa', name: 'Ann', shares: '1' }, { participantId: 'qb', name: 'Ben', shares: '2' }, { participantId: 'qc', name: 'Cal', shares: '2' }] },
          },
          {
            type: 'update_expense',
            time: '2025-03-05T10:00:00.000Z',
            actorName: 'Ann Account',
            actorUserId: 'u-alice',
            source: 'agent',
            snapshot: { ...v1, revision: 2, vendor: 'Ikea', splitMode: 'BY_AMOUNT', paidFor: [{ participantId: 'qa', name: 'Ann', shares: '50.01' }, { participantId: 'qb', name: 'Ben', shares: '30' }, { participantId: 'qc', name: 'Cal', shares: '20' }] },
          },
        ],
        current: {
          kind: 'expense',
          amount: 10001n,
          splitMode: 'amount',
          payers: [{ participantId: 'qa', amount: 10001n }],
          shares: [
            { participantId: 'qa', amount: 5001n, weight: '5001' },
            { participantId: 'qb', amount: 3000n, weight: '3000' },
            { participantId: 'qc', amount: 2000n, weight: '2000' },
          ],
        },
      }),
    )
    // The first v2 edit of an imported expense: a schemaVersion 2 snapshot after v1 ones.
    await tx((db) =>
      updateExpense(db, {
        principal: alice,
        groupId: 'g2',
        expenseId: 'v1x',
        expectedRevision: 2,
        idempotencyKey: key(),
        expense: draft({
          payer: 'qa',
          people: ['qa', 'qb', 'qc'],
          title: 'Hardware store',
          vendor: 'Ikea',
          categoryId: 14,
          expenseDate: '2025-03-04',
          amount: '100.01',
          splitMode: 'amount',
          shares: [
            { participantId: 'qa', weight: '40.01' },
            { participantId: 'qb', weight: '40' },
            { participantId: 'qc', weight: '20' },
          ],
        }),
      }),
    )
  })

  it('shows the exact previous and current allocations of every revision', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g2', expenseId: 'v1x', order: 'asc', limit: 100 }))
    const shown = r.activities.map((a) => ({
      revision: a.expenseRevision,
      current: a.snapshot?._tag === 'expense' ? describeRevision(a.snapshot.expense).splits : null,
      previous: a.previousSnapshot?._tag === 'expense' ? describeRevision(a.previousSnapshot.expense).splits : null,
    }))
    expect(shown).toEqual([
      // 100.01 by shares 1:2:2: the leftover cent goes to the payer, Ann.
      { revision: 1, current: 'Ann: 20.01 USD (share 1)\nBen: 40.00 USD (share 2)\nCal: 40.00 USD (share 2)', previous: null },
      { revision: 2, current: 'Ann: 50.01 USD (share 50.01)\nBen: 30.00 USD (share 30.00)\nCal: 20.00 USD (share 20.00)', previous: 'Ann: 20.01 USD (share 1)\nBen: 40.00 USD (share 2)\nCal: 40.00 USD (share 2)' },
      { revision: 3, current: 'Ann: 40.01 USD (share 40.01)\nBen: 40.00 USD (share 40.00)\nCal: 20.00 USD (share 20.00)', previous: 'Ann: 50.01 USD (share 50.01)\nBen: 30.00 USD (share 30.00)\nCal: 20.00 USD (share 20.00)' },
    ])
  })

  it('compares a v1 revision and the v2 revision after it field by field', async () => {
    const r = await tx((db) => listActivities(db, { principal: alice, groupId: 'g2', expenseId: 'v1x', limit: 1 }))
    const [a] = r.activities
    if (a?.snapshot?._tag !== 'expense' || a.previousSnapshot?._tag !== 'expense') throw new Error('Expected two expense snapshots')
    const current = describeRevision(a.snapshot.expense)
    const previous = describeRevision(a.previousSnapshot.expense)
    const changed = Object.keys(current).filter((k) => current[k as keyof typeof current] !== previous[k as keyof typeof previous])
    // v2 snapshots keep only the document count, so the attachment field changes form.
    expect(changed).toEqual(['splits', 'attachments'])
    expect(previous).toMatchObject({ title: 'Hardware store', vendor: 'Ikea', amount: '100.01 USD', date: '2025-03-04', payer: 'Ann', splitMode: 'By amount', category: 'Household Supplies', recurrence: 'None', attachments: 'https://receipts.example/a.jpg' })
    expect(current.attachments).toBe('')
  })

  it('reads imported and v2 revisions into one ledger', async () => {
    const at = await tx((db) => listActivities(db, { principal: alice, groupId: 'g2', limit: 1 }))
    const ledger = await tx((db) => historicalLedger(db, { principal: alice, groupId: 'g2', atActivityId: at.atActivityId ?? '' }))
    expect(ledger.history.complete).toBe(true)
    const balances = await tx((db) => savedBalances(db, { principal: alice, groupId: 'g2', asOf: '2025-03-04T12:00:00Z' }))
    expect(balances.balances.map((b) => [b.participantId, b.net])).toEqual([
      ['qa', '80.00'],
      ['qb', '-40.00'],
      ['qc', '-40.00'],
    ])
  })
})

describe('legacy gaps (P-HIST-52, P-HIST-53, P-HIST-57)', () => {
  it('discloses expenses without saved state and refuses balances there', async () => {
    const g = await newGroup()
    const legacy = await insertLegacy(g)
    const page = await tx((db) => listSavedExpenses(db, { principal: alice, groupId: g.id, atActivityId: g.created, filter: {} }))
    expect(page.history).toMatchObject({ complete: false, unavailableExpenseIds: [legacy] })
    await expect(tx((db) => savedBalances(db, { principal: alice, groupId: g.id, atActivityId: g.created }))).rejects.toMatchObject({
      message: expect.stringContaining('Historical balances are unavailable'),
    })
  })

  it('counts a baseline only from its recording time', async () => {
    const g = await newGroup()
    const legacy = await insertLegacy(g)
    await update({ group: g, expenseId: legacy, expectedRevision: 0, title: 'Legacy unknown history', amount: '12', notes: 'First audited edit', expenseDate: '2001-01-01' })
    const baseline = await tx((db) => getSavedExpense(db, { principal: alice, groupId: g.id, expenseId: legacy, revision: 0 }))
    expect(baseline.expense.amount).toBe('12.00')
    expect((await tx((db) => listSavedExpenses(db, { principal: alice, groupId: g.id, atActivityId: g.created, filter: {} }))).history.complete).toBe(false)
    expect((await tx((db) => listSavedExpenses(db, { principal: alice, groupId: g.id, asOf: new Date().toISOString(), filter: {} }))).history.complete).toBe(true)
  })
})

describe('reads have no side effects (P-HIST-59)', () => {
  it('creates no events, rows or revisions', async () => {
    const before = await counts()
    const now = new Date().toISOString()
    await tx((db) => getSavedExpense(db, { principal: alice, groupId: 'g1', expenseId: 'e1', revision: 2 }))
    await tx((db) => listSavedExpenses(db, { principal: alice, groupId: 'g1', asOf: now, filter: {} }))
    await tx((db) => savedBalances(db, { principal: alice, groupId: 'g1', asOf: now }))
    await tx((db) => listActivities(db, { principal: alice, groupId: 'g1', limit: 100 }))
    expect(await counts()).toEqual(before)
  })

  it('blocks every history read after access is revoked (P-HIST-38)', async () => {
    const g = await newGroup()
    const expenseId = next()
    await create({ group: g, expenseId })
    await tx((db) => db.update(memberships).set({ active: false }).where(eq(memberships.groupId, g.id)))
    await expect(tx((db) => getSavedExpense(db, { principal: alice, groupId: g.id, expenseId, revision: 1 }))).rejects.toMatchObject({ _tag: 'Forbidden', message: 'Group not found, or you are not a member' })
    await expect(tx((db) => listActivities(db, { principal: alice, groupId: g.id }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })
})
