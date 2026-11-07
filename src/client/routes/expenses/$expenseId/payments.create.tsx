import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { usePageTarget } from '~/client/components/entry-write'
import { PaymentForm } from '~/client/components/payment-form'
import { describeError } from '~/client/errors'
import { expenseContextQuery } from '~/client/queries/feed'
import { paymentPrefill, paymentSearch } from '~/client/search'
import { randomId } from '~/shared/ids'
import type { ExpenseContext } from '~/shared/api'
import { PrivateContextHeader } from '../-private-context'

export const Route = createFileRoute('/expenses/$expenseId/payments/create')({
  // "Record repayment" links prefill the suggested transfer.
  validateSearch: paymentSearch,
  loader: ({ context, params }) => void context.queryClient.prefetchQuery(expenseContextQuery(params.expenseId)),
  component: RecordPayment,
})

function RecordPayment() {
  const { expenseId } = Route.useParams()
  const context = useQuery(expenseContextQuery(expenseId))
  if (context.error) return <p role="alert">{describeError(context.error).message}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  return <Repayment data={context.data} />
}

function Repayment({ data }: { data: typeof ExpenseContext.Type }) {
  const search = Route.useSearch()
  const back = data.context ? ({ to: '/expenses/$expenseId', params: { expenseId: data.context.expenseId } } as const) : ({ to: '/' } as const)
  const target = usePageTarget({ groupId: data.group.id, privateExpense: false, back })
  // One ID per form: a save that reached the server is found again instead of being recorded twice (P-BAL-84).
  const [paymentId] = useState(() => randomId())
  return (
    <div className="space-y-6">
      <PrivateContextHeader data={data} repayment />
      <PaymentForm
        mode="create"
        expenseId={paymentId}
        prefill={paymentPrefill(search)}
        viewer={data.participantId}
        // The form defaults to this currency when the link names none.
        defaultCurrency={data.expense.currency}
        participants={data.participants}
        target={{ ...target, groupId: data.group.id }}
      />
    </div>
  )
}
