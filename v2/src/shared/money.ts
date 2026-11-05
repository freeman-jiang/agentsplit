import { Result, Schema } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'

export const CurrencyCodeSchema = Schema.Literals(
  Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]],
)

/** An exact decimal amount as text, such as "12.30" or "-5". Never a float. */
export const DecimalString = Schema.String.check(
  Schema.isPattern(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
).pipe(Schema.brand('DecimalString'))
export type DecimalString = typeof DecimalString.Type

/** An integer count of a currency's minor units (cents for USD, yen for JPY). */
export type Minor = bigint & { readonly Minor: unique symbol }
export const minor = (value: bigint): Minor => value as Minor

export class MoneyPrecisionError extends Schema.TaggedError<MoneyPrecisionError>()(
  'MoneyPrecisionError',
  { amount: Schema.String, currency: Schema.String, decimals: Schema.Number },
) {}

/** Parses a decimal string into minor units. Fails if it has more decimals than the currency allows. */
export function parseMinor(data: {
  amount: string
  currency: CurrencyCode
}): Result.Result<Minor, MoneyPrecisionError> {
  const { decimals } = CURRENCIES[data.currency]
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(data.amount)
  const fail = () =>
    Result.fail(
      new MoneyPrecisionError({ amount: data.amount, currency: data.currency, decimals }),
    )
  if (!match) return fail()
  const [, sign, whole, rawFraction = ''] = match
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > decimals) return fail()
  const units = BigInt((whole ?? '0') + fraction.padEnd(decimals, '0'))
  return Result.succeed(minor(sign === '-' ? -units : units))
}

/** Formats minor units as an exact decimal string with the currency's full decimals ("12.30"). */
export function formatMinor(data: { amount: Minor; currency: CurrencyCode }): DecimalString {
  const { decimals } = CURRENCIES[data.currency]
  const negative = data.amount < 0n
  const digits = (negative ? -data.amount : data.amount).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`
  return `${negative ? '-' : ''}${whole}${fraction}` as DecimalString
}

export const sumMinor = (values: Iterable<Minor>): Minor => {
  let total = 0n
  for (const value of values) total += value
  return minor(total)
}
