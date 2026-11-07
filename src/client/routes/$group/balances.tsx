import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BalancesCard } from '~/client/components/balance/balances-card'
import { SuggestedPayments } from '~/client/components/balance/settlements'
import { balancesQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { Skeleton } from '~/client/ui/skeleton'

export const Route = createFileRoute('/$group/balances')({
  // Fresh balances each time the tab opens (P-BAL-50).
  loader: ({ context }) => context.queryClient.fetchQuery(balancesQuery(context.groupId)),
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
  const { groupId } = Route.useRouteContext()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const { data } = useSuspenseQuery(balancesQuery(groupId))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  return (
    <div className="flex flex-col gap-6">
      <BalancesCard currencies={data.currencies} names={names} />
      {/* The payments to record come before the chart. */}
      <div className="order-first">
        <SuggestedPayments currencies={data.currencies} names={names} group={group} viewer={g.participantId} />
      </div>
    </div>
  )
}
