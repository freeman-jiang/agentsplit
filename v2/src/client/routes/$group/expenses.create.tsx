import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ExpenseForm } from '~/client/components/expense-form'
import { newExpenseState, type Prefill } from '~/client/components/expense-form-state'
import { groupQuery } from '~/client/queries'
import { referenceQuery } from '~/client/queries/expenses'
import { searchText } from '~/client/components/ids'
import { randomId } from '~/shared/ids'
import { currencyParam, numberParam, pickSearch } from '~/client/search'

// The current app's prefill parameters (P-EXP-96).
const pickText = pickSearch(['title', 'vendor', 'date', 'amount'])
/** Route options stay in the main chunk, so this parses search params without a schema library. */
const parseSearch = (raw: Record<string, unknown>) => {
  const currencyCode = currencyParam(raw['currencyCode'])
  const categoryId = numberParam(raw['categoryId'])
  return { ...pickText(raw), ...(categoryId === undefined ? {} : { categoryId }), ...(currencyCode ? { currencyCode } : {}) }
}

export const Route = createFileRoute('/$group/expenses/create')({
  validateSearch: parseSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(referenceQuery),
  component: CreateExpense,
})

function prefillOf(search: ReturnType<typeof parseSearch>): Prefill {
  const text = { title: searchText(search.title), vendor: searchText(search.vendor), date: searchText(search.date), amount: searchText(search.amount) }
  return {
    ...Object.fromEntries(Object.entries(text).filter(([, v]) => v !== undefined)),
    ...(search.categoryId !== undefined ? { categoryId: search.categoryId } : {}),
    ...(search.currencyCode ? { currencyCode: search.currencyCode } : {}),
  }
}

function CreateExpense() {
  const { group } = Route.useParams()
  const search = Route.useSearch()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const { data: reference } = useSuspenseQuery(referenceQuery)
  // Minted once per visit, so a retried create cannot make a second expense (P-EXP-38).
  const [expenseId] = useState(() => randomId())
  const [initial] = useState(() =>
    newExpenseState({ groupId: g.id, participants: g.participants.map((p) => p.id), viewer: g.participantId, defaultCurrency: g.defaultCurrency, prefill: prefillOf(search) }),
  )
  return <ExpenseForm mode="create" expenseId={expenseId} group={g} target={{ kind: 'group', groupParam: group }} reference={reference} initial={initial} />
}
