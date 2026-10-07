'use client'

import { Currency } from '@/lib/currency'
import { Decimal } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'
import { useLocale } from 'next-intl'

type Props = {
  currency: Currency
  amount: string
  bold?: boolean
  colored?: boolean
}

export function Money({
  currency,
  amount,
  bold = false,
  colored = false,
}: Props) {
  const locale = useLocale()
  return (
    <span
      className={cn(
        colored && new Decimal(amount).lt(0)
          ? 'text-red-600'
          : colored && new Decimal(amount).gt(0)
            ? 'text-green-600'
            : '',
        bold && 'font-bold',
      )}
    >
      {formatCurrency(currency, amount, locale)}
    </span>
  )
}
