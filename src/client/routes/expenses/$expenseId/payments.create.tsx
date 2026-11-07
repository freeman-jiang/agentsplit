import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { pickSearch } from '~/client/search'
import { useState } from 'react'
import { searchText } from '~/client/components/ids'
import { randomId } from '~/shared/ids'
import { PaymentForm, type PaymentPrefill } from '~/client/components/payment-form'
import { errorMessage, expenseContextQuery } from '~/client/queries/feed'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'

// "Record repayment" links prefill the suggested transfer. The router parses numbers, so amounts may arrive as either.
const parseSearch = pickSearch(['from', 'to', 'amount', 'currencyCode'])

export const Route = createFileRoute('/expenses/$expenseId/payments/create')({
  validateSearch: parseSearch,
  loader: ({ context, params }) => void context.queryClient.prefetchQuery(expenseContextQuery(params.expenseId)),
  component: RecordPayment,
})

/** Drops undefined values, for exact optional props. */
const optional = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>

function RecordPayment() {
  const { expenseId } = Route.useParams()
  const search = Route.useSearch()
  const context = useQuery(expenseContextQuery(expenseId))
  // One ID per form: a save that reached the server is found again instead of being recorded twice (P-BAL-84).
  const [paymentId] = useState(() => randomId())
  if (context.error) return <p role="alert">{errorMessage(context.error)}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  const data = context.data
  const back = data.context ? ({ to: '/expenses/$expenseId', params: { expenseId: data.context.expenseId } } as const) : ({ to: '/' } as const)
  const currency = searchText(search.currencyCode) ?? ''
  const prefill: PaymentPrefill = {
    ...optional({ from: searchText(search.from), to: searchText(search.to), amount: searchText(search.amount) }),
    ...(currency in CURRENCIES ? { currencyCode: currency as CurrencyCode } : {}),
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
        mode="create"
        expenseId={paymentId}
        prefill={prefill}
        // The form defaults to this currency when the link names none.
        group={{ id: data.group.id, participants: data.participants, participantId: data.participantId, defaultCurrency: data.expense.currency }}
        target={{ kind: 'page', back }}
      />
    </div>
  )
}
