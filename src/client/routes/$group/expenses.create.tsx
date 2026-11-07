import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useGroupTarget } from '~/client/components/entry-write'
import { ExpenseForm } from '~/client/components/expense-form'
import { newExpenseState, type Prefill } from '~/client/components/expense-form-state'
import { referenceQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { currencyParam, numberParam, searchParams, textParam } from '~/client/search'
import { randomId } from '~/shared/ids'

// The current app's prefill parameters (P-EXP-96).
const parseSearch = searchParams({ title: textParam, vendor: textParam, date: textParam, amount: textParam, categoryId: numberParam, currencyCode: currencyParam })

export const Route = createFileRoute('/$group/expenses/create')({
  validateSearch: parseSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(referenceQuery),
  component: CreateExpense,
})

function prefillOf(search: ReturnType<typeof Route.useSearch>): Prefill {
  return {
    ...(search.title === undefined ? {} : { title: String(search.title) }),
    ...(search.vendor === undefined ? {} : { vendor: String(search.vendor) }),
    ...(search.date === undefined ? {} : { date: String(search.date) }),
    ...(search.amount === undefined ? {} : { amount: String(search.amount) }),
    ...(search.categoryId === undefined ? {} : { categoryId: search.categoryId }),
    ...(search.currencyCode === undefined ? {} : { currencyCode: search.currencyCode }),
  }
}

function CreateExpense() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const search = Route.useSearch()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const { data: reference } = useSuspenseQuery(referenceQuery)
  const target = useGroupTarget({ groupId, group, kind: 'expense' })
  // Minted once per visit, so a retried create cannot make a second expense (P-EXP-38).
  const [expenseId] = useState(() => randomId())
  const [initial] = useState(() =>
    newExpenseState({ groupId, participants: g.participants.map((p) => p.id), viewer: g.participantId, defaultCurrency: g.defaultCurrency, prefill: prefillOf(search) }),
  )
  return <ExpenseForm mode="create" expenseId={expenseId} participants={g.participants} target={target} reference={reference} initial={initial} />
}
