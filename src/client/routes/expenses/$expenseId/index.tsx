import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { RepaymentSettlements } from '~/client/components/balance/settlements'
import { useOpenedEntry, usePageTarget } from '~/client/components/entry-write'
import { ExpenseForm } from '~/client/components/expense-form'
import { stateFromExpense } from '~/client/components/expense-form-state'
import { ExpenseLog } from '~/client/components/log/expense-log'
import { money } from '~/client/components/money'
import { isSimplePayment, PaymentForm } from '~/client/components/payment-form'
import { describeError } from '~/client/errors'
import { expenseDetailQuery, paymentsQuery, referenceQuery } from '~/client/queries/expenses'
import { expenseContextQuery } from '~/client/queries/feed'
import { afterWrite } from '~/client/queries/keys'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import type { ExpenseContext, ExpenseDetail, Reference } from '~/shared/api'
import { InvitationLink, PrivateContextHeader } from '../-private-context'

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
  if (context.error) return <p role="alert">{describeError(context.error).message}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  return <Workspace key={expenseId} data={context.data} />
}

/** Where a saved or cancelled form returns: the original private expense, or the dashboard. */
const backTo = (data: Context) =>
  data.context && data.context.expenseId !== data.expense.id ? ({ to: '/expenses/$expenseId', params: { expenseId: data.context.expenseId } } as const) : ({ to: '/' } as const)

function Workspace({ data }: { data: Context }) {
  const { expense, group } = data
  const detail = useQuery(expenseDetailQuery(group.id, expense.id))
  const reference = useQuery(referenceQuery)
  const failure = detail.error ?? reference.error
  return (
    <div className="space-y-6">
      <PrivateContextHeader data={data} repayment={expense.kind === 'payment'} />
      {failure ? (
        <p role="alert">{describeError(failure).message}</p>
      ) : !detail.data || !reference.data ? (
        <p role="status">Loading expense…</p>
      ) : (
        <Editor data={data} saved={detail.data} reference={reference.data} />
      )}
      {/* The collapsed expense log under the editor, as in the current app (P-HIST-80). */}
      <ExpenseLog groupId={group.id} expenseId={expense.id} />
      {data.context && expense.id === data.context.expenseId && <PrivateRepayments data={data} />}
    </div>
  )
}

function Editor({ data, saved, reference }: { data: Context; saved: typeof ExpenseDetail.Type; reference: typeof Reference.Type }) {
  const opened = useOpenedEntry({ groupId: data.group.id, detail: saved })
  const { detail } = opened
  // The current app's privateExpense options apply to ungrouped expenses only (P-UNGROUP-66, P-UNGROUP-67).
  const target = usePageTarget({ groupId: data.group.id, privateExpense: data.context !== null, back: backTo(data) })
  const onReload = () => void opened.reload()
  if (isSimplePayment(detail)) return <PaymentForm key={opened.key} mode="edit" detail={detail} participants={data.participants} target={target} onReload={onReload} />
  // An expense, or a payment of any other shape, uses the expense editor, which keeps every detail (P-BAL-89).
  return (
    <ExpenseForm
      key={opened.key}
      mode="edit"
      detail={detail}
      participants={data.participants}
      reference={reference}
      target={target}
      initial={stateFromExpense({ expense: detail.expense, documents: detail.documents, participants: data.participants.map((p) => p.id) })}
      onReload={onReload}
    />
  )
}

function PrivateRepayments({ data }: { data: Context }) {
  const context = data.context
  const queryClient = useQueryClient()
  const payments = useInfiniteQuery(paymentsQuery(data.group.id))
  const [links, setLinks] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [renewing, setRenewing] = useState(false)
  if (!context) return null
  const names = new Map(data.participants.map((p) => [p.id, p.name]))
  const name = (id: string) => names.get(id) ?? 'Unknown'
  const failure = error || (payments.error ? describeError(payments.error).message : '')
  return (
    <section className="space-y-4 border-t pt-6" aria-label="Payments for this expense">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Payments for this expense</h2>
        <Button variant="outline" asChild>
          <Link to="/expenses/$expenseId/payments/create" params={{ expenseId: context.expenseId }}>
            Record payment
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">These payments settle this expense only.</p>
      {failure && <p role="alert">{failure}</p>}
      <RepaymentSettlements names={names} expenseId={context.expenseId} settlements={context.settlements} />
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
            <InvitationLink url={links[invitation.participantId] ?? ''} />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={renewing}
              onClick={async () => {
                setRenewing(true)
                setError('')
                try {
                  const result = await rpc((api) => api('expenses.renewInvitation', { groupId: data.group.id, participantId: invitation.participantId }))
                  // Links are kept per person, so the new one stays on screen after the list reloads.
                  setLinks((current) => ({ ...current, [result.participantId]: result.url }))
                  await afterWrite({ queryClient, scope: 'group', groupId: data.group.id })
                } catch (cause) {
                  setError(describeError(cause).message)
                } finally {
                  setRenewing(false)
                }
              }}
            >
              Create a new invitation link
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}
