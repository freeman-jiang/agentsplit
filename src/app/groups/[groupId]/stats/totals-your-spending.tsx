'use client'

import { Currency } from '@/lib/currency'
import { Decimal } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'
import { useLocale, useTranslations } from 'next-intl'

export function TotalsYourSpendings({
  totalParticipantSpendings = '0',
  currency,
}: {
  totalParticipantSpendings?: string
  currency: Currency
}) {
  const locale = useLocale()
  const t = useTranslations('Stats.Totals')

  const balance = new Decimal(totalParticipantSpendings).lt(0)
    ? 'yourEarnings'
    : 'yourSpendings'

  return (
    <div>
      <div className="text-muted-foreground">{t(balance)}</div>

      <div
        className={cn(
          'text-lg',
          new Decimal(totalParticipantSpendings).lt(0)
            ? 'text-green-600'
            : 'text-red-600',
        )}
      >
        {formatCurrency(
          currency,
          new Decimal(totalParticipantSpendings).abs().toFixed(),
          locale,
        )}
      </div>
    </div>
  )
}
