'use client'

import { CurrentGroupProvider } from '@/app/groups/[groupId]/current-group-context'
import { EditExpenseForm } from '@/app/groups/[groupId]/expenses/edit-expense-form'
import { PaymentEditor } from '@/app/groups/[groupId]/payments/payment-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getCurrency } from '@/lib/currency'
import type { RuntimeFeatureFlags } from '@/lib/featureFlags'
import { groupPath } from '@/lib/group-slug'
import { formatCurrency } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import { useLocale } from 'next-intl'
import Link from 'next/link'
import { useState } from 'react'

export function ExpenseWorkspace({
  expenseId,
  runtimeFeatureFlags,
  recordingPayment = false,
}: {
  expenseId: string
  runtimeFeatureFlags: RuntimeFeatureFlags
  recordingPayment?: boolean
}) {
  const context = trpc.expenses.context.useQuery({ expenseId })
  if (context.error) return <p role="alert">{context.error.message}</p>
  if (!context.data) return <p role="status">Loading expense…</p>
  return (
    <LoadedWorkspace
      expenseId={expenseId}
      groupId={context.data.groupId}
      contextExpenseId={context.data.contextExpenseId}
      contextExpenseTitle={context.data.contextExpenseTitle}
      isPayment={context.data.isReimbursement}
      recordingPayment={recordingPayment}
      runtimeFeatureFlags={runtimeFeatureFlags}
    />
  )
}

function LoadedWorkspace({
  expenseId,
  groupId,
  contextExpenseId,
  contextExpenseTitle,
  isPayment,
  recordingPayment,
  runtimeFeatureFlags,
}: {
  expenseId: string
  groupId: string
  contextExpenseId: string | null
  contextExpenseTitle: string | null
  isPayment: boolean
  recordingPayment: boolean
  runtimeFeatureFlags: RuntimeFeatureFlags
}) {
  const group = trpc.groups.get.useQuery({ groupId })
  if (group.error) return <p role="alert">{group.error.message}</p>
  if (!group.data?.group) return <p role="status">Loading people…</p>
  const data = group.data.group
  const anchor = `/expenses/${contextExpenseId ?? expenseId}`
  return (
    <CurrentGroupProvider isLoading={false} groupId={groupId} group={data}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link href="/" className="underline">
            ← All expenses
          </Link>
          {contextExpenseId ? (
            <span className="text-muted-foreground">
              No group · Private to{' '}
              {data.participants.map((p) => p.name).join(', ')}
            </span>
          ) : (
            <Link href={groupPath(data)} className="underline">
              {data.name}
            </Link>
          )}
        </div>
        {contextExpenseId && (isPayment || recordingPayment) && (
          <p className="text-sm">
            Repayment for{' '}
            <Link href={anchor} className="underline">
              {contextExpenseTitle}
            </Link>
          </p>
        )}
        {recordingPayment || isPayment ? (
          <PaymentEditor
            paymentId={isPayment && !recordingPayment ? expenseId : undefined}
            returnHref={contextExpenseId ? anchor : '/'}
          />
        ) : (
          <EditExpenseForm
            groupId={groupId}
            expenseId={expenseId}
            runtimeFeatureFlags={runtimeFeatureFlags}
            returnHref="/"
            privateExpense={!!contextExpenseId}
          />
        )}
        {contextExpenseId && !recordingPayment && !isPayment && (
          <PrivateRepayments groupId={groupId} expenseId={contextExpenseId} />
        )}
      </div>
    </CurrentGroupProvider>
  )
}

function PrivateRepayments({
  groupId,
  expenseId,
}: {
  groupId: string
  expenseId: string
}) {
  const details = trpc.groups.getDetails.useQuery({ groupId })
  const balances = trpc.groups.balances.list.useQuery({ groupId })
  const payments = trpc.groups.expenses.list.useInfiniteQuery(
    { groupId, isReimbursement: true, limit: 30 },
    {
      getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    },
  )
  const access = trpc.expenses.renewInvitation.useMutation()
  const utils = trpc.useUtils()
  const locale = useLocale()
  const [links, setLinks] = useState<Record<string, string>>({})
  const participantName = (id: string) =>
    details.data?.group.participants.find((p) => p.id === id)?.name ??
    'Participant'
  const failure =
    balances.error || payments.error || details.error || access.error
  return (
    <section
      className="space-y-4 border-t pt-6"
      aria-label="Repayments for this expense"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-2xl">Repayments for this expense</h2>
        <Button variant="outline" asChild>
          <Link href={`/expenses/${expenseId}/payments/create`}>
            Record payment
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        These payments settle this expense only.
      </p>
      {failure && <p role="alert">{failure.message}</p>}
      {balances.isLoading ? (
        <p role="status">Loading balances…</p>
      ) : (
        balances.data?.currencies.map((currency) => (
          <div key={currency.currencyCode} className="space-y-3">
            {currency.reimbursements.length === 0 ? (
              <p className="text-sm">Settled in {currency.currencyCode}.</p>
            ) : (
              currency.reimbursements.map((r) => (
                <div
                  key={`${r.from}-${r.to}`}
                  className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm"
                >
                  <span>
                    {participantName(r.from)} owes {participantName(r.to)}{' '}
                    <strong>
                      {formatCurrency(
                        getCurrency(currency.currencyCode),
                        r.amount,
                        locale,
                      )}
                    </strong>
                  </span>
                  <Link
                    className="underline"
                    href={`/expenses/${expenseId}/payments/create?${new URLSearchParams({ from: r.from, to: r.to, amount: r.amount, currencyCode: currency.currencyCode })}`}
                  >
                    Record repayment
                  </Link>
                </div>
              ))
            )}
          </div>
        ))
      )}
      {payments.data?.pages
        .flatMap((page) => page.expenses)
        .map((payment) => (
          <Link
            key={payment.id}
            className="block text-sm underline"
            href={`/expenses/${payment.id}`}
          >
            {payment.paidBy.name} paid{' '}
            {payment.paidFor.map((p) => p.participant.name).join(', ')} ·{' '}
            {formatCurrency(
              getCurrency(payment.currencyCode),
              payment.amount,
              locale,
            )}
          </Link>
        ))}
      {payments.hasNextPage && (
        <Button variant="ghost" onClick={() => payments.fetchNextPage()}>
          Load more payments
        </Button>
      )}
      {details.data?.access.invitations.map((invitation) => (
        <div key={invitation.id} className="space-y-2 border p-3 text-sm">
          <p>
            Invitation pending: {invitation.participantName} ({invitation.email}
            )
          </p>
          {links[invitation.id] ? (
            <Input
              readOnly
              value={links[invitation.id]}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={access.isPending}
              onClick={async () => {
                try {
                  if (!invitation.participantId) return
                  const result = await access.mutateAsync({
                    groupId,
                    participantId: invitation.participantId,
                  })
                  setLinks((current) => ({
                    ...current,
                    [result.id]: result.url,
                  }))
                  await utils.groups.getDetails.invalidate({ groupId })
                } catch {
                  /* The mutation error is rendered above. */
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
