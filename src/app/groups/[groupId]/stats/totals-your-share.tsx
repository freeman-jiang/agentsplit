'use client'

import { Currency } from '@/lib/currency'
import { Decimal } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'
import { useLocale, useTranslations } from 'next-intl'

export function TotalsYourShare({
  totalParticipantShare = '0',
  currency,
}: {
  totalParticipantShare?: string
  currency: Currency
}) {
  const locale = useLocale()
  const t = useTranslations('Stats.Totals')

  return (
    <div>
      <div className="text-muted-foreground">{t('yourShare')}</div>
      <div
        className={cn(
          'text-lg',
          new Decimal(totalParticipantShare).lt(0)
            ? 'text-green-600'
            : 'text-red-600',
        )}
      >
        {formatCurrency(
          currency,
          new Decimal(totalParticipantShare).abs().toFixed(),
          locale,
        )}
      </div>
    </div>
  )
}
