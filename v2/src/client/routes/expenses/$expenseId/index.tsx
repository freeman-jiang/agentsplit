import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { money } from '~/client/components/money'
import { expensesQuery } from '~/client/queries'
import { errorMessage, expenseContextQuery, feedOptionsQuery, invalidateExpenses } from '~/client/queries/feed'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { randomId } from '~/server/ids'
import type { ExpenseContext } from '~/shared/api'
import { ExpenseForm, type ExpenseValues } from '../-expense-form'
import { PaymentForm } from '../-payment-form'

export const Route = createFileRoute('/expenses/$expenseId/')({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(expenseContextQuery(params.expenseId))
    void context.queryClient.prefetchQuery(feedOptionsQuery)
  },
  component: ExpensePage,
})

type Context = typeof ExpenseContext.Type

function ExpensePage() {
  const { expenseId } = Route.useParams()
  const context = useQuery(expenseContextQuery(expenseId))
  if (context.error) return <p role="alert">{errorMessage(context.error)}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  return <Workspace key={`${expenseId}-${context.data.expense.revision}`} data={context.data} />
}

const stamp = (value: string) => (
  <time dateTime={value} title={new Date(value).toLocaleString('en-US')}>
    {new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
  </time>
)

function Metadata({ data }: { data: Context }) {
  const a = data.attribution
  return (
    <div className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground" data-testid="expense-metadata">
      <p>
        Added {stamp(a.createdAt ?? data.expense.createdAt)}
        {a.createdBy ? ` by ${a.createdBy.name}` : ' · original author unavailable'}
      </p>
      {a.updatedAt && (
        <p>
          Last edited {stamp(a.updatedAt)}
          {a.updatedBy ? ` by ${a.updatedBy.name}` : ''}
        </p>
      )}
      {a.lastEditedByYouAt && <p>Your last edit {stamp(a.lastEditedByYouAt)}</p>}
    </div>
  )
}

/** Where a saved or cancelled form returns: the original private expense, or the dashboard. */
const backTo = (data: Context) =>
  data.context && data.context.expenseId !== data.expense.id ? ({ to: '/expenses/$expenseId', params: { expenseId: data.context.expenseId } } as const) : ({ to: '/' } as const)

function Workspace({ data }: { data: Context }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const options = useQuery(feedOptionsQuery)
  const { expense, group } = data
  const isPrivate = data.context !== null
  const back = backTo(data)
  const finish = async () => {
    await invalidateExpenses(queryClient)
    await navigate(back)
  }
  const update = async (input: ExpenseValues) => {
    await rpc((api) => api('expenses.update', { groupId: group.id, expenseId: expense.id, expectedRevision: expense.revision, idempotencyKey: randomId(), expense: input }))
    await finish()
  }
  const remove = async () => {
    await rpc((api) => api('expenses.delete', { groupId: group.id, expenseId: expense.id, expectedRevision: expense.revision, idempotencyKey: randomId() }))
    await finish()
  }
  const [deleteError, setDeleteError] = useState('')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/" className="underline">
          ← All expenses
        </Link>
        {isPrivate ? (
          <span className="text-muted-foreground">No group · Private to {data.participants.map((p) => p.name).join(', ')}</span>
        ) : (
          <Link to="/$group/expenses" params={{ group: group.slug ?? group.id }} className="underline">
            {group.name}
          </Link>
        )}
      </div>
      {data.context && expense.kind === 'payment' && (
        <p className="text-sm">
          Repayment for{' '}
          <Link to="/expenses/$expenseId" params={{ expenseId: data.context.expenseId }} className="underline">
            {data.context.title}
          </Link>
        </p>
      )}
      {expense.kind === 'payment' ? (
        <>
          <Metadata data={data} />
          <PaymentForm
            people={data.participants}
            editing
            initial={{
              from: expense.payers[0]?.participantId ?? '',
              to: expense.shares[0]?.participantId ?? '',
              amount: expense.amount,
              currency: expense.currency,
              date: expense.expenseDate,
              notes: expense.notes,
              title: expense.title,
            }}
            back={back}
            onSubmit={update}
            onDelete={remove}
          />
        </>
      ) : (
        <div className="space-y-4">
          <h1 className="font-display text-3xl">Edit expense</h1>
          <Metadata data={data} />
          {options.data ? (
            <ExpenseForm
              people={data.participants}
              categories={options.data.categories}
              initial={expense}
              fixedPeople={isPrivate}
              hint={isPrivate ? 'Edits stay in this expense’s private log.' : 'Edits are saved in the group’s log.'}
              submitLabel="Save"
              cancel={{ to: '/' }}
              onSubmit={update}
            />
          ) : (
            <p role="status">Loading categories…</p>
          )}
          <div className="space-y-2">
            <Button
              variant="outline"
              onClick={async () => {
                if (!window.confirm('Delete this expense? It stays in the history, and balances are recalculated.')) return
                setDeleteError('')
                await remove().catch((cause: unknown) => setDeleteError(errorMessage(cause)))
              }}
            >
              Delete expense
            </Button>
            {deleteError && (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            )}
          </div>
        </div>
      )}
      {data.context && expense.id === data.context.expenseId && <PrivateRepayments data={data} />}
    </div>
  )
}

function PrivateRepayments({ data }: { data: Context }) {
  const context = data.context
  const queryClient = useQueryClient()
  const payments = useInfiniteQuery(expensesQuery(data.group.id, { kind: 'payment' }))
  const [links, setLinks] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [renewing, setRenewing] = useState(false)
  if (!context) return null
  const name = (id: string) => data.participants.find((p) => p.id === id)?.name ?? 'Participant'
  const failure = error || (payments.error ? errorMessage(payments.error) : '')
  return (
    <section className="space-y-4 border-t pt-6" aria-label="Repayments for this expense">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-2xl">Repayments for this expense</h2>
        <Button variant="outline" asChild>
          <Link to="/expenses/$expenseId/payments/create" params={{ expenseId: context.expenseId }}>
            Record payment
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">These payments settle this expense only.</p>
      {failure && <p role="alert">{failure}</p>}
      {context.settlements.map(({ currency, transfers }) => (
        <div key={currency} className="space-y-3">
          {transfers.length === 0 ? (
            <p className="text-sm">Settled in {currency}.</p>
          ) : (
            transfers.map((t) => (
              <div key={`${t.from}-${t.to}`} className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm">
                <span>
                  {name(t.from)} owes {name(t.to)} <strong>{money(t.amount, currency)}</strong>
                </span>
                <Link
                  className="underline"
                  to="/expenses/$expenseId/payments/create"
                  params={{ expenseId: context.expenseId }}
                  search={{ from: t.from, to: t.to, amount: t.amount, currencyCode: currency }}
                >
                  Record repayment
                </Link>
              </div>
            ))
          )}
        </div>
      ))}
      {payments.data?.pages
        .flatMap((page) => page.expenses)
        .map((payment) => (
          <Link key={payment.id} className="block text-sm underline" to="/expenses/$expenseId" params={{ expenseId: payment.id }}>
            {payment.payers.map((p) => name(p.participantId)).join(', ')} paid {payment.shares.map((s) => name(s.participantId)).join(', ')} · {money(payment.amount, payment.currency)}
          </Link>
        ))}
      {payments.hasNextPage && (
        <Button variant="ghost" onClick={() => payments.fetchNextPage()}>
          Load more payments
        </Button>
      )}
      {context.invitations.map((invitation) => (
        <div key={invitation.id} className="space-y-2 border p-3 text-sm">
          <p>
            Invitation pending: {invitation.participantName} ({invitation.email})
          </p>
          {links[invitation.participantId] ? (
            <Input readOnly value={links[invitation.participantId]} onFocus={(e) => e.currentTarget.select()} />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={renewing}
              onClick={async () => {
                setRenewing(true)
                setError('')
                try {
                  const result = await rpc((api) =>
                    api('expenses.renewInvitation', { groupId: data.group.id, participantId: invitation.participantId, idempotencyKey: randomId() }),
                  )
                  // Links are kept per person, so the new one stays on screen after the list reloads.
                  setLinks((current) => ({ ...current, [result.participantId]: result.url }))
                  await queryClient.invalidateQueries({ queryKey: expenseContextQuery(data.expense.id).queryKey })
                } catch (cause) {
                  setError(errorMessage(cause))
                } finally {
                  setRenewing(false)
                }
              }}
            >
              Generate a new invitation link
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}
