// Minor-unit arithmetic without Effect, for the client and the server alike.
// src/shared/money.ts holds the Effect Schemas of money values.
import type { Brand } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'

/** An integer count of a currency's minor units (cents for USD, yen for JPY). */
export type Minor = bigint & { readonly Minor: unique symbol }
export const minor = (value: bigint): Minor => value as Minor

/** An exact decimal amount as text, such as "12.30" or "-5". Never a float. The schema is DecimalString in money.ts. */
export type DecimalString = Brand.Branded<string, 'DecimalString'>
/** The form of a DecimalString. */
export const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/

/** Minor units from a decimal string, or null if it is malformed or has more decimals than the currency allows. */
export function minorOrNull(data: { amount: string; currency: CurrencyCode }): Minor | null {
  const { decimals } = CURRENCIES[data.currency]
  if (!DECIMAL.test(data.amount)) return null
  const negative = data.amount.startsWith('-')
  const [whole = '0', rawFraction = ''] = (negative ? data.amount.slice(1) : data.amount).split('.')
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > decimals) return null
  const units = BigInt(whole + fraction.padEnd(decimals, '0'))
  return minor(negative ? -units : units)
}

/** Minor units of decimal text that the server formatted, so it always fits its currency; anything else is a bug. */
export function minorOf(amount: string, currency: CurrencyCode): Minor {
  const value = minorOrNull({ amount, currency })
  if (value === null) throw new Error(`${amount} is not a ${currency} amount`)
  return value
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
