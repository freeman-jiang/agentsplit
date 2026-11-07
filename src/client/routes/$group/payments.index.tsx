import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { SuggestedPayments } from '~/client/components/balances-view'
import { namesOf } from '~/client/components/expense-row'
import { money } from '~/client/components/money'
import { groupQuery } from '~/client/queries'
import { balancesQuery, paymentsQuery } from '~/client/queries/expenses'
import { Button } from '~/client/ui/button'

export const Route = createFileRoute('/$group/payments/')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.fetchQuery(balancesQuery(params.group)), context.queryClient.ensureInfiniteQueryData(paymentsQuery(params.group))]),
  component: PaymentsTab,
})

function PaymentsTab() {
  const { group } = Route.useParams()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const { data: balances } = useSuspenseQuery(balancesQuery(group))
  const payments = useSuspenseInfiniteQuery(paymentsQuery(group))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  const rows = payments.data.pages.flatMap((p) => p.expenses)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl">Payments</h2>
        <Button asChild>
          <Link to="/$group/payments/create" params={{ group }}>
            Record payment
          </Link>
        </Button>
      </div>
      <SuggestedPayments currencies={balances.currencies} names={names} group={group} viewer={g.participantId} />
      <section className="rounded-2xl border bg-card p-6" aria-labelledby="history-title">
        <h2 id="history-title" className="mb-4 text-base font-semibold leading-tight">
          Payment history
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-2xl border" data-testid="payment-list">
            {rows.map((p) => (
              <li key={p.id}>
                <Link to="/$group/payments/$expenseId/edit" params={{ group, expenseId: p.id }} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-accent/50">
                  <div className="min-w-0">
                    <div className="truncate">
                      {namesOf({ ids: p.payers.map((x) => x.participantId), names, viewer: null })} → {namesOf({ ids: p.shares.map((x) => x.participantId), names, viewer: null })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.expenseDate} · {p.editedBy ? `Last edited by ${p.editedBy}` : p.addedBy ? `Added by ${p.addedBy}` : 'Original author unavailable'}
                    </div>
                  </div>
                  <div className="shrink-0 tabular-nums">
                    {money(p.amount, p.currency)} <span className="text-xs text-muted-foreground">{p.currency}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {payments.hasNextPage && (
          <Button variant="outline" className="mt-3" disabled={payments.isFetchingNextPage} onClick={() => void payments.fetchNextPage()}>
            Load more payments
          </Button>
        )}
      </section>
    </div>
  )
}
