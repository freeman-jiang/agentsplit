import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useGroupTarget } from '~/client/components/entry-write'
import { PaymentForm } from '~/client/components/payment-form'
import { balancesQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { paymentPrefill, paymentSearch } from '~/client/search'
import { randomId } from '~/shared/ids'

export const Route = createFileRoute('/$group/payments/create')({
  validateSearch: paymentSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(balancesQuery(context.groupId)),
  component: CreatePayment,
})

function CreatePayment() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const search = Route.useSearch()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const target = useGroupTarget({ groupId, group, kind: 'payment' })
  const [expenseId] = useState(() => randomId())
  return (
    <PaymentForm
      mode="create"
      expenseId={expenseId}
      prefill={paymentPrefill(search)}
      viewer={g.participantId}
      defaultCurrency={g.defaultCurrency}
      participants={g.participants}
      target={target}
    />
  )
}
