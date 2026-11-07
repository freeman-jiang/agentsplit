import { useQuery } from '@tanstack/react-query'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { accountBalancesQuery } from '~/client/queries/feed'
import { Button } from '~/client/ui/button'
import { Skeleton } from '~/client/ui/skeleton'

/** The caller's own balance across every group and ungrouped expense. The feed filters never change it. */
export function DashboardBalance() {
  const summary = useQuery({ ...accountBalancesQuery, refetchOnMount: 'always' })
  // One left-aligned stack: the title row with its note, then each amount under its label.
  return (
    <section aria-labelledby="dashboard-balance-title" className="rounded-2xl border bg-card p-4 sm:px-6 sm:py-5" data-testid="dashboard-balance">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="dashboard-balance-title" className="text-sm font-semibold">
          Your total balance
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">Across all your groups and ungrouped expenses. Filters don’t change it.</p>
      </div>
      {summary.error ? (
        <div className="mt-4 space-y-2">
          <p role="alert" className="text-sm">
            Couldn’t load your balance.
          </p>
          <Button variant="outline" size="sm" onClick={() => summary.refetch()}>
            Try again
          </Button>
        </div>
      ) : !summary.data ? (
        <Skeleton className="mt-4 h-10 w-40" />
      ) : (
        <>
          {summary.data.unboundGroupIds.length > 0 && (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              Partial total: your account still needs to be linked to a participant in {summary.data.unboundGroupIds.length} group(s).
            </p>
          )}
          {summary.data.totals.length === 0 ? (
            <p className="mt-4 text-lg">No recorded balance yet.</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-x-12 gap-y-5 sm:mt-2">
              {summary.data.totals.map(({ currency, amount }) => {
                const negative = amount.startsWith('-')
                const zero = /^-?0(\.0+)?$/.test(amount)
                return (
                  <li key={currency} className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-2 sm:space-y-1" data-currency={currency}>
                    <p className="text-xs text-muted-foreground max-sm:text-sm">
                      {zero ? 'Net balance' : negative ? 'You owe' : 'You are owed'} · {currency}
                    </p>
                    <p
                      className={cn(
                        'text-3xl font-semibold tabular-nums sm:text-4xl',
                        !zero && !negative && 'text-owed',
                        negative && 'text-owe',
                      )}
                    >
                      {money(negative ? amount.slice(1) : amount, currency)}
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
