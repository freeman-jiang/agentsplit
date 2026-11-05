// The typed contract between the SPA and the Worker. MCP tools call the same
// domain services, so these schemas also describe agent writes.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { CurrencyCodeSchema, DecimalString } from './money'
import { SplitModeSchema } from './split'

// ---------- errors ----------

export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { message: Schema.String }) {}
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { entity: Schema.String, id: Schema.String }) {}
/** The expected revision is not the current one: read again, then retry. */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  entity: Schema.String,
  id: Schema.String,
  currentRevision: Schema.Number,
}) {}
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', { message: Schema.String, field: Schema.optional(Schema.String) }) {}
/** The server could not complete the request; the outcome of a write is unknown, so read before retrying. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', { message: Schema.String }) {}

const ReadError = Schema.Union([Unauthorized, Forbidden, NotFound, Unavailable])
const WriteError = Schema.Union([Unauthorized, Forbidden, NotFound, Conflict, Invalid, Unavailable])

// ---------- shapes ----------

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
/** A client-chosen key that makes a write safe to retry. */
const IdempotencyKey = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128))
/** A calendar date, YYYY-MM-DD. */
export const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/))
const Timestamp = Schema.String // ISO 8601, UTC

export const Me = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
})

export const Participant = Schema.Struct({ id: Schema.String, name: Schema.String })

export const GroupSummary = Schema.Struct({
  id: Schema.String,
  slug: Schema.NullOr(Schema.String),
  name: Schema.String,
  defaultCurrency: CurrencyCodeSchema,
  role: Schema.Literals(['admin', 'member']),
  /** The caller's participant in this group, when bound. */
  participantId: Schema.NullOr(Schema.String),
})

export const Balance = Schema.Struct({
  participantId: Schema.String,
  currency: CurrencyCodeSchema,
  paid: DecimalString,
  owed: DecimalString,
  net: DecimalString,
})

export const Group = Schema.Struct({
  ...GroupSummary.fields,
  information: Schema.String,
  revision: Schema.Number,
  participants: Schema.Array(Participant),
  /** Balances for the whole group, independent of any expense filter. */
  balances: Schema.Array(Balance),
})

export const Part = Schema.Struct({ participantId: Schema.String, amount: DecimalString })
export const SharePart = Schema.Struct({ participantId: Schema.String, amount: DecimalString, weight: Schema.String })

export const Expense = Schema.Struct({
  id: Schema.String,
  groupId: Schema.String,
  revision: Schema.Number,
  kind: Schema.Literals(['expense', 'payment']),
  title: Schema.String,
  vendor: Schema.NullOr(Schema.String),
  notes: Schema.String,
  categoryId: Schema.Number,
  expenseDate: CalendarDate,
  currency: CurrencyCodeSchema,
  amount: DecimalString,
  splitMode: SplitModeSchema,
  payers: Schema.Array(Part),
  shares: Schema.Array(SharePart),
  recurrence: Schema.Literals(['none', 'daily', 'weekly', 'monthly']),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  documentCount: Schema.Number,
})

export const ExpenseSort = Schema.Literals(['date', 'updated'])

export const ExpenseFilter = Schema.Struct({
  sort: Schema.optionalKey(ExpenseSort),
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  participantId: Schema.optionalKey(Id),
  payerId: Schema.optionalKey(Id),
  currency: Schema.optionalKey(CurrencyCodeSchema),
  categoryId: Schema.optionalKey(Schema.Number),
  kind: Schema.optionalKey(Schema.Literals(['expense', 'payment'])),
  from: Schema.optionalKey(CalendarDate),
  to: Schema.optionalKey(CalendarDate),
})

export const ExpensePage = Schema.Struct({
  expenses: Schema.Array(Expense),
  /** Pass back as `cursor` to read the next page; null at the end. */
  nextCursor: Schema.NullOr(Schema.String),
})

/** What a client sends to create or replace an expense. Amounts are exact decimal strings. */
export const ExpenseInput = Schema.Struct({
  kind: Schema.Literals(['expense', 'payment']),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  vendor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  notes: Schema.String.check(Schema.isMaxLength(10_000)),
  categoryId: Schema.Number,
  expenseDate: CalendarDate,
  currency: CurrencyCodeSchema,
  amount: DecimalString,
  /** Who paid, and how much each; amounts sum to `amount`. */
  payers: Schema.Array(Part).check(Schema.isMinLength(1)),
  splitMode: SplitModeSchema,
  /** Who shares the cost, with each person's weight: a share count, a percentage, or an exact amount. */
  shares: Schema.Array(Schema.Struct({ participantId: Id, weight: Schema.String })).check(Schema.isMinLength(1)),
  recurrence: Schema.Literals(['none', 'daily', 'weekly', 'monthly']),
})

// ---------- procedures ----------

export class AgentSplitApi extends RpcGroup.make(
  Rpc.make('session.me', { success: Schema.NullOr(Me), error: Unavailable }),
  Rpc.make('groups.list', { success: Schema.Array(GroupSummary), error: ReadError }),
  Rpc.make('groups.get', { payload: { groupId: Id }, success: Group, error: ReadError }),
  Rpc.make('expenses.list', {
    payload: { groupId: Id, filter: ExpenseFilter, cursor: Schema.NullOr(Schema.String), limit: Schema.Number },
    success: ExpensePage,
    error: ReadError,
  }),
  Rpc.make('expenses.get', { payload: { groupId: Id, expenseId: Id }, success: Expense, error: ReadError }),
  Rpc.make('expenses.create', {
    payload: { groupId: Id, expenseId: Id, idempotencyKey: IdempotencyKey, expense: ExpenseInput },
    success: Expense,
    error: WriteError,
  }),
  Rpc.make('expenses.update', {
    payload: { groupId: Id, expenseId: Id, expectedRevision: Schema.Number, idempotencyKey: IdempotencyKey, expense: ExpenseInput },
    success: Expense,
    error: WriteError,
  }),
  Rpc.make('expenses.delete', {
    payload: { groupId: Id, expenseId: Id, expectedRevision: Schema.Number, idempotencyKey: IdempotencyKey },
    success: Schema.Struct({ revision: Schema.Number }),
    error: WriteError,
  }),
) {}
