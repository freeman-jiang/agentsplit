// The expenses area: categories, the edit screen's detail read, balances with
// suggested settlements, recurring series, and reference data. Expense writes
// themselves (create, update, delete) are in core.ts.
import { Record, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { FAIR_USE_LIMITS } from '../limits'
import { CurrencyCodeSchema } from '../money'
import { RECEIPT_CONTENT_TYPES } from '../vocabulary'
import { Balance, CalendarDateOutput, Expense, ExpenseKindSchema, Id, NotFound, ReadError, RecurrenceSchema, SplitModeSchema, Transfer, Unavailable, WriteError } from './core'
import { ReceiptTombstone } from './storage'

export const Category = Schema.Struct({ id: Schema.Number, grouping: Schema.String, name: Schema.String })

export const ExpenseDocument = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** Where the browser or an agent fetches the image; access is checked on every read. */
  downloadUrl: Schema.String,
  /** Set when the receipt was deleted for good: show the tombstone instead of the image. */
  deleted: Schema.NullOr(ReceiptTombstone),
})

const Attribution = Schema.Struct({ at: Schema.String, by: Schema.NullOr(Schema.String) })

export const ExpenseDetail = Schema.Struct({
  expense: Expense,
  documents: Schema.Array(ExpenseDocument),
  added: Schema.NullOr(Attribution),
  edited: Schema.NullOr(Attribution),
  /** When the caller last changed this expense. */
  myLastEdit: Schema.NullOr(Schema.String),
  /** The date of the next occurrence, when this is the newest expense of a recurring series. */
  nextOccurrence: Schema.NullOr(CalendarDateOutput),
})

const { currency: _currency, ...participantBalance } = Balance.fields

export const CurrencyBalances = Schema.Struct({
  currency: CurrencyCodeSchema,
  /** Every participant of the group; paid and owed are real spending, net = paid - owed. */
  balances: Schema.Array(Schema.Struct(participantBalance)),
  /** Payments that settle this currency. */
  settlements: Schema.Array(Transfer),
})

export const Reference = Schema.Struct({
  categories: Schema.Array(Category),
  currencies: Schema.Array(Schema.Struct({ code: CurrencyCodeSchema, name: Schema.String, symbol: Schema.String, decimals: Schema.Number })),
  splitModes: Schema.Array(SplitModeSchema),
  recurrence: Schema.Array(RecurrenceSchema),
  /** Receipts are always on; `enabled` stays for the current app's agents. */
  attachments: Schema.Struct({ enabled: Schema.Boolean, contentTypes: Schema.Array(Schema.Literals(RECEIPT_CONTENT_TYPES)), maxBytes: Schema.Number }),
  /** The fair-use limits (FAIR_USE_LIMITS in src/shared/limits.ts). */
  limits: Schema.Struct({ ...Record.map(FAIR_USE_LIMITS, () => Schema.Number), fairUse: Schema.String }),
})

export class ExpensesApi extends RpcGroup.make(
  Rpc.make('categories.list', { success: Schema.Array(Category), error: Unavailable }),
  Rpc.make('reference.get', { success: Reference, error: Unavailable }),
  Rpc.make('expenses.detail', { payload: { groupId: Id, expenseId: Id }, success: ExpenseDetail, error: ReadError }),
  // Which group an expense belongs to, for links that know only the expense ID.
  Rpc.make('expenses.locate', {
    payload: { expenseId: Id },
    success: Schema.Struct({ groupId: Schema.String, slug: Schema.NullOr(Schema.String), kind: ExpenseKindSchema, title: Schema.String }),
    error: Schema.Union([ReadError, NotFound]),
  }),
  Rpc.make('balances.list', {
    payload: { groupId: Id, currency: Schema.optionalKey(CurrencyCodeSchema) },
    success: Schema.Struct({ currencies: Schema.Array(CurrencyBalances) }),
    error: ReadError,
  }),
  Rpc.make('recurring.list', {
    payload: { groupId: Id },
    success: Schema.Array(Schema.Struct({ expense: Expense, nextDate: CalendarDateOutput })),
    error: ReadError,
  }),
  Rpc.make('recurring.process', {
    payload: { groupId: Id },
    success: Schema.Struct({ createdExpenseIds: Schema.Array(Schema.String) }),
    error: WriteError,
  }),
) {}
