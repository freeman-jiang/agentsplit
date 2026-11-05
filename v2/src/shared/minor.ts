// Minor-unit arithmetic without Effect, for the client and the server alike.
// src/shared/money.ts adds the Effect Schema types and the Result-returning
// parseMinor on top of this module; the client imports only this one.
import { CURRENCIES, type CurrencyCode } from './currencies'
import type { DecimalString } from './money'

/** An integer count of a currency's minor units (cents for USD, yen for JPY). */
export type Minor = bigint & { readonly Minor: unique symbol }
export const minor = (value: bigint): Minor => value as Minor

/** Minor units from a decimal string, or null if it is malformed or has more decimals than the currency allows. */
export function minorOrNull(data: { amount: string; currency: CurrencyCode }): Minor | null {
  const { decimals } = CURRENCIES[data.currency]
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(data.amount)
  if (!match) return null
  const [, sign, whole, rawFraction = ''] = match
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > decimals) return null
  const units = BigInt((whole ?? '0') + fraction.padEnd(decimals, '0'))
  return minor(sign === '-' ? -units : units)
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
