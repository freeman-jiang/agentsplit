// The expenses area: categories, the edit screen's detail read, balances with
// suggested settlements, recurring series, and reference data. Expense writes
// themselves (create, update, delete) are in core.ts.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { CurrencyCodeSchema, DecimalOutput } from '../money'
import { SplitModeSchema } from '../split'
import { CalendarDateOutput, Expense, Id, NotFound, ReadError, Unavailable, WriteError } from './core'

export const Category = Schema.Struct({ id: Schema.Number, grouping: Schema.String, name: Schema.String })

export const ExpenseDocument = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** Where the browser or an agent fetches the image; access is checked on every read. */
  downloadUrl: Schema.String,
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

export const CurrencyBalances = Schema.Struct({
  currency: CurrencyCodeSchema,
  /** Every participant of the group; paid and owed are real spending, net = paid - owed. */
  balances: Schema.Array(Schema.Struct({ participantId: Schema.String, paid: DecimalOutput, owed: DecimalOutput, net: DecimalOutput })),
  /** Payments that settle this currency: `from` pays `to`. */
  settlements: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, amount: DecimalOutput })),
})

export const Reference = Schema.Struct({
  categories: Schema.Array(Category),
  currencies: Schema.Array(Schema.Struct({ code: CurrencyCodeSchema, name: Schema.String, symbol: Schema.String, decimals: Schema.Number })),
  splitModes: Schema.Array(SplitModeSchema),
  recurrence: Schema.Array(Schema.Literals(['none', 'daily', 'weekly', 'monthly'])),
  attachments: Schema.Struct({ enabled: Schema.Boolean, contentTypes: Schema.Array(Schema.String), maxBytes: Schema.Number }),
})

export class ExpensesApi extends RpcGroup.make(
  Rpc.make('categories.list', { success: Schema.Array(Category), error: Unavailable }),
  Rpc.make('reference.get', { success: Reference, error: Unavailable }),
  Rpc.make('expenses.detail', { payload: { groupId: Id, expenseId: Id }, success: ExpenseDetail, error: ReadError }),
  // Which group an expense belongs to, for links that know only the expense ID.
  Rpc.make('expenses.locate', {
    payload: { expenseId: Id },
    success: Schema.Struct({ groupId: Schema.String, slug: Schema.NullOr(Schema.String), kind: Schema.Literals(['expense', 'payment']), title: Schema.String }),
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
