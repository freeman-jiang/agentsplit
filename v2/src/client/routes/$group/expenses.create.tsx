import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Schema } from 'effect'
import { useState } from 'react'
import { ExpenseForm } from '~/client/components/expense-form'
import { newExpenseState, type Prefill } from '~/client/components/expense-form-state'
import { groupQuery } from '~/client/queries'
import { referenceQuery } from '~/client/queries/expenses'
import { randomExpenseId, searchText } from '~/client/components/ids'
import { CurrencyCodeSchema } from '~/shared/money'

// The current app's prefill parameters (P-EXP-96).
const Search = Schema.Struct({
  title: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  vendor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  date: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  amount: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  categoryId: Schema.optionalKey(Schema.Number),
  currencyCode: Schema.optionalKey(CurrencyCodeSchema),
})

export const Route = createFileRoute('/$group/expenses/create')({
  validateSearch: Schema.toStandardSchemaV1(Search),
  loader: ({ context }) => context.queryClient.ensureQueryData(referenceQuery),
  component: CreateExpense,
})

function prefillOf(search: typeof Search.Type): Prefill {
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
  const [expenseId] = useState(randomExpenseId)
  const [initial] = useState(() =>
    newExpenseState({ groupId: g.id, participants: g.participants.map((p) => p.id), viewer: g.participantId, defaultCurrency: g.defaultCurrency, prefill: prefillOf(search) }),
  )
  return <ExpenseForm mode="create" expenseId={expenseId} group={g} groupParam={group} reference={reference} initial={initial} />
}
