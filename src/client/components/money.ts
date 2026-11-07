import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { groupDigits, minorOrNull } from '~/shared/minor'

/** Shows an exact decimal amount with its currency symbol, such as "$12.30" or "-¥600". */
export function money(amount: string, currency: CurrencyCode) {
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  const [whole = '0', fraction] = digits.split('.')
  return `${negative ? '-' : ''}${CURRENCIES[currency].symbol}${groupDigits(whole)}${fraction ? `.${fraction}` : ''}`
}

/** The minor units of a decimal amount for display: text that does not parse counts as zero. */
export const unitsOf = (amount: string, currency: CurrencyCode): bigint => minorOrNull({ amount, currency }) ?? 0n
