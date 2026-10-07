'use client'

import { ExpenseMetadata } from '@/components/expense-metadata'
import { Button } from '@/components/ui/button'
import { getCurrency } from '@/lib/currency'
import { groupPath } from '@/lib/group-slug'
import { formatCurrency, formatDateOnly } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import { useLocale } from 'next-intl'
import Link from 'next/link'
import { useCurrentGroup } from '../current-group-context'
import { ReimbursementList } from '../reimbursement-list'

export function Payments() {
  const { groupId, group } = useCurrentGroup()
  const locale = useLocale()
  const history = trpc.groups.expenses.list.useInfiniteQuery(
    { groupId, isReimbursement: true, limit: 30 },
    {
      getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    },
  )
  const balances = trpc.groups.balances.list.useQuery({ groupId })
  if (!group) return <p role="status">Loading payments…</p>
  const base = groupPath(group)
  const entries = history.data?.pages.flatMap((page) => page.expenses) ?? []
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl">Payments</h1>
        <Button asChild>
          <Link href={`${base}/payments/create`}>Record payment</Link>
        </Button>
      </div>
      <section aria-labelledby="suggested-payments-heading">
        <h2 id="suggested-payments-heading" className="font-display text-xl">
          Suggested payments
        </h2>
        {balances.error ? (
          <p role="alert">{balances.error.message}</p>
        ) : balances.isLoading ? (
          <p role="status">Loading suggestions…</p>
        ) : balances.data?.currencies.some((c) => c.reimbursements.length) ? (
          balances.data.currencies
            .filter((c) => c.reimbursements.length)
            .map((entry) => (
              <ReimbursementList
                key={entry.currencyCode}
                groupId={groupId}
                currency={getCurrency(entry.currencyCode)}
                participants={group.participants}
                reimbursements={entry.reimbursements}
              />
            ))
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            No payments needed.
          </p>
        )}
      </section>
      <section aria-labelledby="payment-history-heading">
        <h2 id="payment-history-heading" className="font-display text-xl">
          Payment history
        </h2>
        {history.error ? (
          <p role="alert">{history.error.message}</p>
        ) : history.isLoading ? (
          <p role="status">Loading payment history…</p>
        ) : entries.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No payments recorded yet.
          </p>
        ) : (
          <ul className="divide-y">
            {entries.map((entry) => (
              <li key={entry.id} data-testid="payment-row" className="py-4">
                <Link
                  href={`${base}/payments/${entry.id}/edit`}
                  className="block space-y-1 hover:bg-accent"
                >
                  <div className="flex flex-wrap justify-between gap-2 text-sm font-medium">
                    <span>
                      {entry.paidBy.name} →{' '}
                      {entry.paidFor.map((p) => p.participant.name).join(', ')}
                    </span>
                    <span>
                      {formatCurrency(
                        getCurrency(entry.currencyCode),
                        entry.amount,
                        locale,
                      )}{' '}
                      {entry.currencyCode}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDateOnly(entry.expenseDate, locale, {
                      dateStyle: 'medium',
                    })}
                  </p>
                  <ExpenseMetadata
                    compact
                    createdAt={entry.createdAt}
                    attribution={entry.attribution}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {history.hasNextPage && (
          <Button
            variant="outline"
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
          >
            Load more payments
          </Button>
        )}
      </section>
    </div>
  )
}
