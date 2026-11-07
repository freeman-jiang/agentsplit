// History, stats and export tools: get_spending_stats, list_activity and
// export_group, with the current app's inputs and outputs
// (src/trpc/routers/groups/stats, activities, export.procedure.ts). The
// figures, the Log and the files come from src/server/stats.ts, history.ts
// and export.ts; this file only maps names.
import { Schema } from 'effect'
import { Id as IdInput } from '../../../shared/api'
import { LIMITS } from '../../../shared/limits'
import { ACTIVITY_TYPE_BY_NAME, ACTIVITY_TYPE_NAMES, RECURRENCE_NAMES, RECURRING_PERIODS } from '../../../shared/vocabulary'
import { loadExpenses } from '../../expense-read'
import * as exports from '../../export'
import * as history from '../../history'
import * as stats from '../../stats'
import { CurrencyCodeSchema } from '../../../shared/money'
import { defineTool } from './registry'
import { CalendarDate, HistoryFields, PageLimit } from './inputs'
import { ActivityTypeName, DateTime, expenseRow, ExpenseRow, Id, liveSource, money, Money, NonNegativeInt, NullableString, optional, RecordedTime, Snapshot, snapshotOf } from './wire'

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
    groupId: IdInput,
    participantId: optional(IdInput),
    from: optional(CalendarDate),
    to: optional(CalendarDate),
    currencyCode: optional(CurrencyCodeSchema),
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
      byPeriod: Schema.Array(Schema.Struct({ period: Schema.Literals(RECURRING_PERIODS.map((p) => RECURRENCE_NAMES[p])), count: Schema.Int, total: Money })),
    }),
  }),
  run: async ({ db, principal }, input) => {
    const s = await stats.statsOverview(db, {
      principal,
      groupId: input.groupId,
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
        byPeriod: s.recurring.byPeriod.map((p) => ({ period: RECURRENCE_NAMES[p.period], count: p.count, total: p.total })),
      },
    }
  },
})

// ---------- list_activity ----------

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
    groupId: IdInput,
    cursor: optional(NonNegativeInt.annotate({ default: 0 })),
    limit: optional(PageLimit(LIMITS.agentActivityPage)),
    expenseId: optional(IdInput),
    from: optional(CalendarDate),
    to: optional(CalendarDate),
    activityType: optional(ActivityTypeName),
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
        activityType: ActivityTypeName,
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
        expense: optional(ExpenseRow),
      }),
    ),
    hasMore: Schema.Boolean,
    nextCursor: NonNegativeInt,
  }),
  run: async ({ db, principal }, input) => {
    const { activityType, ...query } = input
    const page = await history.listActivities(db, {
      principal,
      withActors: true,
      ...query,
      limit: query.limit ?? LIMITS.agentActivityPage,
      ...(activityType ? { type: ACTIVITY_TYPE_BY_NAME[activityType] } : {}),
    })
    const { groupId } = page
    const historical = input.asOf !== undefined || input.atActivityId !== undefined
    // The current app's convenience field: the live expense beside a current entry. listActivities has checked access to the group.
    const ids = historical ? [] : [...new Set(page.activities.flatMap((a) => (a.expense && a.expenseId ? [a.expenseId] : [])))]
    const live = new Map(
      (await loadExpenses(db, { ids, groupId }))
        .filter((e) => !e.deleted)
        .map((e) => [e.id, expenseRow(liveSource(e), { groupId: e.groupId, revision: e.revision, linkId: e.link?.id ?? null, deletedAt: null })]),
    )
    return {
      atActivityId: page.atActivityId,
      asOf: page.asOf,
      activities: page.activities.map((a) => {
        const current = a.expenseId ? live.get(a.expenseId) : undefined
        return {
          id: a.id,
          groupId,
          time: a.time,
          activityType: ACTIVITY_TYPE_NAMES[a.type],
          participantId: a.participantId,
          expenseId: a.expenseId,
          data: a.data,
          expenseRevision: a.expenseRevision,
          snapshot: snapshotOf({ state: a.snapshot, groupId }),
          previousSnapshot: snapshotOf({ state: a.previousSnapshot, groupId }),
          source: a.source,
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
  input: Schema.Struct({ groupId: IdInput, format: optional(Schema.Literals(['json', 'csv']).annotate({ default: 'json' })) }),
  strict: [''],
  output: Schema.Struct({ filename: Schema.String, contentType: Schema.String, content: Schema.String }),
  run: async ({ db, principal }, input) => {
    // The same file as the export.group RPC.
    return exports.exportFile(db, { principal, groupId: input.groupId, format: input.format ?? 'json' })
  },
})

