// History, stats and export tools: get_spending_stats, list_activity and
// export_group, with the current app's inputs and outputs
// (src/trpc/routers/groups/stats, activities, export.procedure.ts). The
// figures, the Log and the files come from src/server/stats.ts, history.ts
// and export.ts; this file only maps names.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { minor } from '../../../shared/money'
import { preferredPayer } from '../../../shared/split'
import * as exports from '../../export'
import * as history from '../../history'
import { iso } from '../../sql'
import * as stats from '../../stats'
import { defineTool } from '../registry'
import { Snapshot, snapshotOf } from './saved'
import {
  CalendarDate,
  CurrencyCodeInput,
  DateTime,
  HistoryFields,
  Id,
  MODE_NAMES,
  money,
  Money,
  NonNegativeInt,
  NullableString,
  RecordedTime,
  RecurrenceInput,
  type Rule,
  RULE_NAMES,
  ShortId,
  SplitModeInput,
} from './shared'

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

// ---------- get_spending_stats ----------

const MonthlyCategory = Schema.Struct({
  key: Schema.String,
  categoryId: Schema.NullOr(Schema.Int),
  grouping: Schema.String,
  name: Schema.String,
  amount: Money,
  expenseAmount: Money,
  incomeAmount: Money,
})

type Segment = { key: string; categoryId: number | null; grouping: string; name: string; amount: string; expense: string; income: string }
const segment = (c: Segment) => ({ key: c.key, categoryId: c.categoryId, grouping: c.grouping, name: c.name, amount: c.amount, expenseAmount: c.expense, incomeAmount: c.income })

export const getSpendingStats = defineTool({
  name: 'get_spending_stats',
  kind: 'read',
  description:
    'Read spending totals, participant shares, categories, monthly trends and recurrence estimates in one selected currency. Optional participantId and inclusive from/to dates select the view. Discover other available currencies in availableCurrencyCodes. Money is exact decimal text. Payments are not spending.',
  input: Schema.Struct({
    groupId: Schema.String.check(Schema.isMinLength(1)),
    participantId: optional(Schema.String),
    from: optional(CalendarDate),
    to: optional(CalendarDate),
    currencyCode: optional(CurrencyCodeInput),
  }),
  strict: [''],
  output: Schema.Struct({
    currencyCode: NullableString,
    availableCurrencyCodes: Schema.Array(Schema.String),
    totalGroupSpendings: Money,
    totalParticipantSpendings: optional(Money),
    totalParticipantShare: optional(Money),
    summary: Schema.Struct({
      expenseCount: NonNegativeInt,
      totalSpending: Money,
      averageExpense: Money,
      largestExpense: Schema.NullOr(Schema.Struct({ title: Schema.String, amount: Money })),
      firstDate: Schema.NullOr(CalendarDate),
      lastDate: Schema.NullOr(CalendarDate),
    }),
    months: Schema.Array(Schema.Struct({ month: Schema.String, total: Money })),
    monthlyCategorySpending: Schema.Struct({
      months: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          year: Schema.Int,
          month: Schema.Int,
          amount: Money,
          expenseAmount: Money,
          incomeAmount: Money,
          categories: Schema.Array(MonthlyCategory),
        }),
      ),
      categories: Schema.Array(MonthlyCategory),
      maxExpenseAmount: Money,
    }),
    participants: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, paid: Money, paidCount: Schema.Int, share: Money })),
    categories: Schema.Array(Schema.Struct({ name: Schema.String, grouping: Schema.String, categoryId: Schema.Int, total: Money })),
    recurring: Schema.Struct({
      count: NonNegativeInt,
      estimatedMonthly: Money,
      estimatedYearly: Money,
      byPeriod: Schema.Array(Schema.Struct({ period: Schema.Literals(['DAILY', 'WEEKLY', 'MONTHLY']), count: Schema.Int, total: Money })),
    }),
  }),
  run: async ({ db, principal }, input) => {
    const s = await stats.statsOverview(db, {
      principal,
      group: input.groupId,
      ...(input.currencyCode === undefined ? {} : { currency: input.currencyCode }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
    })
    return {
      currencyCode: s.currency,
      availableCurrencyCodes: s.currencies,
      totalGroupSpendings: s.total,
      // Only for an explicit participant, as in the current app.
      ...(input.participantId === undefined ? {} : { totalParticipantSpendings: s.yourPaid ?? money('0', s.currency), totalParticipantShare: s.yourShare ?? money('0', s.currency) }),
      summary: {
        expenseCount: s.summary.count,
        totalSpending: s.total,
        averageExpense: s.summary.average,
        largestExpense: s.summary.largest,
        firstDate: s.summary.firstDate,
        lastDate: s.summary.lastDate,
      },
      months: s.months,
      monthlyCategorySpending: {
        months: s.monthly.months.map((m) => ({
          key: m.key,
          year: Number(m.key.slice(0, 4)),
          month: Number(m.key.slice(5, 7)),
          amount: m.amount,
          expenseAmount: m.expense,
          incomeAmount: m.income,
          categories: m.categories.map(segment),
        })),
        categories: s.monthly.categories.map(segment),
        maxExpenseAmount: s.monthly.maxExpense,
      },
      participants: s.participants.map((p) => ({ participantId: p.participantId, name: p.name, paid: p.paid, paidCount: p.count, share: p.share })),
      categories: s.categories.map((c) => ({ name: c.name, grouping: c.grouping, categoryId: c.categoryId, total: c.total })),
      recurring: {
        count: s.recurring.count,
        estimatedMonthly: s.recurring.monthly,
        estimatedYearly: s.recurring.yearly,
        byPeriod: s.recurring.byPeriod.map((p) => ({ period: RULE_NAMES[p.period], count: p.count, total: p.total })),
      },
    }
  },
})

// ---------- list_activity ----------

const TYPES = {
  CREATE_GROUP: 'create_group',
  JOIN_GROUP: 'join_group',
  LEAVE_GROUP: 'leave_group',
  UPDATE_GROUP: 'update_group',
  CREATE_EXPENSE: 'create_expense',
  UPDATE_EXPENSE: 'update_expense',
  DELETE_EXPENSE: 'delete_expense',
} as const satisfies Record<string, history.ActivityType>
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, type]) => [type, name])) as { [K in keyof typeof TYPES as (typeof TYPES)[K]]: K }
const ActivityTypeInput = Schema.Literals(Object.keys(TYPES) as [keyof typeof TYPES, ...(keyof typeof TYPES)[]])

/** The live expense beside a current Log entry (the current app's `expense` convenience field). */
const LiveExpense = Schema.Struct({
  id: Id,
  groupId: Id,
  title: Schema.String,
  vendor: NullableString,
  amount: Money,
  currencyCode: Schema.String,
  createdAt: DateTime,
  expenseDate: DateTime,
  categoryId: Schema.Int,
  paidById: Id,
  originalAmount: Schema.NullOr(Money),
  originalCurrency: NullableString,
  conversionRate: NullableString,
  isReimbursement: Schema.Boolean,
  splitMode: SplitModeInput,
  notes: NullableString,
  recurrenceRule: Schema.NullOr(RecurrenceInput),
  recurringExpenseLinkId: Schema.NullOr(Id),
  deletedAt: Schema.NullOr(DateTime),
  revision: NonNegativeInt,
})

type LiveRow = {
  id: string
  group_id: string
  title: string
  vendor: string | null
  amount: string
  currency: string
  created_at: string
  expense_date: string
  category_id: number
  original_amount: string | null
  original_currency: string | null
  conversion_rate: string | null
  kind: 'expense' | 'payment'
  split_mode: keyof typeof MODE_NAMES
  notes: string
  recurrence: Rule
  link_id: string | null
  revision: number
  payers: { participantId: string; amount: string }[]
}

/** The live rows of the expenses on a page. listActivities has checked access to the group. */
async function liveExpenses(db: Parameters<typeof history.listActivities>[0], data: { group: string; ids: readonly string[] }) {
  if (data.ids.length === 0) return new Map<string, typeof LiveExpense.Encoded>()
  const result = await db.execute<LiveRow>(sql`
    SELECT e.id, e.group_id, e.title, e.vendor, e.amount::text AS amount, e.currency, ${iso(sql`e.created_at`)} AS created_at,
      e.expense_date::text AS expense_date, e.category_id, e.original_amount::text AS original_amount, e.original_currency, e.conversion_rate,
      e.kind, e.split_mode, e.notes, e.recurrence, e.revision,
      (SELECT l.id FROM recurring_links l WHERE l.current_frame_expense_id = e.id LIMIT 1) AS link_id,
      coalesce((SELECT json_agg(json_build_object('participantId', p.participant_id, 'amount', p.amount::text)) FROM expense_payers p WHERE p.expense_id = e.id), '[]') AS payers
    FROM expenses e
    WHERE e.group_id = agentsplit_group_id(${data.group}) AND e.deleted_at IS NULL AND e.id IN (${sql.join(data.ids.map((id) => sql`${id}`), sql`, `)})`)
  return new Map(
    result.rows.map((e) => [
      e.id,
      {
        id: e.id,
        groupId: e.group_id,
        title: e.title,
        vendor: e.vendor,
        amount: money(e.amount, e.currency),
        currencyCode: e.currency,
        createdAt: e.created_at,
        expenseDate: `${e.expense_date}T00:00:00.000Z`,
        categoryId: e.category_id,
        paidById: e.payers.length ? preferredPayer(e.payers.map((p) => ({ participantId: p.participantId, amount: minor(BigInt(p.amount)) }))) : '',
        originalAmount: e.original_amount === null || e.original_currency === null ? null : money(e.original_amount, e.original_currency),
        originalCurrency: e.original_currency,
        conversionRate: e.conversion_rate,
        isReimbursement: e.kind === 'payment',
        splitMode: MODE_NAMES[e.split_mode],
        notes: e.notes === '' ? null : e.notes,
        recurrenceRule: RULE_NAMES[e.recurrence],
        recurringExpenseLinkId: e.link_id,
        deletedAt: null,
        revision: e.revision,
      },
    ]),
  )
}

export const listActivity = defineTool({
  name: 'list_activity',
  kind: 'read',
  description:
    'Paginate append-only audit history with optional expenseId, activityType, inclusive UTC from/to dates, or precise recordedFrom/recordedTo timestamps. order=asc walks evolution; desc shows newest first. asOf selects a recorded-time cutoff; atActivityId selects an exact inclusive boundary. Reuse the returned atActivityId on every subsequent page with the same filters/order for a stable view. Includes snapshots, previousSnapshot, deletion markers and actor identity from authenticated web sessions or keys; legacy labels may be unverified. agentKeyId is shown for your own changes only. Uploaded bytes are pointers only. Explicit historical queries omit the current expense convenience field.',
  input: Schema.Struct({
    ...HistoryFields,
    recordedFrom: optional(RecordedTime),
    recordedTo: optional(RecordedTime),
    order: optional(Schema.Literals(['asc', 'desc']).annotate({ default: 'desc' })),
    groupId: ShortId,
    cursor: optional(NonNegativeInt.annotate({ default: 0 })),
    limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({ default: 5 })),
    expenseId: optional(ShortId),
    from: optional(CalendarDate),
    to: optional(CalendarDate),
    activityType: optional(ActivityTypeInput),
  }),
  strict: [''],
  output: Schema.Struct({
    atActivityId: NullableString,
    asOf: DateTime,
    activities: Schema.Array(
      Schema.Struct({
        id: Id,
        groupId: Id,
        time: DateTime,
        activityType: ActivityTypeInput,
        participantId: NullableString,
        expenseId: NullableString,
        data: NullableString,
        expenseRevision: Schema.NullOr(NonNegativeInt),
        snapshot: Snapshot,
        previousSnapshot: Snapshot,
        source: Schema.String,
        actorName: NullableString,
        actorUserId: NullableString,
        agentKeyId: NullableString,
        expense: optional(LiveExpense),
      }),
    ),
    hasMore: Schema.Boolean,
    nextCursor: NonNegativeInt,
  }),
  run: async ({ db, principal }, input) => {
    const { activityType, groupId, ...query } = input
    const page = await history.listActivities(db, { principal, group: groupId, withActors: true, ...query, ...(activityType ? { type: TYPES[activityType] } : {}) })
    const historical = input.asOf !== undefined || input.atActivityId !== undefined
    const live = historical
      ? new Map<string, typeof LiveExpense.Encoded>()
      : await liveExpenses(db, { group: groupId, ids: [...new Set(page.activities.flatMap((a) => (a.expense && a.expenseId ? [a.expenseId] : [])))] })
    return {
      atActivityId: page.atActivityId,
      asOf: page.asOf,
      activities: page.activities.map((a) => {
        const current = a.expenseId ? live.get(a.expenseId) : undefined
        return {
          id: a.id,
          groupId,
          time: a.time,
          activityType: TYPE_NAMES[a.type],
          participantId: a.participantId,
          expenseId: a.expenseId,
          data: a.data,
          expenseRevision: a.expenseRevision,
          snapshot: snapshotOf({ state: a.snapshot, groupId }),
          previousSnapshot: snapshotOf({ state: a.previousSnapshot, groupId }),
          source: a.source === 'mcp' ? 'agent' : a.source,
          actorName: a.actorName,
          actorUserId: a.actor?.userId ?? null,
          // Key and connection IDs of other people stay private (DECISIONS.md group B, P-EXPORT-14).
          agentKeyId: a.actor && a.actor.userId === principal.userId ? a.actor.agentKeyId : null,
          ...(current ? { expense: current } : {}),
        }
      }),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    }
  },
})

// ---------- export_group ----------

export const exportGroup = defineTool({
  name: 'export_group',
  kind: 'read',
  description:
    'Export the authorized group as CSV or JSON. Returns filename, contentType and complete UTF-8 content. JSON includes preserved audit history; deleted expenses are excluded from current expense rows. This read does not process recurrence.',
  input: Schema.Struct({ groupId: ShortId, format: optional(Schema.Literals(['json', 'csv']).annotate({ default: 'json' })) }),
  strict: [''],
  output: Schema.Struct({ filename: Schema.String, contentType: Schema.String, content: Schema.String }),
  run: async ({ db, principal }, input) => {
    const format = input.format ?? 'json'
    // The same file as the export.group RPC.
    const file = await (format === 'json' ? exports.exportJson : exports.exportCsv)(db, { principal, group: input.groupId })
    return { filename: `agentsplit-${file.groupId}.${format}`, contentType: format === 'json' ? 'application/json' : 'text/csv', content: file.content }
  },
})

export const historyTools = [getSpendingStats, listActivity, exportGroup]
