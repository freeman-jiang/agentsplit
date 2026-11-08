// The core area of the contract (index.ts merges every area): the declared
// errors, the shapes that the other areas share, and the session, group and
// expense procedures.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { GROUP_DENIED, INVALID_REASONS, NOT_FOUND_ENTITIES } from '../errors'
import { CALENDAR_DATE, isRealDate } from '../dates'
import { GROUP_ID } from '../ids'
import { LIMITS } from '../limits'
import { CurrencyCodeSchema, DecimalOutput, DecimalString } from '../money'
import { EXPENSE_KINDS, GROUP_KINDS, RECURRENCES, ROLES, SPLIT_MODES } from '../vocabulary'

export const SplitModeSchema = Schema.Literals(SPLIT_MODES)
export const RecurrenceSchema = Schema.Literals(RECURRENCES)
export const ExpenseKindSchema = Schema.Literals(EXPENSE_KINDS)
export const RoleSchema = Schema.Literals(ROLES)
export const GroupKindSchema = Schema.Literals(GROUP_KINDS)
/** A name as typed, which the server trims and checks (trimmedName in src/shared/groups.ts). */
export const NameInput = Schema.String.check(Schema.isMaxLength(LIMITS.nameInputMax))
/** An email as typed, which the server trims and lowercases (normalizeEmail). */
export const EmailInput = Schema.String.check(Schema.isMaxLength(LIMITS.emailMax))
/** Search text in a list filter. */
export const SearchText = Schema.String.check(Schema.isMaxLength(LIMITS.searchMax))

// ---------- errors ----------
// What each one means to a caller, and how MCP answers it, is in src/shared/errors.ts.

export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { message: Schema.String }) {}
/** A group that does not exist and a group the caller cannot see give the same error. */
export const groupAccessDenied = () => new Forbidden({ message: GROUP_DENIED })
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { entity: Schema.Literals(NOT_FOUND_ENTITIES), id: Schema.String }) {}
/** The expected revision is not the current one: read again, then retry. */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  entity: Schema.String,
  id: Schema.String,
  currentRevision: Schema.Number,
  /** What conflicts, when it is not a revision: an ID in use. */
  message: Schema.optional(Schema.String),
}) {}
/** The request cannot apply, for the arguments or for a `reason` (src/shared/errors.ts). */
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', {
  message: Schema.String,
  field: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Literals(INVALID_REASONS)),
}) {}
/** The server could not complete the request; the outcome of a write is unknown, so read before retrying. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', { message: Schema.String }) {}

export const ReadError = Schema.Union([Unauthorized, Forbidden, NotFound, Invalid, Unavailable])
export const WriteError = Schema.Union([Unauthorized, Forbidden, NotFound, Conflict, Invalid, Unavailable])

// ---------- shapes ----------

export const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
/** A caller-chosen ID for a new record: 21 URL-safe characters, the format of randomId(). */
export const NewId = Schema.String.check(Schema.isPattern(GROUP_ID))
/** The offset of a page: the number of rows before it. */
export const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** The rows of one page. */
export const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.pageMax }))
/** A client-chosen key that makes a write safe to retry. */
export const IdempotencyKey = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128))
/** A real calendar date, YYYY-MM-DD: 2026-02-29 and 2026-09-31 are refused before they reach SQL. */
export const CalendarDate = Schema.String.check(
  Schema.isPattern(CALENDAR_DATE),
  Schema.makeFilter((value: string) => isRealDate(value) || 'Invalid calendar date'),
)
/** A calendar date the server produces from a DATE column; not checked again on encode. */
export const CalendarDateOutput = Schema.String
/** An ISO 8601 time in UTC, as the server writes it. */
export const Timestamp = Schema.String

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
  role: RoleSchema,
  /** The caller's participant in this group, when bound. */
  participantId: Schema.NullOr(Schema.String),
})

export const Balance = Schema.Struct({
  participantId: Schema.String,
  currency: CurrencyCodeSchema,
  paid: DecimalOutput,
  owed: DecimalOutput,
  net: DecimalOutput,
})

/** The caller's net per currency across groups, sorted by code: the dashboard's and the directory's totals. Currencies are never added together. */
export const CallerTotals = Schema.Array(Schema.Struct({ currency: CurrencyCodeSchema, net: DecimalOutput }))

export const Group = Schema.Struct({
  ...GroupSummary.fields,
  /**
   * The expense of a private context; null for a named group. A private
   * context is the hidden group of one ungrouped expense; its pages are at
   * /expenses/<contextExpenseId> (P-GROUP-47).
   */
  contextExpenseId: Schema.NullOr(Schema.String),
  information: Schema.String,
  revision: Schema.Number,
  participants: Schema.Array(Participant),
})

export const Part = Schema.Struct({ participantId: Schema.String, amount: DecimalOutput })
/** A suggested repayment: `from` pays `to`. */
export const Transfer = Schema.Struct({ from: Schema.String, to: Schema.String, amount: DecimalOutput })
export const SharePart = Schema.Struct({ participantId: Schema.String, amount: DecimalOutput, weight: Schema.String })
const PartInput = Schema.Struct({ participantId: Id, amount: DecimalString })

export const Expense = Schema.Struct({
  id: Schema.String,
  groupId: Schema.String,
  revision: Schema.Number,
  kind: ExpenseKindSchema,
  title: Schema.String,
  vendor: Schema.NullOr(Schema.String),
  notes: Schema.String,
  categoryId: Schema.Number,
  expenseDate: CalendarDateOutput,
  currency: CurrencyCodeSchema,
  amount: DecimalOutput,
  splitMode: SplitModeSchema,
  payers: Schema.Array(Part),
  shares: Schema.Array(SharePart),
  recurrence: RecurrenceSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  documentCount: Schema.Number,
  /** Who recorded revision 1, and who made the latest edit; null when history does not say. */
  addedBy: Schema.NullOr(Schema.String),
  editedBy: Schema.NullOr(Schema.String),
})

export const ExpenseSort = Schema.Literals(['date', 'updated'])

export const CategoryId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Which expenses a list keeps; the live list (ledger.ts) and the historical one (history.ts) read the same filter. */
export const ExpenseFilter = Schema.Struct({
  sort: Schema.optionalKey(ExpenseSort),
  /** Case-insensitive substring of the title, the vendor or the notes. */
  search: Schema.optionalKey(SearchText),
  /** Exact vendor, ignoring case and the spaces around it. */
  vendor: Schema.optionalKey(SearchText),
  participantId: Schema.optionalKey(Id),
  payerId: Schema.optionalKey(Id),
  currency: Schema.optionalKey(CurrencyCodeSchema),
  categoryId: Schema.optionalKey(CategoryId),
  kind: Schema.optionalKey(ExpenseKindSchema),
  recurrence: Schema.optionalKey(RecurrenceSchema),
  /** Inclusive bounds on the expense date. */
  from: Schema.optionalKey(CalendarDate),
  to: Schema.optionalKey(CalendarDate),
})

export const ExpensePage = Schema.Struct({
  expenses: Schema.Array(Expense),
  /** Pass back as `cursor` to read the next page; null at the end. */
  nextCursor: Schema.NullOr(Schema.String),
})

/** A receipt attached to an expense. The URL must name a receipt uploaded to the same group. */
export const DocumentInput = Schema.Struct({
  id: Id,
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.urlMax)).annotate({ format: 'uri' }),
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})

/** An expense's full list of receipts. */
export const Documents = Schema.Array(DocumentInput).check(Schema.isMaxLength(LIMITS.documentsPerExpense))

/** What a client sends to create or replace an expense. Amounts are exact decimal strings. */
export const ExpenseInput = Schema.Struct({
  kind: ExpenseKindSchema,
  title: Schema.String.check(Schema.isBetweenLength(LIMITS.titleMin, LIMITS.titleMax)),
  vendor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(LIMITS.vendorMax))),
  notes: Schema.String.check(Schema.isMaxLength(LIMITS.notesMax)),
  categoryId: CategoryId,
  expenseDate: CalendarDate,
  currency: CurrencyCodeSchema,
  amount: DecimalString,
  /** Who paid, and how much each; amounts sum to `amount`. */
  payers: Schema.Array(PartInput).check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup)),
  splitMode: SplitModeSchema,
  /** Who shares the cost, with each person's weight: a share count, a percentage, or an exact amount. */
  shares: Schema.Array(Schema.Struct({ participantId: Id, weight: Schema.String.check(Schema.isMaxLength(LIMITS.decimalMax)) })).check(
    Schema.isBetweenLength(1, LIMITS.participantsPerGroup),
  ),
  recurrence: RecurrenceSchema,
  /** The full list of receipts. Omitted on an update: keep the saved receipts. */
  documents: Schema.optionalKey(Documents),
})

// ---------- procedures ----------

export class CoreApi extends RpcGroup.make(
  Rpc.make('session.me', { success: Schema.NullOr(Me), error: Unavailable }),
  Rpc.make('groups.list', { success: Schema.Array(GroupSummary), error: ReadError }),
  Rpc.make('groups.get', { payload: { groupId: Id }, success: Group, error: ReadError }),
  Rpc.make('expenses.list', {
    payload: { groupId: Id, filter: ExpenseFilter, cursor: Schema.NullOr(Schema.String), limit: PageLimit },
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
