'use client'

import { Currency } from '@/lib/currency'
import { Decimal } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { useLocale, useTranslations } from 'next-intl'

type Props = {
  totalGroupSpendings: string
  currency: Currency
}

export function TotalsGroupSpending({ totalGroupSpendings, currency }: Props) {
  const locale = useLocale()
  const t = useTranslations('Stats.Totals')
  const balance = new Decimal(totalGroupSpendings).lt(0)
    ? 'groupEarnings'
    : 'groupSpendings'
  return (
    <div>
      <div className="text-muted-foreground">{t(balance)}</div>
      <div className="text-lg">
        {formatCurrency(
          currency,
          new Decimal(totalGroupSpendings).abs().toFixed(),
          locale,
        )}
      </div>
    </div>
  )
}
