import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useGroupTarget, useOpenedEntry } from '~/client/components/entry-write'
import { ExpenseForm } from '~/client/components/expense-form'
import { stateFromExpense } from '~/client/components/expense-form-state'
import { ExpenseLog } from '~/client/components/log/expense-log'
import { expenseDetailQuery, referenceQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'

export const Route = createFileRoute('/$group/expenses/$expenseId/edit')({
  loader: ({ context, params }) => Promise.all([context.queryClient.ensureQueryData(expenseDetailQuery(context.groupId, params.expenseId)), context.queryClient.ensureQueryData(referenceQuery)]),
  component: EditExpense,
})

function EditExpense() {
  const { group, expenseId } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const { data: reference } = useSuspenseQuery(referenceQuery)
  const { data: saved } = useSuspenseQuery(expenseDetailQuery(groupId, expenseId))
  const opened = useOpenedEntry({ groupId, detail: saved })
  const { detail } = opened
  const target = useGroupTarget({ groupId, group, kind: 'expense' })
  return (
    <>
      <ExpenseForm
        key={opened.key}
        mode="edit"
        detail={detail}
        participants={g.participants}
        target={target}
        reference={reference}
        initial={stateFromExpense({ expense: detail.expense, documents: detail.documents, participants: g.participants.map((p) => p.id) })}
        onReload={() => void opened.reload()}
      />
      {/* The collapsed expense log under the editor, as in the current app (P-HIST-80). */}
      <ExpenseLog groupId={groupId} expenseId={expenseId} />
    </>
  )
}
