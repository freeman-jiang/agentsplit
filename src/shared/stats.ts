// Stats-page figures, as pure functions on minor units. The rules are the
// current app's (src/lib/totals.ts, src/lib/monthly-spending.ts): payments are
// left out of every figure, shares are the same parts balances use, and dates
// are calendar dates. One change: both monthly charts use the same months
// (DECISIONS.md, P-STATS-36). No Effect import: the client uses regroupMonthly.
import type { CurrencyCode } from './currencies'
import { titleWithVendor, type Category } from './history'
import { formatMinor, minor, minorOrNull, sumMinor, type DecimalString, type Minor } from './minor'
import { RECURRING_PERIODS, type ExpenseKind, type Recurrence } from './vocabulary'

export type StatsExpense = {
  readonly id: string
  readonly kind: ExpenseKind
  readonly title: string
  readonly vendor: string | null
  /** YYYY-MM-DD. */
  readonly expenseDate: string
  readonly currency: CurrencyCode
  readonly amount: Minor
  readonly categoryId: number
  readonly category: Category
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor }>
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor }>
  readonly recurrence: Recurrence
}

export type DateRange = { readonly from?: string | undefined; readonly to?: string | undefined }

const spending = (list: readonly StatsExpense[]) => list.filter((e) => e.kind === 'expense')

/** Inclusive calendar-date range; either bound may be missing. */
export function inRange<T extends { expenseDate: string }>(list: readonly T[], range: DateRange): T[] {
  return list.filter((e) => (!range.from || e.expenseDate >= range.from) && (!range.to || e.expenseDate <= range.to))
}

/** Divides and rounds half away from zero, as decimal.js ROUND_HALF_UP does. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (2n * n + d) / (2n * d)
  return negative ? -q : q
}

export function totals(data: { expenses: readonly StatsExpense[]; participantId: string | null }) {
  const list = spending(data.expenses)
  const total = sumMinor(list.map((e) => e.amount))
  if (data.participantId === null) return { total, paid: null, share: null }
  const id = data.participantId
  return {
    total,
    paid: sumMinor(list.flatMap((e) => e.payers.filter((p) => p.participantId === id).map((p) => p.amount))),
    share: sumMinor(list.flatMap((e) => e.shares.filter((s) => s.participantId === id).map((s) => s.amount))),
  }
}

export function summary(expenses: readonly StatsExpense[]) {
  const list = spending(expenses)
  const total = sumMinor(list.map((e) => e.amount))
  let largest: StatsExpense | undefined
  for (const e of list) if (!largest || e.amount > largest.amount) largest = e
  const dates = list.map((e) => e.expenseDate).sort()
  return {
    count: list.length,
    total,
    average: list.length ? minor(divRound(total, BigInt(list.length))) : minor(0n),
    largest: largest ? { title: titleWithVendor(largest), amount: largest.amount } : null,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
  }
}

export function byParticipant(data: { participants: ReadonlyArray<{ id: string; name: string }>; expenses: readonly StatsExpense[] }) {
  const rows = new Map(data.participants.map((p) => [p.id, { participantId: p.id, name: p.name, paid: 0n, count: 0, share: 0n }]))
  for (const e of spending(data.expenses)) {
    for (const p of e.payers) {
      const row = rows.get(p.participantId)
      if (row) {
        row.paid += p.amount
        row.count += 1
      }
    }
    for (const s of e.shares) {
      const row = rows.get(s.participantId)
      if (row) row.share += s.amount
    }
  }
  return [...rows.values()].sort((a, b) => (b.paid > a.paid ? 1 : b.paid < a.paid ? -1 : 0))
}

export function byCategory(expenses: readonly StatsExpense[]) {
  const rows = new Map<number, { categoryId: number; grouping: string; name: string; total: bigint }>()
  for (const e of spending(expenses)) {
    const row = rows.get(e.categoryId) ?? { categoryId: e.categoryId, grouping: e.category.grouping, name: e.category.name, total: 0n }
    row.total += e.amount
    rows.set(e.categoryId, row)
  }
  const list = [...rows.values()].filter((r) => r.total !== 0n).sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0))
  const total = list.reduce((s, r) => s + r.total, 0n)
  // Whole percent of the total, as the current app rounds it; 0 when the total is not positive.
  return list.map((r) => ({ ...r, percent: total > 0n ? Number(divRound(r.total * 100n, total)) : 0 }))
}

// ---------- months ----------

const monthOf = (date: string) => date.slice(0, 7)
const nextMonth = (key: string) => {
  const [y = 0, m = 1] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * The months both charts show: from the From date (else the first expense
 * month) to the To date (else the later of the last expense month and the
 * current month). Empty when nothing is spent in range.
 */
export function statsMonths(data: { expenses: readonly StatsExpense[]; range: DateRange; today: string }): string[] {
  const keys = spending(data.expenses).map((e) => monthOf(e.expenseDate)).sort()
  const first = keys[0]
  const last = keys.at(-1)
  if (!first || !last) return []
  const start = data.range.from ? monthOf(data.range.from) : first
  const current = monthOf(data.today)
  const end = data.range.to ? monthOf(data.range.to) : last > current ? last : current
  const months: string[] = []
  for (let key = start; key <= end; key = nextMonth(key)) months.push(key)
  return months
}

export function overTime(data: { expenses: readonly StatsExpense[]; months: readonly string[] }) {
  const totalsByMonth = new Map<string, bigint>()
  for (const e of spending(data.expenses)) totalsByMonth.set(monthOf(e.expenseDate), (totalsByMonth.get(monthOf(e.expenseDate)) ?? 0n) + e.amount)
  return data.months.map((month) => ({ month, total: minor(totalsByMonth.get(month) ?? 0n) }))
}

/** One stacked-chart segment. Amounts are decimal text; `expense` is the positive part and `income` the negative part. */
export type MonthlyCategory = {
  readonly key: string
  readonly categoryId: number | null
  readonly grouping: string
  readonly name: string
  readonly amount: DecimalString
  readonly expense: DecimalString
  readonly income: DecimalString
}
export type MonthlyMonth = {
  readonly key: string
  readonly amount: DecimalString
  readonly expense: DecimalString
  readonly income: DecimalString
  readonly categories: readonly MonthlyCategory[]
}
export type MonthlySpending = { readonly months: readonly MonthlyMonth[]; readonly categories: readonly MonthlyCategory[]; readonly maxExpense: DecimalString }
export type MonthlyGrouping = 'categoryGroup' | 'category'

type Acc = { key: string; categoryId: number | null; grouping: string; name: string; amount: bigint; expense: bigint; income: bigint }
const addTo = (acc: Acc, amount: bigint) => {
  acc.amount += amount
  if (amount > 0n) acc.expense += amount
  else acc.income += amount
}
const sortAcc = (list: Acc[]) => list.sort((a, b) => (b.expense > a.expense ? 1 : b.expense < a.expense ? -1 : a.key.localeCompare(b.key)))

function format(currency: CurrencyCode, months: { key: string; acc: Acc; categories: Map<string, Acc> }[], totalsByKey: Map<string, Acc>): MonthlySpending {
  const money = (v: bigint) => formatMinor({ amount: minor(v), currency })
  const out = (a: Acc): MonthlyCategory => ({ key: a.key, categoryId: a.categoryId, grouping: a.grouping, name: a.name, amount: money(a.amount), expense: money(a.expense), income: money(a.income) })
  const max = months.reduce((m, x) => (x.acc.expense > m ? x.acc.expense : m), 0n)
  return {
    months: months.map((m) => ({ key: m.key, amount: money(m.acc.amount), expense: money(m.acc.expense), income: money(m.acc.income), categories: sortAcc([...m.categories.values()]).map(out) })),
    categories: sortAcc([...totalsByKey.values()]).map(out),
    maxExpense: money(max),
  }
}

/** Monthly spending by single category, the payload the client regroups. */
export function monthlyByCategory(data: { expenses: readonly StatsExpense[]; months: readonly string[]; currency: CurrencyCode }): MonthlySpending {
  if (data.months.length === 0) return { months: [], categories: [], maxExpense: formatMinor({ amount: minor(0n), currency: data.currency }) }
  const blank = (key: string): Acc => ({ key, categoryId: null, grouping: '', name: '', amount: 0n, expense: 0n, income: 0n })
  const months = new Map(data.months.map((key) => [key, { key, acc: blank(key), categories: new Map<string, Acc>() }]))
  const totalsByKey = new Map<string, Acc>()
  for (const e of spending(data.expenses)) {
    const month = months.get(monthOf(e.expenseDate))
    if (!month) continue
    const key = String(e.categoryId)
    const make = (): Acc => ({ key, categoryId: e.categoryId, grouping: e.category.grouping, name: e.category.name, amount: 0n, expense: 0n, income: 0n })
    const inMonth = month.categories.get(key) ?? make()
    const total = totalsByKey.get(key) ?? make()
    addTo(month.acc, e.amount)
    addTo(inMonth, e.amount)
    addTo(total, e.amount)
    month.categories.set(key, inMonth)
    totalsByKey.set(key, total)
  }
  return format(data.currency, [...months.values()], totalsByKey)
}

/** Regroups the category payload by category group on the client, without a request. */
export function regroupMonthly(data: { spending: MonthlySpending; grouping: MonthlyGrouping; currency: CurrencyCode }): MonthlySpending {
  if (data.grouping === 'category' || data.spending.months.length === 0) return data.spending
  const m = (text: string): bigint => minorOrNull({ amount: text, currency: data.currency }) ?? 0n
  const totalsByKey = new Map<string, Acc>()
  const months = data.spending.months.map((month) => {
    const categories = new Map<string, Acc>()
    for (const c of month.categories) {
      for (const target of [categories, totalsByKey]) {
        const acc = target.get(c.grouping) ?? { key: c.grouping, categoryId: null, grouping: c.grouping, name: c.grouping, amount: 0n, expense: 0n, income: 0n }
        acc.amount += m(c.amount)
        acc.expense += m(c.expense)
        acc.income += m(c.income)
        target.set(c.grouping, acc)
      }
    }
    return { key: month.key, acc: { key: month.key, categoryId: null, grouping: '', name: '', amount: m(month.amount), expense: m(month.expense), income: m(month.income) }, categories }
  })
  return format(data.currency, months, totalsByKey)
}

// ---------- recurring ----------

/**
 * Active recurring expenses as estimated monthly and yearly costs, with 365.25
 * days a year. Both estimates come from the exact sum, so the yearly figure is
 * not the rounded monthly figure times 12. In minor units, with N =
 * daily·36525·7 + weekly·36525 + monthly·8400: monthly = N / 8400 and
 * yearly = N / 700, each rounded half away from zero.
 */
export function recurring(expenses: readonly StatsExpense[]) {
  const periods = RECURRING_PERIODS.map((period) => {
    const list = spending(expenses).filter((e) => e.recurrence === period)
    return { period, count: list.length, total: sumMinor(list.map((e) => e.amount)) }
  })
  const [daily, weekly, monthly] = periods.map((p) => p.total as bigint)
  // 365.25 = 36525 / 100, so daily·365.25/12 = daily·36525·7/8400 and weekly·365.25/84 = weekly·36525/8400.
  const numerator = (daily ?? 0n) * 36525n * 7n + (weekly ?? 0n) * 36525n + (monthly ?? 0n) * 8400n
  return {
    count: periods.reduce((s, p) => s + p.count, 0),
    byPeriod: periods.filter((p) => p.count > 0),
    monthly: minor(divRound(numerator, 8400n)),
    yearly: minor(divRound(numerator, 700n)),
  }
}

/** The currencies the stats currency select offers, and the default one. */
export function statsCurrencies(data: { used: Iterable<CurrencyCode>; groupCurrency: CurrencyCode }) {
  const list = [...new Set(data.used)].sort()
  if (list.length === 0) list.push(data.groupCurrency)
  return { list, preferred: list.includes(data.groupCurrency) ? data.groupCurrency : (list[0] ?? data.groupCurrency) }
}
