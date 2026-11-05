// The Stats tab must show the current app's figures. These tests run the
// current app's src/lib/totals.ts and src/lib/monthly-spending.ts on random
// expenses and compare them with src/shared/stats.ts.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyMonthlySpendingView, getMonthlyCategorySpending } from '../../../src/lib/monthly-spending'
import {
  getRecurringSpending,
  getSpendingByCategory,
  getSpendingByParticipant,
  getSpendingOverTime,
  getSpendingSummary,
  getTotalActiveUserPaidFor,
  getTotalActiveUserShare,
  getTotalGroupSpending,
} from '../../../src/lib/totals'
import type { CurrencyCode } from '~/shared/currencies'
import { formatMinor, minor } from '~/shared/money'
import { resolveShares } from '~/shared/split'
import * as stats from '~/shared/stats'

const minimal = (text: string) => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text)
const CATEGORIES = [
  { id: 0, grouping: 'Uncategorized', name: 'General' },
  { id: 9, grouping: 'Food and Drink', name: 'Groceries' },
  { id: 8, grouping: 'Food and Drink', name: 'Dining Out' },
  { id: 18, grouping: 'Home', name: 'Rent' },
]
const PEOPLE = ['pa', 'pb', 'pc']
const RECURRENCE = ['none', 'daily', 'weekly', 'monthly'] as const

const caseArb = fc.record({
  currency: fc.constantFrom<CurrencyCode>('USD', 'JPY', 'EUR'),
  expenses: fc.array(
    fc.record({
      amount: fc.bigInt({ min: -500_000n, max: 2_000_000n }).filter((a) => a !== 0n),
      payer: fc.constantFrom(...PEOPLE),
      people: fc.subarray(PEOPLE, { minLength: 1 }),
      weights: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 3, maxLength: 3 }),
      category: fc.constantFrom(...CATEGORIES),
      date: fc.date({ min: new Date('2023-01-01'), max: new Date('2026-10-31'), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
      payment: fc.boolean(),
      recurrence: fc.constantFrom(...RECURRENCE),
      title: fc.string({ minLength: 1, maxLength: 6 }),
      vendor: fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: null }),
    }),
    { maxLength: 25 },
  ),
})

type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never

function build(c: Case) {
  const money = (units: bigint) => minimal(formatMinor({ amount: minor(units), currency: c.currency }))
  // Newest first, as the current app's getGroupExpenses returns them.
  const list = [...c.expenses].sort((a, b) => b.date.localeCompare(a.date))
  const ours: stats.StatsExpense[] = list.map((e, i) => {
    const parts = resolveShares({
      amount: minor(e.amount),
      mode: 'shares',
      preferredParticipantId: e.payer,
      participants: e.people.map((p, j) => ({ participantId: p, weight: String(e.weights[j] ?? 1) })),
    })
    return {
      id: `e${i}`,
      kind: e.payment ? 'payment' : 'expense',
      title: e.title,
      vendor: e.vendor,
      expenseDate: e.date,
      currency: c.currency,
      amount: minor(e.amount),
      categoryId: e.category.id,
      category: e.category,
      payers: [{ participantId: e.payer, amount: minor(e.amount) }],
      shares: [...parts].map(([participantId, amount]) => ({ participantId, amount })),
      recurrence: e.recurrence,
    }
  })
  const old = list.map((e, i) => ({
    id: `e${i}`,
    title: e.title,
    vendor: e.vendor,
    amount: money(e.amount),
    currencyCode: c.currency,
    expenseDate: new Date(`${e.date}T00:00:00Z`),
    createdAt: new Date(),
    category: e.category,
    paidBy: { id: e.payer, name: e.payer },
    paidFor: e.people.map((p, j) => ({ participant: { id: p, name: p }, shares: String(e.weights[j] ?? 1) })),
    splitMode: 'BY_SHARES' as const,
    isReimbursement: e.payment,
    recurrenceRule: ({ none: 'NONE', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const)[e.recurrence],
    originalAmount: null,
    originalCurrency: null,
    _count: { documents: 0 },
  }))
  return { ours, old: old as unknown as Parameters<typeof getTotalGroupSpending>[0] }
}

describe('stats match the current app', () => {
  it('totals, summary, participants, categories and recurring estimates', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { ours, old } = build(c)
        const m = (units: bigint) => minimal(formatMinor({ amount: minor(units), currency: c.currency }))
        const totals = stats.totals({ expenses: ours, participantId: 'pa' })
        expect(m(totals.total)).toBe(minimal(getTotalGroupSpending(old)))
        expect(m(totals.paid ?? 0n)).toBe(minimal(getTotalActiveUserPaidFor('pa', old)))
        expect(m(totals.share ?? 0n)).toBe(minimal(getTotalActiveUserShare('pa', old)))

        const summary = stats.summary(ours)
        const oldSummary = getSpendingSummary(old)
        expect({ ...summary, total: m(summary.total), average: m(summary.average), largest: summary.largest && { ...summary.largest, amount: m(summary.largest.amount) } }).toEqual({
          count: oldSummary.expenseCount,
          total: minimal(oldSummary.totalSpending),
          average: minimal(oldSummary.averageExpense),
          largest: oldSummary.largestExpense && { ...oldSummary.largestExpense, amount: minimal(oldSummary.largestExpense.amount) },
          firstDate: oldSummary.firstDate,
          lastDate: oldSummary.lastDate,
        })

        const participants = PEOPLE.map((id) => ({ id, name: id }))
        expect(stats.byParticipant({ participants, expenses: ours }).map((p) => [p.participantId, m(p.paid), p.count, m(p.share)])).toEqual(
          getSpendingByParticipant(participants, old).map((p) => [p.participantId, minimal(p.paid), p.paidCount, minimal(p.share)]),
        )
        expect(stats.byCategory(ours).map((r) => [r.categoryId, m(r.total)])).toEqual(getSpendingByCategory(old).map((r) => [r.categoryId, minimal(r.total)]))

        const recurring = stats.recurring(ours)
        const oldRecurring = getRecurringSpending(old as unknown as Parameters<typeof getRecurringSpending>[0])
        expect([recurring.count, m(recurring.monthly), m(recurring.yearly), recurring.byPeriod.map((p) => [p.period.toUpperCase(), p.count, m(p.total)])]).toEqual([
          oldRecurring.count,
          minimal(oldRecurring.estimatedMonthly),
          minimal(oldRecurring.estimatedYearly),
          oldRecurring.byPeriod.map((p) => [p.period, p.count, minimal(p.total)]),
        ])
      }),
      { numRuns: 300 },
    )
  })

  it('monthly spending by category and by category group', () => {
    fc.assert(
      fc.property(caseArb, fc.constantFrom<stats.DateRange>({}, { from: '2024-01-15' }, { to: '2025-06-30' }, { from: '2023-03-01', to: '2026-02-01' }), (c, range) => {
        const { ours, old } = build(c)
        const today = '2026-11-05'
        const inRange = stats.inRange(ours, range)
        const oldInRange = (old as unknown as { expenseDate: Date }[]).filter((e) => {
          const d = e.expenseDate.toISOString().slice(0, 10)
          return (!range.from || d >= range.from) && (!range.to || d <= range.to)
        }) as unknown as Parameters<typeof getMonthlyCategorySpending>[0]
        const months = stats.statsMonths({ expenses: inRange, range, today })
        const mine = stats.monthlyByCategory({ expenses: inRange, months, currency: c.currency })
        const theirs = getMonthlyCategorySpending(oldInRange, { grouping: 'category', now: new Date(`${today}T12:00:00Z`), ...range })
        const shape = (s: { months: readonly { key: string; expenseAmount?: string; expense?: string; incomeAmount?: string; income?: string; categories: readonly { key: string; expenseAmount?: string; expense?: string; incomeAmount?: string; income?: string }[] }[] }) =>
          s.months.map((mo) => [mo.key, minimal(mo.expense ?? mo.expenseAmount ?? ''), minimal(mo.income ?? mo.incomeAmount ?? ''), mo.categories.map((x) => [x.key, minimal(x.expense ?? x.expenseAmount ?? ''), minimal(x.income ?? x.incomeAmount ?? '')])])
        expect(shape(mine)).toEqual(shape(theirs))
        expect(shape(stats.regroupMonthly({ spending: mine, grouping: 'categoryGroup', currency: c.currency }))).toEqual(shape(applyMonthlySpendingView(theirs, { grouping: 'categoryGroup' })))
        // Spending over time: the same totals as the current app for every month it shows; v2 shows the same
        // months as Monthly spending (P-STATS-36).
        const over = new Map(stats.overTime({ expenses: inRange, months }).map((x) => [x.month, minimal(formatMinor({ amount: x.total, currency: c.currency }))]))
        for (const x of getSpendingOverTime(oldInRange as unknown as Parameters<typeof getSpendingOverTime>[0])) expect(over.get(x.month)).toBe(minimal(x.total))
        expect([...over.keys()]).toEqual(mine.months.map((x) => x.key))
      }),
      { numRuns: 300 },
    )
  })
})
