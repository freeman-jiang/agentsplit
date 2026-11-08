import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useGroupTarget } from '~/client/components/entry-write'
import { ExpenseForm } from '~/client/components/expense-form'
import { stateFromExpense } from '~/client/components/expense-form-state'
import { ExpenseLog } from '~/client/components/log/expense-log'
import { expenseDetailQuery, referenceQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { reloadEntry } from '~/client/queries/keys'

export const Route = createFileRoute('/$group/expenses/$expenseId/edit')({
  loader: ({ context, params }) => Promise.all([context.queryClient.ensureQueryData(expenseDetailQuery(context.groupId, params.expenseId)), context.queryClient.ensureQueryData(referenceQuery)]),
  component: EditExpense,
})

function EditExpense() {
  const { group, expenseId } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const { data: reference } = useSuspenseQuery(referenceQuery)
  const { data: detail } = useSuspenseQuery(expenseDetailQuery(groupId, expenseId))
  const target = useGroupTarget({ groupId, group, kind: 'expense' })
  return (
    <>
      <ExpenseForm
        // A new revision starts a fresh form, so a reload after a conflict shows the saved values.
        key={detail.expense.revision}
        mode="edit"
        detail={detail}
        participants={g.participants}
        target={target}
        reference={reference}
        initial={stateFromExpense({ expense: detail.expense, documents: detail.documents, participants: g.participants.map((p) => p.id) })}
        onReload={() => void reloadEntry({ queryClient, groupId, expenseId })}
      />
      {/* The collapsed expense log under the editor, as in the current app (P-HIST-80). */}
      <ExpenseLog groupId={groupId} expenseId={expenseId} />
    </>
  )
}
