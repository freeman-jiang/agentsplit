'use client'

import { RecentGroups } from '@/app/groups/recent-groups-helpers'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Currency } from '@/lib/currency'
import { MAX_GROUPS_PER_QUERY } from '@/lib/group-query-limits'
import { add, Decimal } from '@/lib/money'
import { cn, formatCurrency, getCurrencyFromGroup } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import { useLocale, useTranslations } from 'next-intl'

type CurrencyBalance = {
  currency: Currency
  amount: string
}

export function GlobalBalanceCard({ groups }: { groups: RecentGroups }) {
  const locale = useLocale()
  const t = useTranslations('Groups.GlobalBalance')
  const { data, isLoading, isError, refetch } =
    trpc.groups.balances.forUser.useQuery({
      groups: groups
        .slice(0, MAX_GROUPS_PER_QUERY)
        .map((group) => ({ groupId: group.id })),
    })

  if (isError) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>{t('loadError')}</p>
          <Button variant="secondary" onClick={() => refetch()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (isLoading || !data) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-6 w-40" />
        </CardContent>
      </Card>
    )
  }

  // Amounts from different currencies cannot be summed, so we aggregate them
  // into one bucket per currency.
  const byCurrency = new Map<string, CurrencyBalance>()
  for (const balance of data.balances) {
    const currency = getCurrencyFromGroup(balance)
    const key = currency.code || `custom:${currency.symbol}`
    const existing = byCurrency.get(key)
    if (existing) {
      existing.amount = add(existing.amount, balance.amount)
    } else {
      byCurrency.set(key, { currency, amount: balance.amount })
    }
  }

  const currencyBalances = [...byCurrency.values()]
  const isSettledUp = currencyBalances.every(({ amount }) =>
    new Decimal(amount).isZero(),
  )

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.unboundGroupIds.length > 0 && (
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
            Link your participant identity in {data.unboundGroupIds.length}{' '}
            group(s) to see a complete total. Only linked groups are included
            below.
          </p>
        )}
        {isSettledUp ? (
          <p className="text-muted-foreground text-sm">
            {data.unboundGroupIds.length
              ? 'No outstanding balance in linked groups.'
              : t('settledUp')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-x-12 gap-y-5">
            {currencyBalances.map(({ currency, amount }) => {
              if (new Decimal(amount).isZero()) return null
              const formatted = formatCurrency(
                currency,
                new Decimal(amount).abs().toFixed(),
                locale,
              )
              return (
                <li
                  key={currency.code || currency.symbol}
                  className="space-y-1"
                >
                  <span className="block text-xs font-medium text-muted-foreground">
                    {new Decimal(amount).gt(0) ? t('owedToYou') : t('youOwe')}
                  </span>
                  <span
                    className={cn(
                      'block text-3xl font-semibold tabular-nums',
                      new Decimal(amount).gt(0)
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-red-700 dark:text-red-400',
                    )}
                  >
                    {formatted}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
