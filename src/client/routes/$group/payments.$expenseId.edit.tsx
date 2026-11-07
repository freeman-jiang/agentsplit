import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useGroupTarget } from '~/client/components/entry-write'
import { ExpenseLog } from '~/client/components/log/expense-log'
import { isSimplePayment, PaymentForm } from '~/client/components/payment-form'
import { balancesQuery, expenseDetailQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { Button } from '~/client/ui/button'

export const Route = createFileRoute('/$group/payments/$expenseId/edit')({
  loader: ({ context, params }) => Promise.all([context.queryClient.ensureQueryData(expenseDetailQuery(context.groupId, params.expenseId)), context.queryClient.ensureQueryData(balancesQuery(context.groupId))]),
  component: EditPayment,
})

function EditPayment() {
  const { group, expenseId } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const { data: detail } = useSuspenseQuery(expenseDetailQuery(groupId, expenseId))
  const target = useGroupTarget({ groupId, group, kind: 'payment' })
  // Any other shape keeps every detail in the expense editor (P-BAL-89).
  if (!isSimplePayment(detail))
    return (
      <div className="space-y-3 rounded-2xl border bg-card p-4">
        <p>This entry uses the expense editor.</p>
        <Button asChild>
          <Link to="/$group/expenses/$expenseId/edit" params={{ group, expenseId }}>
            Open entry
          </Link>
        </Button>
      </div>
    )
  return (
    <>
      <PaymentForm
        key={detail.expense.revision}
        mode="edit"
        detail={detail}
        participants={g.participants}
        target={{ ...target, groupId }}
        onReload={() => void queryClient.invalidateQueries({ queryKey: expenseDetailQuery(groupId, expenseId).queryKey })}
      />
      <ExpenseLog groupId={groupId} expenseId={expenseId} />
    </>
  )
}
