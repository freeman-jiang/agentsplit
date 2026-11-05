import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Schema } from 'effect'
import { useState } from 'react'
import { errorMessage, expenseContextQuery, invalidateExpenses } from '~/client/queries/feed'
import { rpc } from '~/client/rpc'
import { randomId } from '~/server/ids'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { today, type ExpenseValues } from '../-expense-form'
import { PaymentForm } from '../-payment-form'

// "Record repayment" links prefill the suggested transfer. The router parses numbers, so amounts may arrive as either.
const Value = Schema.optionalKey(Schema.Union([Schema.String, Schema.Number]))
const Search = Schema.Struct({ from: Value, to: Value, amount: Value, currencyCode: Value })

export const Route = createFileRoute('/expenses/$expenseId/payments/create')({
  validateSearch: Schema.toStandardSchemaV1(Search),
  loader: ({ context, params }) => void context.queryClient.prefetchQuery(expenseContextQuery(params.expenseId)),
  component: RecordPayment,
})

function RecordPayment() {
  const { expenseId } = Route.useParams()
  const search = Route.useSearch()
  const context = useQuery(expenseContextQuery(expenseId))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // One ID per form: a save that reached the server is found again instead of being recorded twice.
  const [paymentId] = useState(() => randomId())
  const [idempotencyKey] = useState(() => randomId())
  if (context.error) return <p role="alert">{errorMessage(context.error)}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  const data = context.data
  const back = data.context ? ({ to: '/expenses/$expenseId', params: { expenseId: data.context.expenseId } } as const) : ({ to: '/' } as const)
  const currency = String(search.currencyCode ?? '')
  const save = async (expense: ExpenseValues) => {
    await rpc((api) => api('expenses.create', { groupId: data.group.id, expenseId: paymentId, idempotencyKey, expense }))
    await invalidateExpenses(queryClient)
    await navigate(back)
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/" className="underline">
          ← All expenses
        </Link>
        {data.context ? (
          <span className="text-muted-foreground">No group · Private to {data.participants.map((p) => p.name).join(', ')}</span>
        ) : (
          <Link to="/$group/expenses" params={{ group: data.group.slug ?? data.group.id }} className="underline">
            {data.group.name}
          </Link>
        )}
      </div>
      {data.context && (
        <p className="text-sm">
          Repayment for{' '}
          <Link to="/expenses/$expenseId" params={{ expenseId: data.context.expenseId }} className="underline">
            {data.context.title}
          </Link>
        </p>
      )}
      <PaymentForm
        people={data.participants}
        editing={false}
        initial={{
          from: String(search.from ?? data.participantId ?? ''),
          to: String(search.to ?? ''),
          amount: String(search.amount ?? ''),
          currency: currency in CURRENCIES ? (currency as CurrencyCode) : data.expense.currency,
          date: today(),
          notes: '',
          title: 'Payment',
        }}
        back={back}
        onSubmit={save}
      />
    </div>
  )
}
