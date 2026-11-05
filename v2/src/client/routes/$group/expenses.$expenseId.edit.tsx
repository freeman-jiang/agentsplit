import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ExpenseForm } from '~/client/components/expense-form'
import { stateFromExpense } from '~/client/components/expense-form-state'
import { groupQuery } from '~/client/queries'
import { expenseDetailQuery, referenceQuery } from '~/client/queries/expenses'

export const Route = createFileRoute('/$group/expenses/$expenseId/edit')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(expenseDetailQuery(params.group, params.expenseId)), context.queryClient.ensureQueryData(referenceQuery)]),
  component: EditExpense,
})

function EditExpense() {
  const { group, expenseId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const { data: reference } = useSuspenseQuery(referenceQuery)
  const { data: detail } = useSuspenseQuery(expenseDetailQuery(group, expenseId))
  return (
    <ExpenseForm
      // A new revision starts a fresh form, so a reload after a conflict shows the saved values.
      key={detail.expense.revision}
      mode="edit"
      detail={detail}
      group={g}
      groupParam={group}
      reference={reference}
      initial={stateFromExpense({ expense: detail.expense, documents: detail.documents, participants: g.participants.map((p) => p.id) })}
      onReload={() => void queryClient.invalidateQueries({ queryKey: expenseDetailQuery(group, expenseId).queryKey })}
    />
  )
}
