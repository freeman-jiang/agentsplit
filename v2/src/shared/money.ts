import { Result, Schema } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'
import { minorOrNull, type Minor } from './minor'

export const CurrencyCodeSchema = Schema.Literals(
  Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]],
)

/** An exact decimal amount as text, such as "12.30" or "-5". Never a float. */
export const DecimalString = Schema.String.check(
  Schema.isPattern(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
).pipe(Schema.brand('DecimalString'))
export type DecimalString = typeof DecimalString.Type

/**
 * The same brand without the pattern check, for values the server produces with
 * formatMinor. Encoding a response then runs no regular expression per amount,
 * which keeps large lists within the Workers CPU budget. Inputs use DecimalString.
 */
export const DecimalOutput = Schema.String.pipe(Schema.brand('DecimalString'))

export { formatMinor, minor, sumMinor, type Minor } from './minor'

export class MoneyPrecisionError extends Schema.TaggedError<MoneyPrecisionError>()(
  'MoneyPrecisionError',
  { amount: Schema.String, currency: Schema.String, decimals: Schema.Number },
) {}

/** Parses a decimal string into minor units. Fails if it has more decimals than the currency allows. */
export function parseMinor(data: { amount: string; currency: CurrencyCode }): Result.Result<Minor, MoneyPrecisionError> {
  const value = minorOrNull(data)
  return value === null
    ? Result.fail(new MoneyPrecisionError({ amount: data.amount, currency: data.currency, decimals: CURRENCIES[data.currency].decimals }))
    : Result.succeed(value)
}
