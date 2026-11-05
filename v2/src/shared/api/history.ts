// History (the group Log, saved revisions, reads "as of" a recorded change),
// the Stats tab and exports. Reads only: none of these procedures writes.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { CurrencyCodeSchema, DecimalOutput } from '../money'
import { SplitModeSchema } from '../split'
import { Balance, CalendarDate, CalendarDateOutput, Id, Participant, ReadError } from './core'

export const ActivityType = Schema.Literals(['create_group', 'join_group', 'leave_group', 'update_group', 'create_expense', 'update_expense', 'delete_expense'])

/** A recorded-change time with a time zone and at most millisecond precision, such as 2026-10-01T15:00:00Z. Not an expense date. */
export const RecordedTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/),
)

/** Pick at most one: the history boundary to read at. Reuse a returned `atActivityId` for stable pages. */
const Boundary = {
  asOf: Schema.optionalKey(RecordedTime),
  atActivityId: Schema.optionalKey(Id),
}

const Recurrence = Schema.Literals(['none', 'daily', 'weekly', 'monthly'])
const CategoryRef = Schema.Struct({ grouping: Schema.String, name: Schema.String })

/** One saved expense revision, read from either snapshot format. Money is decimal text at the currency's precision. */
export const SavedExpense = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  id: Schema.String,
  revision: Schema.Number,
  kind: Schema.Literals(['expense', 'payment']),
  title: Schema.String,
  vendor: Schema.NullOr(Schema.String),
  notes: Schema.String,
  categoryId: Schema.Number,
  category: Schema.NullOr(CategoryRef),
  expenseDate: CalendarDateOutput,
  createdAt: Schema.String,
  currency: CurrencyCodeSchema,
  amount: DecimalOutput,
  payers: Schema.Array(Schema.Struct({ participantId: Schema.String, name: Schema.String, amount: DecimalOutput })),
  splitMode: SplitModeSchema,
  shares: Schema.Array(Schema.Struct({ participantId: Schema.String, name: Schema.String, amount: DecimalOutput, weight: Schema.String })),
  recurrence: Recurrence,
  originalAmount: Schema.NullOr(Schema.String),
  originalCurrency: Schema.NullOr(Schema.String),
  conversionRate: Schema.NullOr(Schema.String),
  documents: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
  documentCount: Schema.Number,
})

export const SavedGroup = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  name: Schema.String,
  slug: Schema.NullOr(Schema.String),
  currency: Schema.String,
  information: Schema.String,
  participants: Schema.Array(Participant),
})

export const SavedState = Schema.Union([
  Schema.TaggedStruct('expense', { expense: SavedExpense }),
  Schema.TaggedStruct('group', { group: SavedGroup }),
])

export const Activity = Schema.Struct({
  id: Schema.String,
  time: Schema.String,
  type: ActivityType,
  participantId: Schema.NullOr(Schema.String),
  expenseId: Schema.NullOr(Schema.String),
  expenseRevision: Schema.NullOr(Schema.Number),
  /** The expense title, or the access change without user IDs or email addresses. */
  data: Schema.NullOr(Schema.String),
  source: Schema.String,
  /** The account name, or the claimed participant's name for writes without an account. */
  actorName: Schema.NullOr(Schema.String),
  /** A signed-in account made the change; otherwise the name is an unverified label. */
  verified: Schema.Boolean,
  /** An agent connection made the change. */
  agent: Schema.Boolean,
  snapshot: Schema.NullOr(SavedState),
  /** The revision before this one, also when it is outside the page. */
  previousSnapshot: Schema.NullOr(SavedState),
  /** The live expense, for current reads of an expense that is not deleted; always null for historical reads. */
  expense: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(['expense', 'payment']) })),
})

export const ActivityPage = Schema.Struct({
  atActivityId: Schema.NullOr(Schema.String),
  asOf: Schema.String,
  activities: Schema.Array(Activity),
  hasMore: Schema.Boolean,
  /** The offset of the next page. */
  nextCursor: Schema.Number,
})

export const HistoryView = Schema.Struct({
  asOf: Schema.String,
  atActivityId: Schema.NullOr(Schema.String),
  /** False when some expenses have no saved state at the boundary; they are listed by ID. */
  complete: Schema.Boolean,
  unavailableExpenseIds: Schema.Array(Schema.String),
})

export const HistoricalExpenseFilter = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Exact vendor, ignoring case. */
  vendor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  currency: Schema.optionalKey(CurrencyCodeSchema),
  categoryId: Schema.optionalKey(Schema.Number),
  payerId: Schema.optionalKey(Id),
  participantId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(Schema.Literals(['expense', 'payment'])),
  recurrence: Schema.optionalKey(Recurrence),
  from: Schema.optionalKey(CalendarDate),
  to: Schema.optionalKey(CalendarDate),
})

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

const Amount = DecimalOutput
const StatsRow = Schema.Struct({ id: Schema.String, kind: Schema.Literals(['expense', 'payment']), title: Schema.String, vendor: Schema.NullOr(Schema.String), amount: Amount, expenseDate: CalendarDateOutput, currency: CurrencyCodeSchema })
const MonthlyCategory = Schema.Struct({
  key: Schema.String,
  categoryId: Schema.NullOr(Schema.Number),
  grouping: Schema.String,
  name: Schema.String,
  amount: Amount,
  expense: Amount,
  income: Amount,
})

export const StatsOverview = Schema.Struct({
  currency: CurrencyCodeSchema,
  currencies: Schema.Array(CurrencyCodeSchema),
  /** The caller's participant; null hides the personal totals. */
  participantId: Schema.NullOr(Schema.String),
  total: Amount,
  yourPaid: Schema.NullOr(Amount),
  yourShare: Schema.NullOr(Amount),
  summary: Schema.Struct({
    count: Schema.Number,
    average: Amount,
    largest: Schema.NullOr(Schema.Struct({ title: Schema.String, amount: Amount })),
    firstDate: Schema.NullOr(Schema.String),
    lastDate: Schema.NullOr(Schema.String),
  }),
  months: Schema.Array(Schema.Struct({ month: Schema.String, total: Amount })),
  monthly: Schema.Struct({
    months: Schema.Array(Schema.Struct({ key: Schema.String, amount: Amount, expense: Amount, income: Amount, categories: Schema.Array(MonthlyCategory) })),
    categories: Schema.Array(MonthlyCategory),
    maxExpense: Amount,
  }),
  participants: Schema.Array(Schema.Struct({ participantId: Schema.String, name: Schema.String, paid: Amount, count: Schema.Number, share: Amount })),
  categories: Schema.Array(Schema.Struct({ categoryId: Schema.Number, grouping: Schema.String, name: Schema.String, total: Amount, percent: Schema.Number })),
  recurring: Schema.Struct({
    count: Schema.Number,
    byPeriod: Schema.Array(Schema.Struct({ period: Schema.Literals(['daily', 'weekly', 'monthly']), count: Schema.Number, total: Amount })),
    monthly: Amount,
    yearly: Amount,
  }),
})

const StatsScope = {
  groupId: Id,
  currency: Schema.optionalKey(CurrencyCodeSchema),
  from: Schema.optionalKey(CalendarDate),
  to: Schema.optionalKey(CalendarDate),
}

export class HistoryApi extends RpcGroup.make(
  Rpc.make('history.activities', {
    payload: {
      groupId: Id,
      ...Boundary,
      cursor: Schema.optionalKey(Offset),
      limit: Schema.optionalKey(PageLimit),
      expenseId: Schema.optionalKey(Id),
      type: Schema.optionalKey(ActivityType),
      /** UTC calendar days of recording, inclusive. */
      from: Schema.optionalKey(CalendarDate),
      to: Schema.optionalKey(CalendarDate),
      recordedFrom: Schema.optionalKey(RecordedTime),
      recordedTo: Schema.optionalKey(RecordedTime),
      order: Schema.optionalKey(Schema.Literals(['asc', 'desc'])),
    },
    success: ActivityPage,
    error: ReadError,
  }),
  Rpc.make('history.expense', {
    payload: { groupId: Id, expenseId: Id, ...Boundary, revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) },
    success: Schema.Struct({
      expense: SavedExpense,
      /** The time of the deletion, when the selected event deleted the expense. */
      deletedAt: Schema.NullOr(Schema.String),
      history: Schema.Struct({ activityId: Schema.String, recordedAt: Schema.String, revision: Schema.Number, deleted: Schema.Boolean }),
    }),
    error: ReadError,
  }),
  Rpc.make('history.expenses', {
    payload: { groupId: Id, ...Boundary, filter: HistoricalExpenseFilter, cursor: Schema.optionalKey(Offset), limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))) },
    success: Schema.Struct({ history: HistoryView, expenses: Schema.Array(SavedExpense), hasMore: Schema.Boolean, nextCursor: Schema.Number }),
    error: ReadError,
  }),
  Rpc.make('history.balances', {
    payload: { groupId: Id, ...Boundary },
    success: Schema.Struct({ history: HistoryView, balances: Schema.Array(Balance) }),
    error: ReadError,
  }),
  Rpc.make('stats.overview', {
    payload: { ...StatsScope, today: Schema.optionalKey(CalendarDate) },
    success: StatsOverview,
    error: ReadError,
  }),
  Rpc.make('stats.expenses', {
    payload: {
      ...StatsScope,
      currency: CurrencyCodeSchema,
      month: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))),
      categoryId: Schema.optionalKey(Schema.Int),
    },
    success: Schema.Array(StatsRow),
    error: ReadError,
  }),
  Rpc.make('export.group', {
    payload: { groupId: Id, format: Schema.Literals(['json', 'csv']) },
    success: Schema.Struct({ filename: Schema.String, contentType: Schema.String, content: Schema.String }),
    error: ReadError,
  }),
) {}
