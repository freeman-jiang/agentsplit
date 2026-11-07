// Small pieces the MCP tool areas share: wire formats of the current app.
import { Schema } from 'effect'
import { RecordedTime as HistoryRecordedTime } from '../../../shared/api/history'
import { CURRENCIES, type CurrencyCode } from '../../../shared/currencies'
import { isRealDate } from '../../../shared/dates'
import { DECIMAL, formatMinor, minor } from '../../../shared/minor'
import { RECURRENCE_LIST, SPLIT_MODE_LIST } from '../../../shared/vocabulary'

/** The app origin, without a trailing slash, for links. */
export const origin = (baseUrl: string) => new URL(baseUrl).origin

/** A tool without arguments: an object that closes to `{}`. An empty Struct would allow any value. */
export const NoArguments = Schema.Record(Schema.String, Schema.Never)

export const Id = Schema.String
export const NullableString = Schema.NullOr(Schema.String)
/** An ISO timestamp in output. */
export const DateTime = Schema.String.annotate({ format: 'date-time' })
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Money in output: an exact decimal string in the stated currency. */
export const Money = Schema.String.annotate({ description: 'Exact decimal string in the stated currency, e.g. 12.34' })

// ---------- the current app's names for v2 values (src/shared/vocabulary.ts) ----------

const CODES = Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]
export const CurrencyCodeInput = Schema.Literals(CODES)
export const SplitModeInput = Schema.Literals(SPLIT_MODE_LIST)
export const RecurrenceInput = Schema.Literals(RECURRENCE_LIST)

/** An exact decimal string; JSON numbers, exponents, spaces and separators are refused. */
export const Decimal = Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(DECIMAL))

/** A real calendar date, YYYY-MM-DD (2026-02-29 and 2026-09-31 are refused). */
export const CalendarDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value: string) => isRealDate(value) || 'Invalid calendar date'),
).annotate({ format: 'date' })

export const ShortId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

/** The RPC contract's recorded time: a time zone, and at most millisecond precision. */
export const RecordedTime = HistoryRecordedTime.annotate({ format: 'date-time', description: 'Recorded-change timestamp with timezone, e.g. 2026-10-01T15:00:00Z; not the expense date.' })

/** The history boundary of a historical read (src/server/history.ts). */
export const HistoryFields = {
  asOf: Schema.optionalKey(RecordedTime),
  atActivityId: Schema.optionalKey(ShortId.annotate({ description: 'Exact inclusive history boundary from this group. Reuse the returned boundary for stable pagination.' })),
}

/** Decimal text at the currency's full precision. Stored values are minor units. */
export const money = (amount: string, currency: string) =>
  isCurrencyCode(currency) ? formatMinor({ amount: minor(BigInt(amount)), currency }) : amount

export const isCurrencyCode = (code: string): code is CurrencyCode => code in CURRENCIES

/** The current app's `currency` field: the symbol. v2 stores only the code. */
export const symbolOf = (code: string) => (isCurrencyCode(code) ? CURRENCIES[code].symbol : code)
