import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { groupDigits } from '~/shared/minor'

/** Shows an exact decimal amount with its currency symbol, such as "$12.30" or "-¥600". */
export function money(amount: string, currency: CurrencyCode) {
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  const [whole = '0', fraction] = digits.split('.')
  return `${negative ? '-' : ''}${CURRENCIES[currency].symbol}${groupDigits(whole)}${fraction ? `.${fraction}` : ''}`
}
