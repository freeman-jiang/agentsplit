'use client'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getCurrency } from '@/lib/currency'
import { groupPath } from '@/lib/group-slug'
import { useActiveUser } from '@/lib/hooks'
import { Decimal } from '@/lib/money'
import { cn, formatCurrency } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@/trpc/routers/_app'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useLocale } from 'next-intl'
import Link from 'next/link'
import { useCurrentGroup } from '../current-group-context'

type CurrencyBalances =
  AppRouterOutput['groups']['balances']['list']['currencies'][number]
type Person = { id: string; name: string }

function netLabel(amount: string, personal = false) {
  const total = new Decimal(amount)
  return total.isZero()
    ? 'Settled up'
    : total.gt(0)
      ? personal
        ? 'You are owed'
        : 'gets back'
      : personal
        ? 'You owe'
        : 'owes'
}

function amountClass(amount: string) {
  const total = new Decimal(amount)
  return total.isZero()
    ? 'text-muted-foreground'
    : total.gt(0)
      ? 'text-green-700 dark:text-green-400'
      : 'text-red-700 dark:text-red-400'
}

function BalanceDetails({
  entry,
  participants,
  participantId,
  locale,
}: {
  entry: CurrencyBalances
  participants: Person[]
  participantId: string | null
  locale: string
}) {
  const money = (amount: string) =>
    formatCurrency(
      getCurrency(entry.currencyCode),
      new Decimal(amount).abs().toFixed(),
      locale,
    )
  const personName = (id: string) =>
    id === participantId
      ? 'You'
      : (participants.find((person) => person.id === id)?.name ??
        'Unknown participant')
  return (
    <div className="space-y-4">
      <ul
        className="space-y-3"
        aria-label={`${entry.currencyCode} participant balances`}
      >
        {participants.map((person) => {
          const total = entry.balances[person.id]?.total ?? '0'
          return (
            <li
              key={person.id}
              className="space-y-0.5"
              data-testid="summary-participant"
              data-participant={person.name}
            >
              <div className="text-sm font-medium break-words">
                {person.name}
                {person.id === participantId && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    (you)
                  </span>
                )}
              </div>
              <div className={cn('text-sm tabular-nums', amountClass(total))}>
                {netLabel(total)}
                {!new Decimal(total).isZero() && <> {money(total)}</>}
              </div>
            </li>
          )
        })}
      </ul>
      {entry.reimbursements.length > 0 && (
        <div className="border-t pt-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggested payments
          </h3>
          <ul className="space-y-3 text-sm">
            {entry.reimbursements.map((payment) => (
              <li
                key={`${payment.from}-${payment.to}`}
                data-testid="summary-payment"
              >
                <span className="block break-words">
                  {personName(payment.from)} → {personName(payment.to)}
                </span>
                <strong className="tabular-nums">
                  {money(payment.amount)}
                </strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function GroupBalanceSummary() {
  const { groupId, group } = useCurrentGroup()
  const participantId = useActiveUser(groupId)
  const locale = useLocale()
  const { data, isLoading, isError, isFetching, refetch } =
    trpc.groups.balances.list.useQuery(
      { groupId },
      { refetchOnMount: 'always', refetchOnWindowFocus: true },
    )
  return (
    <aside
      aria-label="Group balances"
      data-testid="group-balance-summary"
      className="sticky top-0 z-20 self-start border bg-background p-4 lg:top-6 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Group balances</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh balances"
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
          />
        </Button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Net across all group expenses
      </p>
      {isError ? (
        <p role="alert" className="text-sm">
          Could not load balances. Try refreshing.
        </p>
      ) : isLoading || !group || !data ? (
        <Skeleton className="h-12 w-full" />
      ) : data.currencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No outstanding balances.
        </p>
      ) : (
        <div className="space-y-5">
          {data.currencies.map((entry) => {
            const ownTotal = participantId
              ? (entry.balances[participantId]?.total ?? '0')
              : null
            const summary = (
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  {ownTotal === null
                    ? 'Group net balances'
                    : netLabel(ownTotal, true)}{' '}
                  · {entry.currencyCode}
                </div>
                {ownTotal !== null && (
                  <div
                    className={cn(
                      'mt-1 text-xl font-semibold tabular-nums',
                      amountClass(ownTotal),
                    )}
                    data-testid="summary-personal-net"
                  >
                    {formatCurrency(
                      getCurrency(entry.currencyCode),
                      new Decimal(ownTotal).abs().toFixed(),
                      locale,
                    )}
                  </div>
                )}
              </div>
            )
            const details = (
              <BalanceDetails
                entry={entry}
                participants={group.participants}
                participantId={participantId}
                locale={locale}
              />
            )
            return (
              <section
                key={entry.currencyCode}
                aria-label={`${entry.currencyCode} balances`}
              >
                <details className="group lg:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                    {summary}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      Details
                      <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                    </span>
                  </summary>
                  <div className="mt-4 max-h-[55dvh] overflow-y-auto">
                    {details}
                  </div>
                </details>
                <div className="hidden space-y-4 lg:block">
                  {summary}
                  {details}
                </div>
              </section>
            )
          })}
        </div>
      )}
      <Link
        href={`${groupPath(group ?? { id: groupId })}/balances`}
        className="mt-4 inline-block text-xs underline underline-offset-4"
      >
        Balance details & settle up
      </Link>
    </aside>
  )
}
