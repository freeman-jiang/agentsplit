import { formatCurrency, formatDecimal } from './utils'

type ChartCurrency = Parameters<typeof formatCurrency>[0]

export function formatChartCurrency({
  amount,
  currency,
  locale,
  roundAmounts,
}: {
  amount: string
  currency: ChartCurrency
  locale: string
  roundAmounts: boolean
}) {
  if (!roundAmounts) return formatCurrency(currency, amount, locale)

  const formattedAmount = amount
  const format = new Intl.NumberFormat(locale, {
    currency: currency.code.length ? currency.code : 'USD',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    style: 'currency',
  })

  if (currency.code.length) return formatDecimal(format, formattedAmount)

  return formatDecimal(format, formattedAmount)
    .replace('US$', currency.symbol)
    .replace('$', currency.symbol)
}
