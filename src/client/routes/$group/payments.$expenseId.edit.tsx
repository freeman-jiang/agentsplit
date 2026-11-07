import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ExpenseLog } from '~/client/components/history/expense-log'
import { isSimplePayment, PaymentForm } from '~/client/components/payment-form'
import { groupQuery } from '~/client/queries'
import { balancesQuery, expenseDetailQuery } from '~/client/queries/expenses'
import { Button } from '~/client/ui/button'

export const Route = createFileRoute('/$group/payments/$expenseId/edit')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(
        expenseDetailQuery(params.group, params.expenseId),
      ),
      context.queryClient.ensureQueryData(balancesQuery(params.group)),
    ]),
  component: EditPayment,
})

function EditPayment() {
  const { group, expenseId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const { data: detail } = useSuspenseQuery(
    expenseDetailQuery(group, expenseId),
  )
  // Any other shape keeps every detail in the expense editor (P-BAL-89).
  if (!isSimplePayment(detail))
    return (
      <div className="space-y-3 border bg-card p-4">
        <p>This entry uses the expense editor.</p>
        <Button asChild>
          <Link
            to="/$group/expenses/$expenseId/edit"
            params={{ group, expenseId }}
          >
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
        group={g}
        target={{ kind: 'group', groupParam: group }}
        onReload={() =>
          void queryClient.invalidateQueries({
            queryKey: expenseDetailQuery(group, expenseId).queryKey,
          })
        }
      />
      <ExpenseLog group={group} groupId={g.id} expenseId={expenseId} />
    </>
  )
}
