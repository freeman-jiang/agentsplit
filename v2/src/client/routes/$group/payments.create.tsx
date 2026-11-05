import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Schema } from 'effect'
import { useState } from 'react'
import { randomExpenseId, searchText } from '~/client/components/ids'
import { PaymentForm } from '~/client/components/payment-form'
import { groupQuery } from '~/client/queries'
import { balancesQuery } from '~/client/queries/expenses'
import { CurrencyCodeSchema } from '~/shared/money'

// Filled by the suggested payments' "Record payment" links (P-BAL-49, P-BAL-71).
const Search = Schema.Struct({
  from: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  to: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  amount: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  currencyCode: Schema.optionalKey(CurrencyCodeSchema),
})

export const Route = createFileRoute('/$group/payments/create')({
  validateSearch: Schema.toStandardSchemaV1(Search),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(balancesQuery(params.group)),
  component: CreatePayment,
})

/** Drops undefined values, for exact optional props. */
const optional = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>

function CreatePayment() {
  const { group } = Route.useParams()
  const search = Route.useSearch()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const [expenseId] = useState(randomExpenseId)
  return <PaymentForm mode="create" expenseId={expenseId} prefill={{ ...optional({ from: searchText(search.from), to: searchText(search.to), amount: searchText(search.amount) }), ...(search.currencyCode ? { currencyCode: search.currencyCode } : {}) }} group={g} groupParam={group} />
}
