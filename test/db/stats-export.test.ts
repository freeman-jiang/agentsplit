// The Stats tab and the exports against a real database.
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activities, groups, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { makeDb, type Db } from '~/server/db'
import { contentDisposition, exportCsv, exportJson } from '~/server/export'
import { createExpense, deleteExpense, type Principal } from '~/server/ledger'
import { statsExpenses, statsOverview } from '~/server/stats'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { insertImportedExpense } from './history-fixtures'
import { resetTestDatabase, testUsers } from './setup'

let pool: Pool
const alice: Principal = { userId: 'u-alice', name: 'Alice', email: 'a@example.com', source: 'web', agentKeyId: null }
const unbound: Principal = { userId: 'u-unbound', name: 'Viewer', email: 'v@example.com', source: 'web', agentKeyId: null }
const stranger: Principal = { userId: 'u-stranger', name: 'Stranger', email: 's@example.com', source: 'web', agentKeyId: null }

async function tx<A>(work: (db: Db) => Promise<A>): Promise<A> {
  const client = await pool.connect()
  try {
    return await makeDb(client).transaction(work, { isolationLevel: 'serializable' })
  } finally {
    client.release()
  }
}
let keys = 0
const create = (id: string, over: Partial<ExpenseDraft>) =>
  tx((db) =>
    createExpense(db, {
      principal: alice,
      group: 'g1',
      expenseId: id,
      idempotencyKey: `key-stats-${++keys}`,
      expense: {
        kind: 'expense',
        title: id,
        vendor: null,
        notes: '',
        categoryId: 9,
        expenseDate: '2026-01-10',
        currency: 'USD',
        amount: '95.00',
        payers: [{ participantId: 'pa', amount: '95.00' }],
        splitMode: 'evenly',
        shares: ['pa', 'pb', 'pc'].map((participantId) => ({ participantId, weight: '1' })),
        recurrence: 'none',
        ...over,
      },
    }),
  )

beforeAll(async () => {
  pool = await resetTestDatabase()
  await tx(async (db) => {
    await db.insert(groups).values([{ id: 'g1', kind: 'named', slug: 'flat', name: 'Flat · Zürich', defaultCurrency: 'USD' }])
    await db.insert(participants).values([
      { id: 'pa', groupId: 'g1', name: 'Alice' },
      { id: 'pb', groupId: 'g1', name: 'Bob' },
      { id: 'pc', groupId: 'g1', name: '=Cara' },
    ])
    await db.insert(user).values(testUsers([alice, unbound]))
    await db.insert(memberships).values([
      { userId: alice.userId, groupId: 'g1', role: 'admin', participantId: 'pa' },
      { userId: unbound.userId, groupId: 'g1', role: 'member', participantId: null },
    ])
  })
  // Three people share 95.00 in whole cents: 31.67, 31.67 and 31.66 (P-STATS-23).
  await create('groceries', { vendor: 'Costco', title: '=Groceries' })
  await create('rent', { categoryId: 18, amount: '1200.00', expenseDate: '2026-03-01', payers: [{ participantId: 'pa', amount: '700.00' }, { participantId: 'pb', amount: '500.00' }], recurrence: 'monthly' })
  await create('refund', { categoryId: 18, amount: '-50.00', expenseDate: '2026-03-02', payers: [{ participantId: 'pb', amount: '-50.00' }] })
  await create('payback', { kind: 'payment', categoryId: 1, amount: '20.00', expenseDate: '2026-03-03', payers: [{ participantId: 'pb', amount: '20.00' }], splitMode: 'amount', shares: [{ participantId: 'pa', weight: '20.00' }] })
  await create('ramen', { currency: 'JPY', amount: '1500', payers: [{ participantId: 'pa', amount: '1500' }], expenseDate: '2026-02-01', categoryId: 8 })
  await create('gone', { amount: '999.00', payers: [{ participantId: 'pa', amount: '999.00' }] })
  await tx((db) => deleteExpense(db, { principal: alice, group: 'g1', expenseId: 'gone', expectedRevision: 1, idempotencyKey: 'key-stats-delete' }))
})
afterAll(async () => {
  await pool.end()
})

describe('stats overview', () => {
  it('defaults to the group currency and lists every used currency', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'flat', today: '2026-05-20' }))
    expect([s.currency, s.currencies]).toEqual(['USD', ['JPY', 'USD']])
  })

  it('leaves payments out of every figure and counts each payer (P-STATS-12, P-STATS-18, P-STATS-20)', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'g1', today: '2026-05-20' }))
    expect([s.total, s.yourPaid, s.yourShare]).toEqual(['1245.00', '795.00', '415.00'])
    expect(s.summary).toEqual({ count: 3, average: '415.00', largest: { title: 'rent', amount: '1200.00' }, firstDate: '2026-01-10', lastDate: '2026-03-02' })
    expect(s.participants).toEqual([
      { participantId: 'pa', name: 'Alice', paid: '795.00', count: 2, share: '415.00' },
      { participantId: 'pb', name: 'Bob', paid: '450.00', count: 2, share: '415.00' },
      { participantId: 'pc', name: '=Cara', paid: '0.00', count: 0, share: '415.00' },
    ])
    // The shares add up to the total (P-STATS-24).
    expect(s.participants.reduce((sum, p) => sum + Number(p.share), 0)).toBe(1245)
  })

  it('hides personal totals without a bound participant (P-STATS-21)', async () => {
    const s = await tx((db) => statsOverview(db, { principal: unbound, group: 'g1', today: '2026-05-20' }))
    expect([s.participantId, s.yourPaid, s.yourShare]).toEqual([null, null, null])
  })

  it('shows the same months in both charts, through the current month (P-STATS-25, P-STATS-36)', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'g1', today: '2026-05-20' }))
    expect(s.months).toEqual([
      { month: '2026-01', total: '95.00' },
      { month: '2026-02', total: '0.00' },
      { month: '2026-03', total: '1150.00' },
      { month: '2026-04', total: '0.00' },
      { month: '2026-05', total: '0.00' },
    ])
    expect(s.monthly.months.map((m) => m.key)).toEqual(s.months.map((m) => m.month))
    const march = s.monthly.months[2]
    expect(march).toMatchObject({ amount: '1150.00', expense: '1200.00', income: '-50.00' })
    expect(s.monthly.maxExpense).toBe('1200.00')
  })

  it('ranks categories with whole percentages and leaves out zero totals (P-STATS-29, P-STATS-30)', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'g1', today: '2026-05-20' }))
    expect(s.categories).toEqual([
      { categoryId: 18, grouping: 'Home', name: 'Rent', total: '1150.00', percent: 92 },
      { categoryId: 9, grouping: 'Food and Drink', name: 'Groceries', total: '95.00', percent: 8 },
    ])
  })

  it('scopes to a range, but not the recurring card (P-STATS-09, P-STATS-42)', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'g1', from: '2026-03-01', to: '2026-01-01', today: '2026-05-20' }))
    // Reversed bounds are swapped (P-STATS-10).
    expect([s.total, s.summary.count]).toEqual(['1295.00', 2])
    expect(s.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(s.recurring).toEqual({ count: 1, byPeriod: [{ period: 'monthly', count: 1, total: '1200.00' }], monthly: '1200.00', yearly: '14400.00' })
  })

  it('shows one currency at a time', async () => {
    const s = await tx((db) => statsOverview(db, { principal: alice, group: 'g1', currency: 'JPY', today: '2026-05-20' }))
    expect([s.total, s.summary.average, s.recurring.count, s.categories.map((c) => c.name)]).toEqual(['1500', '1500', 0, ['Dining Out']])
  })

  it('drills down into a month or a category, newest first (P-STATS-27, P-STATS-31)', async () => {
    const march = await tx((db) => statsExpenses(db, { principal: alice, group: 'g1', currency: 'USD', month: '2026-03' }))
    expect(march.map((e) => e.id)).toEqual(['refund', 'rent'])
    const food = await tx((db) => statsExpenses(db, { principal: alice, group: 'g1', currency: 'USD', categoryId: 9, from: '2026-02-01' }))
    expect(food).toEqual([])
  })

  it('refuses non-members and writes nothing (P-STATS-44)', async () => {
    await expect(tx((db) => statsOverview(db, { principal: stranger, group: 'g1' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    const count = async () => (await tx((db) => db.execute<{ n: number }>(sql`SELECT (SELECT count(*) FROM expenses) + (SELECT count(*) FROM activities) AS n`))).rows[0]?.n
    const before = await count()
    await tx((db) => statsOverview(db, { principal: alice, group: 'g1' }))
    expect(await count()).toBe(before)
  })
})

describe('exports', () => {
  beforeAll(async () => {
    await tx(async (db) => {
      await db.insert(activities).values([
        { id: 'act-invite', groupId: 'g1', type: 'update_group', data: 'Invitation created: bob@example.com', actorName: 'Alice', actorUserId: 'u-alice', agentKeyId: 'key-secret', source: 'agent' },
      ])
      await insertImportedExpense(db, {
        revisions: [
          {
            type: 'create_expense',
            time: '2025-12-01T10:00:00.000Z',
            snapshot: {
              id: 'imported',
              groupId: 'g1',
              revision: 1,
              title: 'Old lamp',
              amount: '30',
              currencyCode: 'USD',
              expenseDate: '2025-12-01',
              createdAt: '2025-12-01T10:00:00.000Z',
              categoryId: 13,
              category: { id: 13, grouping: 'Home', name: 'Furniture' },
              paidBy: { id: 'pc', name: '=Cara' },
              paidFor: [{ participantId: 'pa', name: 'Alice', shares: '1' }, { participantId: 'pc', name: '=Cara', shares: '2' }],
              splitMode: 'BY_SHARES',
              isReimbursement: false,
              notes: null,
              recurrenceRule: null,
            },
          },
        ],
        current: {
          kind: 'expense',
          amount: 3000n,
          splitMode: 'shares',
          payers: [{ participantId: 'pc', amount: 3000n }],
          shares: [
            { participantId: 'pa', amount: 1000n, weight: '1' },
            { participantId: 'pc', amount: 2000n, weight: '2' },
          ],
        },
      })
    })
  })

  it('writes the CSV in a defined order, with net changes that sum to zero (P-EXPORT-17 to P-EXPORT-29)', async () => {
    const file = await tx((db) => exportCsv(db, { principal: alice, group: 'flat' }))
    expect(file.contentType).toBe('text/csv; charset=utf-8')
    expect(file.filename).toMatch(/^AgentSplit Export - Flat · Zürich - \d{4}-\d{2}-\d{2}\.csv$/)
    expect(file.content.startsWith('﻿')).toBe(true)
    // Participant columns follow the group's name order, as everywhere in v2.
    expect(file.content.slice(1).split('\n')).toEqual([
      `"Date","Description","Vendor","Category","Currency","Cost","Original cost","Original currency","Conversion rate","Is Reimbursement","Split mode","'=Cara","Alice","Bob"`,
      `"2025-12-01","Old lamp","","Furniture","USD","30.00",,,,"No","Unevenly – By shares","10.00","-10.00","0.00"`,
      `"2026-01-10","'=Groceries","Costco","Groceries","USD","95.00",,,,"No","Evenly","-31.66","63.33","-31.67"`,
      `"2026-02-01","ramen","","Dining Out","JPY","1500",,,,"No","Evenly","-500","1000","-500"`,
      `"2026-03-01","rent","","Rent","USD","1200.00",,,,"No","Evenly","-400.00","300.00","100.00"`,
      `"2026-03-02","refund","","Rent","USD","-50.00",,,,"No","Evenly","16.66","16.67","-33.33"`,
      `"2026-03-03","payback","","Payment","USD","20.00",,,,"Yes","Unevenly – By amount","0.00","-20.00","20.00"`,
    ])
  })

  it('writes the JSON without user IDs, connection IDs or email addresses (P-EXPORT-10 to P-EXPORT-15)', async () => {
    const file = await tx((db) => exportJson(db, { principal: alice, group: 'g1' }))
    expect(file.filename).toMatch(/^AgentSplit Export - Flat · Zürich - \d{4}-\d{2}-\d{2}\.json$/)
    const body = JSON.parse(file.content) as {
      currency: string
      currencyCode: string
      expenses: { id: string; amount: string; expenseDate: string; paidById: string; paidFor: unknown; splitMode: string; isReimbursement: boolean }[]
      activities: { activityType: string; data: string | null; expenseId: string | null; snapshot: unknown }[]
    }
    expect([body.currency, body.currencyCode]).toEqual(['$', 'USD'])
    expect(body.expenses.map((e) => e.id)).toEqual(['imported', 'groceries', 'ramen', 'rent', 'refund', 'payback'])
    expect(body.expenses[0]).toMatchObject({ amount: '30.00', expenseDate: '2025-12-01T00:00:00.000Z', paidById: 'pc', splitMode: 'BY_SHARES', isReimbursement: false })
    expect(body.expenses.find((e) => e.id === 'payback')?.paidFor).toEqual([{ participantId: 'pa', shares: '20.00', amount: '20.00' }])
    expect(body.expenses.find((e) => e.id === 'rent')).toMatchObject({ paidById: 'pa' })
    // History keeps deleted expenses and stored snapshots of both formats (P-HIST-62).
    expect(body.activities.filter((a) => a.expenseId === 'gone').map((a) => a.activityType)).toEqual(['CREATE_EXPENSE', 'DELETE_EXPENSE'])
    expect(body.activities.find((a) => a.expenseId === 'imported')?.snapshot).toMatchObject({ schemaVersion: 1 })
    expect(body.activities.find((a) => a.expenseId === 'rent')?.snapshot).toMatchObject({ schemaVersion: 2 })
    expect(body.activities.find((a) => a.activityType === 'UPDATE_GROUP')?.data).toBe('Invitation created')
    expect(file.content).not.toMatch(/u-alice|key-secret|example\.com|actorUserId|agentKeyId/)
  })

  it('leaves deleted expenses out of both files (P-EXPORT-08)', async () => {
    const csv = await tx((db) => exportCsv(db, { principal: alice, group: 'g1' }))
    const json = JSON.parse((await tx((db) => exportJson(db, { principal: alice, group: 'g1' }))).content) as { expenses: { id: string }[] }
    expect(csv.content).not.toContain('gone')
    expect(json.expenses.map((e) => e.id)).not.toContain('gone')
  })

  it('refuses non-members (P-EXPORT-04)', async () => {
    await expect(tx((db) => exportCsv(db, { principal: stranger, group: 'g1' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
    await expect(tx((db) => exportJson(db, { principal: stranger, group: 'flat' }))).rejects.toMatchObject({ _tag: 'Forbidden' })
  })

  it('names the file with an ASCII fallback (P-EXPORT-28)', () => {
    expect(contentDisposition('AgentSplit Export - Home - 2026-11-05.csv')).toBe('attachment; filename="AgentSplit Export - Home - 2026-11-05.csv"')
    expect(contentDisposition('AgentSplit Export - Zürich "A/B" - 2026-11-05.json')).toBe(
      `attachment; filename="AgentSplit Export - Z_rich \\"A_B\\" - 2026-11-05.json"; filename*=UTF-8''AgentSplit%20Export%20-%20Z%C3%BCrich%20%22A_B%22%20-%202026-11-05.json`,
    )
  })
})
