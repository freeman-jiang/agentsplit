'use client'

import { useCurrentGroup } from '@/app/groups/[groupId]/current-group-context'
import { CategoryBreakdown } from '@/app/groups/[groupId]/stats/category-breakdown'
import { MonthlySpending } from '@/app/groups/[groupId]/stats/monthly-spending'
import { ParticipantSpendingStats } from '@/app/groups/[groupId]/stats/participant-spending'
import { RecurringSpendingStats } from '@/app/groups/[groupId]/stats/recurring-spending'
import { SpendingOverTime } from '@/app/groups/[groupId]/stats/spending-over-time'
import {
  resolveStatsRange,
  StatsPeriod,
  StatsRange,
} from '@/app/groups/[groupId]/stats/stats-range'
import { StatsRangeSelector } from '@/app/groups/[groupId]/stats/stats-range-selector'
import { SummaryStats } from '@/app/groups/[groupId]/stats/summary-stats'
import { Totals } from '@/app/groups/[groupId]/stats/totals'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  expenseCurrencySchema,
  getCurrency,
  type supportedCurrencyCodeType,
} from '@/lib/currency'
import { useActiveUser } from '@/lib/hooks'
import { trpc } from '@/trpc/client'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

export function TotalsPageClient() {
  const t = useTranslations('Stats')
  const { groupId } = useCurrentGroup()
  const activeUser = useActiveUser(groupId)
  const participantId =
    activeUser && activeUser !== 'None' ? activeUser : undefined

  const [period, setPeriod] = useState<StatsPeriod>('all')
  const [currencyCode, setCurrencyCode] = useState<
    supportedCurrencyCodeType | undefined
  >()
  const [customRange, setCustomRange] = useState<StatsRange>({})
  const range = resolveStatsRange(period, customRange)

  const { data } = trpc.groups.stats.overview.useQuery({
    groupId,
    participantId,
    from: range.from,
    to: range.to,
    currencyCode,
  })

  const currency = data?.currencyCode
    ? getCurrency(data.currencyCode)
    : undefined

  return (
    <>
      <div
        className="flex flex-wrap items-start justify-between gap-4"
        aria-label="Statistics filters"
      >
        {data && data.availableCurrencyCodes.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Currency
            <select
              aria-label="Statistics currency"
              value={data.currencyCode ?? ''}
              onChange={(event) =>
                setCurrencyCode(expenseCurrencySchema.parse(event.target.value))
              }
              className="rounded-none border bg-background p-2"
            >
              {data.availableCurrencyCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        )}
        <StatsRangeSelector
          period={period}
          customRange={customRange}
          onPeriodChange={setPeriod}
          onCustomRangeChange={setCustomRange}
        />
      </div>
      <SummaryStats summary={data?.summary} currency={currency} />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{t('Totals.title')}</CardTitle>
          <CardDescription>{t('Totals.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col space-y-4">
          <Totals
            totalGroupSpendings={data?.totalGroupSpendings}
            totalParticipantSpendings={data?.totalParticipantSpendings}
            totalParticipantShare={data?.totalParticipantShare}
            currency={currency}
          />
        </CardContent>
      </Card>
      <SpendingOverTime
        groupId={groupId}
        months={data?.months}
        currency={currency}
        from={range.from}
        to={range.to}
      />
      <MonthlySpending
        monthlyCategorySpending={data?.monthlyCategorySpending}
        currency={currency}
      />
      <ParticipantSpendingStats
        participants={data?.participants}
        currency={currency}
      />
      <CategoryBreakdown
        groupId={groupId}
        categories={data?.categories}
        currency={currency}
        from={range.from}
        to={range.to}
      />
      <RecurringSpendingStats recurring={data?.recurring} currency={currency} />
    </>
  )
}
