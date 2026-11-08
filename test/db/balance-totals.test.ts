// The running balances (balance_totals, db/migrations/0020). A total that
// drifts from the payer and share rows is silent: every balance, settlement
// and dashboard total is then wrong by the same amount, and nothing fails.
// Random sequences of the app's writes (create, edit, delete and the recurring
// run) must keep the totals equal to a full recount. A deleted expense never
// comes back: 0001 refuses any edit of one, so there is no restore to test.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeBalances } from '~/shared/balances'
import type { CurrencyCode } from '~/shared/currencies'
import { CURRENCIES } from '~/shared/currencies'
import type { ExpenseDraft } from '~/shared/expense-rules'
import { minor } from '~/shared/minor'
import { accountBalances, balanceDrift, groupBalances } from '~/server/balances'
import { createExpense, deleteExpense, updateExpense } from '~/server/ledger'
import type { Db } from '~/server/core/db'
import { testDatabase, type TestDatabase } from '../kit/database'
import { counter } from '../kit/ids'
import { principal } from '../kit/people'
import { scheduledRun } from '../kit/recurring'
import { seedHousehold } from '../kit/seed'

let database: TestDatabase
const tx: TestDatabase['tx'] = (work) => database.tx(work)
const alice = principal('u-totals-alice', { name: 'Alice' })
const nextGroup = counter('bt')
const key = counter('totals-key')

beforeAll(async () => {
  database = await testDatabase()
})
afterAll(() => database.close())

/** A seeded random source (mulberry32), so a failing sequence runs again the same way. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T,>(list: readonly T[]): T => {
    const value = list[int(list.length)]
    if (value === undefined) throw new Error('pick from an empty list')
    return value
  }
  const subset = <T,>(list: readonly T[], min: number): T[] => {
    const shuffled = [...list].sort(() => next() - 0.5)
    return shuffled.slice(0, min + int(list.length - min + 1))
  }
  return { int, pick, subset }
}
type Random = ReturnType<typeof random>

const CURRENCY_CHOICES: readonly CurrencyCode[] = ['USD', 'EUR', 'JPY']

/** `minorUnits` as the decimal text of `currency`. */
function text(minorUnits: bigint, currency: CurrencyCode): string {
  const decimals = CURRENCIES[currency].decimals
  const sign = minorUnits < 0n ? '-' : ''
  const digits = (minorUnits < 0n ? -minorUnits : minorUnits).toString().padStart(decimals + 1, '0')
  return decimals ? `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : `${sign}${digits}`
}

/** `total` cut into `count` random parts of at least one unit each (of its sign), which sum to it exactly. */
function cut(r: Random, total: bigint, count: number): bigint[] {
  const sign = total < 0n ? -1n : 1n
  let left = (total < 0n ? -total : total) - BigInt(count)
  const parts = Array.from({ length: count }, () => 1n)
  for (let i = 0; i < count - 1; i++) {
    const take = (left * BigInt(r.int(101))) / 100n
    parts[i] = (parts[i] ?? 0n) + take
    left -= take
  }
  parts[count - 1] = (parts[count - 1] ?? 0n) + left
  return parts.map((p) => p * sign)
}

/** A random valid draft among `people`: any currency, one or two payers, and one of the split modes; sometimes a refund split by amount. */
function randomDraft(r: Random, people: readonly string[], recurrence: ExpenseDraft['recurrence'] = 'none'): ExpenseDraft {
  const currency = r.pick(CURRENCY_CHOICES)
  const refund = r.int(8) === 0
  const total = BigInt(100 + r.int(50_000)) * (refund ? -1n : 1n)
  const payers = r.subset(people, 1).slice(0, 1 + r.int(2))
  const paid = cut(r, total, payers.length)
  const sharers = r.subset(people, 1)
  const mode = refund ? 'amount' : r.pick(['evenly', 'shares', 'amount', 'percentage'] as const)
  const shares = (() => {
    if (mode === 'evenly') return sharers.map((participantId) => ({ participantId, weight: '1' }))
    if (mode === 'shares') return sharers.map((participantId) => ({ participantId, weight: String(1 + r.int(3)) }))
    if (mode === 'amount') {
      const owed = cut(r, total, sharers.length)
      return sharers.map((participantId, i) => ({ participantId, weight: text(owed[i] ?? 0n, currency) }))
    }
    // Percentages in whole numbers that sum to 100.
    const percents = cut(r, 100n, sharers.length)
    return sharers.map((participantId, i) => ({ participantId, weight: String(percents[i] ?? 0n) }))
  })()
  return {
    kind: 'expense',
    title: refund ? 'Refund' : 'Groceries',
    vendor: null,
    notes: '',
    categoryId: 0,
    expenseDate: '2026-11-01',
    currency,
    amount: text(total, currency),
    payers: payers.map((participantId, i) => ({ participantId, amount: text(paid[i] ?? 0n, currency) })),
    splitMode: mode,
    shares,
    recurrence,
  }
}

/** The group's balances recounted from its rows in TypeScript, by each expense's own currency and deleted_at. */
async function recounted(db: Db, groupId: string) {
  const rows = await db.execute<{ expense_id: string; currency: CurrencyCode; side: 'paid' | 'owed'; participant_id: string; amount: string }>(sql`
    SELECT p.expense_id, x.currency, 'paid' AS side, p.participant_id, p.amount::text AS amount FROM expense_payers p JOIN expenses x ON x.id = p.expense_id AND x.deleted_at IS NULL WHERE p.group_id = ${groupId}
    UNION ALL
    SELECT s.expense_id, x.currency, 'owed', s.participant_id, s.amount::text FROM expense_shares s JOIN expenses x ON x.id = s.expense_id AND x.deleted_at IS NULL WHERE s.group_id = ${groupId}
  `)
  return computeBalances(
    rows.rows.map((row) => ({
      currency: row.currency,
      payers: new Map(row.side === 'paid' ? [[row.participant_id, minor(BigInt(row.amount))]] : []),
      shares: new Map(row.side === 'owed' ? [[row.participant_id, minor(BigInt(row.amount))]] : []),
    })),
  )
}

/** Fails with the differing sums when the totals of `groupId` drift from its rows, or its balances from a recount. */
async function expectInStep(groupId: string, step: string) {
  const drift = await database.withDb((db) => balanceDrift(db, { groupId }))
  expect(drift, step).toEqual([])
  const [stored, counted] = await database.withDb(async (db) => [(await groupBalances(db, { principal: alice, groupId })).balances, await recounted(db, groupId)] as const)
  expect(stored, step).toEqual(counted)
}

async function household(people: number) {
  const groupId = nextGroup()
  const ids = Array.from({ length: people }, (_, i) => `${groupId}-p${i}`)
  await tx((db) =>
    seedHousehold(db, {
      groupId,
      slug: `${groupId}-home`,
      name: 'Home',
      people: [{ id: ids[0] ?? '', name: 'Alice', userId: alice.userId }, ...ids.slice(1).map((id, i) => ({ id, name: `Person ${i + 1}` }))],
    }),
  )
  return { groupId, people: ids }
}

describe('running balances', () => {
  it.each([1, 2, 3, 4, 5, 6])('stay equal to a recount through a random sequence of writes (seed %i)', async (seed) => {
    const r = random(seed)
    const { groupId, people } = await household(2 + r.int(4))
    const live = new Map<string, number>()
    const nextExpense = counter(`${groupId}-e`)
    for (let step = 0; step < 30; step++) {
      const choice = live.size === 0 ? 0 : r.int(10)
      const liveIds = [...live.keys()]
      let what: string
      if (choice < 4) {
        const expenseId = nextExpense()
        const recurring = r.int(6) === 0
        const created = await tx((db) =>
          createExpense(db, { principal: alice, groupId, expenseId, idempotencyKey: key(), expense: randomDraft(r, people, recurring ? 'daily' : 'none') }),
        )
        live.set(expenseId, created.revision)
        what = `create ${expenseId}${recurring ? ' (daily)' : ''}`
      } else if (choice < 7) {
        const expenseId = r.pick(liveIds)
        const updated = await tx((db) =>
          updateExpense(db, { principal: alice, groupId, expenseId, expectedRevision: live.get(expenseId) ?? 0, idempotencyKey: key(), expense: randomDraft(r, people) }),
        )
        live.set(expenseId, updated.revision)
        what = `update ${expenseId}`
      } else if (choice < 9) {
        const expenseId = r.pick(liveIds)
        await tx((db) => deleteExpense(db, { principal: alice, groupId, expenseId, expectedRevision: live.get(expenseId) ?? 0, idempotencyKey: key() }))
        live.delete(expenseId)
        what = `delete ${expenseId}`
      } else {
        const created = await tx((db) => scheduledRun(db, { today: '2026-11-03', groupId }))
        for (const id of created) live.set(id, 1)
        what = `recurring run (${created.length} created)`
      }
      await expectInStep(groupId, `seed ${seed}, step ${step}: ${what}`)
    }
  })

  it('stay equal to a recount when one statement changes the currency and the payers together', async () => {
    const { groupId, people } = await household(3)
    const [a, b, c] = people
    if (!a || !b || !c) throw new Error('three people')
    const expenseId = `${groupId}-e`
    const usd: ExpenseDraft = {
      kind: 'expense', title: 'Dinner', vendor: null, notes: '', categoryId: 0, expenseDate: '2026-11-01', currency: 'USD', amount: '90.00',
      payers: [{ participantId: a, amount: '90.00' }], splitMode: 'evenly', shares: [a, b, c].map((participantId) => ({ participantId, weight: '1' })), recurrence: 'none',
    }
    await tx((db) => createExpense(db, { principal: alice, groupId, expenseId, idempotencyKey: key(), expense: usd }))
    // The same amounts in minor units in another currency of two decimals: only the currency of the rows changes, through the cascade.
    await tx((db) => updateExpense(db, { principal: alice, groupId, expenseId, expectedRevision: 1, idempotencyKey: key(), expense: { ...usd, currency: 'EUR' } }))
    await expectInStep(groupId, 'currency only')
    // A new currency, a new payer and one sharer fewer, in writeExpense's one statement.
    await tx((db) =>
      updateExpense(db, {
        principal: alice, groupId, expenseId, expectedRevision: 2, idempotencyKey: key(),
        expense: { ...usd, currency: 'JPY', amount: '9000', payers: [{ participantId: b, amount: '9000' }], shares: [a, b].map((participantId) => ({ participantId, weight: '1' })) },
      }),
    )
    await expectInStep(groupId, 'currency, payer and shares')
    const totals = await database.withDb((db) => db.execute(sql`SELECT participant_id, currency, paid::text, owed::text, parts FROM balance_totals WHERE group_id = ${groupId} ORDER BY 1, 2`)).then((x) => x.rows)
    expect(totals).toEqual([
      { participant_id: a, currency: 'JPY', paid: '0', owed: '4500', parts: 1 },
      { participant_id: b, currency: 'JPY', paid: '9000', owed: '4500', parts: 2 },
    ])
  })

  it('give the dashboard the same nets as a recount', async () => {
    const r = random(99)
    const { groupId, people } = await household(4)
    for (let i = 0; i < 12; i++) await tx((db) => createExpense(db, { principal: alice, groupId, expenseId: `${groupId}-d${i}`, idempotencyKey: key(), expense: randomDraft(r, people) }))
    const [mine, counted] = await database.withDb(async (db) => [await accountBalances(db, { principal: alice, scope: [{ groupId }] }), await recounted(db, groupId)] as const)
    const me = people[0] ?? ''
    const expected = [...counted]
      .flatMap(([currency, byPerson]) => {
        const b = byPerson.get(me)
        return b ? [{ currency, net: b.net }] : []
      })
      .map((x) => `${x.currency} ${text(x.net, x.currency)}`)
      .sort()
    expect(mine.balances.map((b) => `${b.currency} ${b.amount}`).sort()).toEqual(expected)
  })

  it('refuse a payer or share row whose currency or liveness differs from its expense, and refuse TRUNCATE', async () => {
    const { groupId, people } = await household(2)
    const [a] = people
    const expenseId = `${groupId}-e`
    await tx((db) =>
      createExpense(db, {
        principal: alice, groupId, expenseId, idempotencyKey: key(),
        expense: { kind: 'expense', title: 'Tea', vendor: null, notes: '', categoryId: 0, expenseDate: '2026-11-01', currency: 'USD', amount: '4.00', payers: [{ participantId: a ?? '', amount: '4.00' }], splitMode: 'evenly', shares: [{ participantId: a ?? '', weight: '1' }], recurrence: 'none' },
      }),
    )
    await expect(tx((db) => db.execute(sql`UPDATE expense_shares SET currency = 'EUR' WHERE expense_id = ${expenseId}`))).rejects.toMatchObject({ cause: { code: '23503' } })
    await expect(tx((db) => db.execute(sql`UPDATE expense_payers SET live = false WHERE expense_id = ${expenseId}`))).rejects.toMatchObject({ cause: { code: '23503' } })
    for (const table of ['expense_payers', 'expense_shares', 'balance_totals'])
      await expect(tx((db) => db.execute(sql.raw(`TRUNCATE ${table} CASCADE`)))).rejects.toMatchObject({ cause: { code: '23514' } })
    await expectInStep(groupId, 'after the refused writes')
  })
})
