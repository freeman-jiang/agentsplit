import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'

/** Shows an exact decimal amount with its currency symbol, such as "$12.30" or "-¥600". */
export function money(amount: string, currency: CurrencyCode) {
  const negative = amount.startsWith('-')
  const digits = negative ? amount.slice(1) : amount
  const [whole = '0', fraction] = digits.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${CURRENCIES[currency].symbol}${grouped}${fraction ? `.${fraction}` : ''}`
}
