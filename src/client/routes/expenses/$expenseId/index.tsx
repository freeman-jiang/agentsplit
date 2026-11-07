import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ExpenseForm, type FormGroup, type PageTarget } from '~/client/components/expense-form'
import { stateFromExpense } from '~/client/components/expense-form-state'
import { ExpenseLog } from '~/client/components/history/expense-log'
import { money } from '~/client/components/money'
import { isSimplePayment, PaymentForm } from '~/client/components/payment-form'
import { expensesQuery } from '~/client/queries'
import { expenseDetailQuery, referenceQuery } from '~/client/queries/expenses'
import { errorMessage, expenseContextQuery } from '~/client/queries/feed'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { randomId } from '~/shared/ids'
import type { ExpenseContext } from '~/shared/api'

export const Route = createFileRoute('/expenses/$expenseId/')({
  loader: ({ context, params }) => {
    // The detail read needs the group ID, which the context gives. The page shows any failure from its own queries.
    void context.queryClient
      .fetchQuery(expenseContextQuery(params.expenseId))
      .then((data) => context.queryClient.prefetchQuery(expenseDetailQuery(data.group.id, params.expenseId)))
      .catch(() => undefined)
    void context.queryClient.prefetchQuery(referenceQuery)
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
  const { expense, group } = data
  const isPrivate = data.context !== null
  const detail = useQuery(expenseDetailQuery(group.id, expense.id))
  const reference = useQuery(referenceQuery)
  // A payment form in create mode reads the default currency; the edit forms here do not.
  const people: FormGroup = { id: group.id, participants: data.participants, participantId: data.participantId, defaultCurrency: expense.currency }
  // The current app's privateExpense options apply to ungrouped expenses only (P-UNGROUP-66, P-UNGROUP-67).
  const target: PageTarget = { kind: 'page', privateExpense: isPrivate, back: backTo(data) }
  const onReload = () =>
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: expenseContextQuery(expense.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: expenseDetailQuery(group.id, expense.id).queryKey }),
    ])
  const failure = detail.error ?? reference.error
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
      {failure ? (
        <p role="alert">{errorMessage(failure)}</p>
      ) : !detail.data || !reference.data ? (
        <p role="status">Loading expense…</p>
      ) : isSimplePayment(detail.data) ? (
        <>
          <Metadata data={data} />
          <PaymentForm key={detail.data.expense.revision} mode="edit" detail={detail.data} group={people} target={target} onReload={onReload} />
        </>
      ) : (
        // Any other payment shape keeps every detail in the expense editor (P-BAL-89).
        <ExpenseForm
          // A new revision starts a fresh form, so a reload after a conflict shows the saved values.
          key={detail.data.expense.revision}
          mode="edit"
          detail={detail.data}
          group={people}
          reference={reference.data}
          target={target}
          initial={stateFromExpense({ expense: detail.data.expense, documents: detail.data.documents, participants: data.participants.map((p) => p.id) })}
          onReload={onReload}
        />
      )}
      {/* The collapsed expense log under the editor, as in the current app (P-HIST-80). */}
      <ExpenseLog group={group.id} groupId={group.id} expenseId={expense.id} />
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
        <div key={invitation.id} className="space-y-2 rounded-xl bg-muted/50 p-3 text-sm">
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
