'use client'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getCurrency } from '@/lib/currency'
import { Decimal } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import { useLocale } from 'next-intl'

export function DashboardBalance() {
  const locale = useLocale()
  const summary = trpc.groups.balances.forUser.useQuery(
    {},
    { staleTime: 0, refetchOnMount: 'always' },
  )
  return (
    <section
      aria-labelledby="dashboard-balance-title"
      className="border bg-card px-5 py-5 sm:px-6 sm:py-6"
      data-testid="dashboard-balance"
    >
      <h2
        id="dashboard-balance-title"
        className="text-sm font-medium text-muted-foreground"
      >
        Your total balance
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Across all your groups and ungrouped expenses. Filters below don’t
        change this total.
      </p>
      {summary.error ? (
        <div className="mt-4 space-y-2">
          <p role="alert" className="text-sm">
            Couldn’t load your balance.
          </p>
          <Button variant="outline" size="sm" onClick={() => summary.refetch()}>
            Try again
          </Button>
        </div>
      ) : summary.isLoading || !summary.data ? (
        <Skeleton className="mt-4 h-10 w-40" />
      ) : (
        <>
          {summary.data.unboundGroupIds.length > 0 && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              Partial total: your account still needs to be linked to a
              participant in {summary.data.unboundGroupIds.length} group(s).
            </p>
          )}
          {summary.data.totals.length === 0 ? (
            <p className="mt-5 text-lg">No recorded balance yet.</p>
          ) : (
            <ul className="mt-5 flex flex-wrap gap-x-12 gap-y-5">
              {summary.data.totals.map(({ currencyCode, amount }) => {
                const value = new Decimal(amount)
                return (
                  <li
                    key={currencyCode}
                    className="space-y-1"
                    data-currency={currencyCode}
                  >
                    <p className="text-xs text-muted-foreground">
                      {value.isZero()
                        ? 'Net balance'
                        : value.isPositive()
                          ? 'You are owed'
                          : 'You owe'}{' '}
                      · {currencyCode}
                    </p>
                    <p
                      className={cn(
                        'text-3xl font-semibold tabular-nums sm:text-4xl',
                        value.isPositive() &&
                          'text-green-700 dark:text-green-400',
                        value.isNegative() && 'text-red-700 dark:text-red-400',
                      )}
                    >
                      {formatCurrency(
                        getCurrency(currencyCode),
                        value.abs().toFixed(),
                        locale,
                      )}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
