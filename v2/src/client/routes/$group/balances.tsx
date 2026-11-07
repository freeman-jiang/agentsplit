import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BalancesCard, SuggestedPayments } from '~/client/components/balances-view'
import { groupQuery } from '~/client/queries'
import { balancesQuery } from '~/client/queries/expenses'
import { Skeleton } from '~/client/ui/skeleton'

export const Route = createFileRoute('/$group/balances')({
  // Fresh balances each time the tab opens (P-BAL-50).
  loader: ({ context, params }) => context.queryClient.fetchQuery(balancesQuery(params.group)),
  pendingComponent: () => (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  ),
  component: BalancesTab,
})

function BalancesTab() {
  const { group } = Route.useParams()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const { data } = useSuspenseQuery(balancesQuery(group))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  return (
    <div className="flex flex-col gap-6">
      <BalancesCard currencies={data.currencies} names={names} />
      {/* On narrow screens the payments to record come before the chart. */}
      <div className="order-first md:order-none">
        <SuggestedPayments currencies={data.currencies} names={names} group={group} viewer={g.participantId} />
      </div>
    </div>
  )
}
