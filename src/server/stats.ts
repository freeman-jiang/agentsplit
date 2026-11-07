// The Stats tab: every figure from one statement that also checks membership.
// Reads only: unlike the current app, loading stats never creates due
// recurring expenses (DECISIONS.md, P-STATS-44).
import { sql } from 'drizzle-orm'
import { groupAccessDenied } from '../shared/api'
import type { CurrencyCode } from '../shared/currencies'
import { formatMinor, minor, type Minor } from '../shared/money'
import * as stats from '../shared/stats'
import type { Db } from './db'
import type { Principal } from './ledger'

type Row = {
  id: string
  kind: 'expense' | 'payment'
  title: string
  vendor: string | null
  expenseDate: string
  createdAt: string
  currency: CurrencyCode
  amount: string
  categoryId: number
  grouping: string
  name: string
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
  /** Recurring and still the current frame of its series. */
  activeRecurring: boolean
  payers: { participantId: string; amount: string }[]
  shares: { participantId: string; amount: string }[]
}

type Head = {
  active: boolean | null
  participant_id: string | null
  default_currency: CurrencyCode
  participants: { id: string; name: string }[]
  expenses: Row[]
}

/**
 * The group's live expenses, newest first (expense date, then creation), with
 * their resolved parts. Minor units travel as text.
 */
async function load(db: Db, data: { principal: Principal; group: string }) {
  const result = await db.execute<Head>(sql`
    WITH g AS (
      SELECT g.id, g.default_currency, m.active, m.participant_id
      FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
      WHERE g.id = ${data.group} OR g.slug = ${data.group}
      LIMIT 1
    )
    SELECT g.active, g.participant_id, g.default_currency,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id) FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
      coalesce((SELECT json_agg(json_build_object(
          'id', e.id, 'kind', e.kind, 'title', e.title, 'vendor', e.vendor, 'expenseDate', e.expense_date::text,
          'createdAt', e.created_at, 'currency', e.currency, 'amount', e.amount::text, 'categoryId', e.category_id,
          'grouping', c.grouping, 'name', c.name, 'recurrence', e.recurrence,
          'activeRecurring', e.recurrence <> 'none' AND EXISTS (SELECT 1 FROM recurring_links r WHERE r.current_frame_expense_id = e.id AND r.next_expense_created_at IS NULL),
          'payers', (SELECT json_agg(json_build_object('participantId', x.participant_id, 'amount', x.amount::text) ORDER BY x.participant_id) FROM expense_payers x WHERE x.expense_id = e.id),
          'shares', (SELECT json_agg(json_build_object('participantId', x.participant_id, 'amount', x.amount::text) ORDER BY x.participant_id) FROM expense_shares x WHERE x.expense_id = e.id)
        ) ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC)
        FROM expenses e JOIN categories c ON c.id = e.category_id
        WHERE e.group_id = g.id AND e.deleted_at IS NULL), '[]') AS expenses
    FROM g
  `)
  const head = result.rows[0]
  if (!head?.active) throw groupAccessDenied()
  const expenses = head.expenses.map((e) => ({
    ...e,
    amount: minor(BigInt(e.amount)),
    category: { grouping: e.grouping, name: e.name },
    payers: (e.payers ?? []).map((p) => ({ participantId: p.participantId, amount: minor(BigInt(p.amount)) })),
    shares: (e.shares ?? []).map((s) => ({ participantId: s.participantId, amount: minor(BigInt(s.amount)) })),
  }))
  return { head, expenses }
}

const todayUtc = () => new Date().toISOString().slice(0, 10)

/** The range as given, with reversed bounds swapped. */
const normalRange = (range: stats.DateRange): stats.DateRange =>
  range.from && range.to && range.from > range.to ? { from: range.to, to: range.from } : range

export async function statsOverview(
  db: Db,
  data: { principal: Principal; group: string; currency?: CurrencyCode; from?: string; to?: string; today?: string; participantId?: string },
) {
  const { head, expenses } = await load(db, data)
  const recurringAll = expenses.filter((e) => e.activeRecurring && e.kind === 'expense')
  const { list, preferred } = stats.statsCurrencies({ used: [...expenses, ...recurringAll].map((e) => e.currency), groupCurrency: head.default_currency })
  const currency = data.currency ?? preferred
  const range = normalRange({ from: data.from, to: data.to })
  const selected = stats.inRange(
    expenses.filter((e) => e.currency === currency),
    range,
  )
  const money = (amount: Minor) => formatMinor({ amount, currency })
  // The caller's own figures, unless an agent asks for another participant (MCP get_spending_stats).
  const totals = stats.totals({ expenses: selected, participantId: data.participantId ?? head.participant_id })
  const summary = stats.summary(selected)
  const months = stats.statsMonths({ expenses: selected, range, today: data.today ?? todayUtc() })
  const recurring = stats.recurring(recurringAll.filter((e) => e.currency === currency))
  return {
    currency,
    currencies: list,
    participantId: head.participant_id,
    total: money(totals.total),
    yourPaid: totals.paid === null ? null : money(totals.paid),
    yourShare: totals.share === null ? null : money(totals.share),
    summary: {
      count: summary.count,
      average: money(summary.average),
      largest: summary.largest ? { title: summary.largest.title, amount: money(summary.largest.amount) } : null,
      firstDate: summary.firstDate,
      lastDate: summary.lastDate,
    },
    months: stats.overTime({ expenses: selected, months }).map((m) => ({ month: m.month, total: money(m.total) })),
    monthly: stats.monthlyByCategory({ expenses: selected, months, currency }),
    participants: stats.byParticipant({ participants: head.participants, expenses: selected }).map((p) => ({
      participantId: p.participantId,
      name: p.name,
      paid: money(minor(p.paid)),
      count: p.count,
      share: money(minor(p.share)),
    })),
    categories: stats.byCategory(selected).map((c) => ({ categoryId: c.categoryId, grouping: c.grouping, name: c.name, total: money(minor(c.total)), percent: c.percent })),
    recurring: {
      count: recurring.count,
      byPeriod: recurring.byPeriod.map((p) => ({ period: p.period, count: p.count, total: money(p.total) })),
      monthly: money(recurring.monthly),
      yearly: money(recurring.yearly),
    },
  }
}

/** The expenses behind one month bar or one category row, newest first. Payments are left out, as in the figures. */
export async function statsExpenses(
  db: Db,
  data: { principal: Principal; group: string; currency: CurrencyCode; from?: string; to?: string; month?: string; categoryId?: number },
) {
  const { expenses } = await load(db, data)
  return stats
    .inRange(
      expenses.filter((e) => e.currency === data.currency && e.kind === 'expense'),
      normalRange({ from: data.from, to: data.to }),
    )
    .filter((e) => (data.month === undefined || e.expenseDate.startsWith(data.month)) && (data.categoryId === undefined || e.categoryId === data.categoryId))
    .map((e) => ({ id: e.id, kind: e.kind, title: e.title, vendor: e.vendor, amount: formatMinor({ amount: e.amount, currency: e.currency }), expenseDate: e.expenseDate, currency: e.currency }))
}
