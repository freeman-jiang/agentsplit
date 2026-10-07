'use client'

import { CurrencySelector } from '@/components/currency-selector'
import { ExpenseLog } from '@/components/expense-log'
import { ExpenseMetadata } from '@/components/expense-metadata'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { Locale } from '@/i18n/request'
import { defaultCurrencyList, getCurrency } from '@/lib/currency'
import { groupPath } from '@/lib/group-slug'
import { useActiveUser } from '@/lib/hooks'
import { Decimal, decimalTextSchema } from '@/lib/money'
import { randomId } from '@/lib/random'
import { EXPENSE_NOTES_MAX, expenseFormSchema } from '@/lib/schemas'
import { formatCurrency } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@/trpc/routers/_app'
import { useLocale } from 'next-intl'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useCurrentGroup } from '../current-group-context'

type Group = NonNullable<AppRouterOutput['groups']['get']['group']>
type Payment = AppRouterOutput['groups']['expenses']['get']['expense']

export function PaymentEditor({ paymentId }: { paymentId?: string }) {
  const { groupId, group } = useCurrentGroup()
  const query = trpc.groups.expenses.get.useQuery(
    { groupId, expenseId: paymentId ?? '' },
    { enabled: !!paymentId },
  )
  if (!group || (paymentId && query.isLoading))
    return <p role="status">Loading payment…</p>
  if (query.error) return <p role="alert">{query.error.message}</p>
  if (
    paymentId &&
    (!query.data?.expense.isReimbursement ||
      query.data.expense.paidFor.length !== 1)
  )
    return (
      <p>
        This entry uses the expense editor.{' '}
        <Link
          className="underline"
          href={`${groupPath(group)}/expenses/${paymentId}/edit`}
        >
          Open entry
        </Link>
      </p>
    )
  return (
    <PaymentForm
      key={paymentId ?? 'new'}
      group={group}
      payment={paymentId ? query.data?.expense : undefined}
    />
  )
}

function PaymentForm({ group, payment }: { group: Group; payment?: Payment }) {
  const params = useSearchParams()
  const currentPerson = useActiveUser(group.id)
  const router = useRouter()
  const utils = trpc.useUtils()
  const locale = useLocale() as Locale
  const [id] = useState(() => payment?.id ?? randomId())
  const [revision] = useState(payment?.revision)
  const [from, setFrom] = useState(
    payment?.paidById ?? params.get('from') ?? currentPerson ?? '',
  )
  const [to, setTo] = useState(
    payment?.paidFor[0]?.participantId ?? params.get('to') ?? '',
  )
  const [amount, setAmount] = useState(
    payment?.amount ?? params.get('amount') ?? '',
  )
  const [currencyCode, setCurrencyCode] = useState(
    payment?.currencyCode ??
      params.get('currencyCode') ??
      group.currencyCode ??
      'USD',
  )
  const [date, setDate] = useState(() => {
    if (payment) return payment.expenseDate.toISOString().slice(0, 10)
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  const [notes, setNotes] = useState(payment?.notes ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const create = trpc.groups.expenses.create.useMutation()
  const update = trpc.groups.expenses.update.useMutation()
  const remove = trpc.groups.expenses.delete.useMutation()
  const { data: balances } = trpc.groups.balances.list.useQuery({
    groupId: group.id,
  })
  const suggested = balances?.currencies
    .find((c) => c.currencyCode === currencyCode)
    ?.reimbursements.find((p) => p.from === from && p.to === to)
  const finish = async () => {
    await utils.groups.invalidate()
    router.push(`${groupPath(group)}/payments`)
  }
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl">
        {payment ? 'Edit payment' : 'Record payment'}
      </h1>
      {payment && (
        <ExpenseMetadata
          createdAt={payment.createdAt}
          attribution={payment.attribution}
        />
      )}
      <p className="text-sm text-muted-foreground">
        Record money already paid between two people.
      </p>
      <form
        className="payment-editor space-y-5"
        onSubmit={async (event) => {
          event.preventDefault()
          setError('')
          if (
            !group.participants.some((p) => p.id === from) ||
            !group.participants.some((p) => p.id === to)
          )
            return setError('Choose a sender and recipient.')
          if (from === to)
            return setError('Sender and recipient must be different people.')
          if (
            !decimalTextSchema.safeParse(amount).success ||
            !new Decimal(amount).isPositive()
          )
            return setError('Enter an amount greater than zero.')
          const parsed = expenseFormSchema.safeParse({
            title: payment?.title ?? 'Payment',
            amount,
            currencyCode,
            expenseDate: date,
            paidBy: from,
            paidFor: [{ participant: to, shares: '1' }],
            splitMode: 'EVENLY',
            isReimbursement: true,
            notes,
          })
          if (!parsed.success)
            return setError(
              parsed.error.issues[0]?.message ?? 'Check the payment details.',
            )
          setSaving(true)
          try {
            if (payment) {
              const values = parsed.data
              await update.mutateAsync({
                groupId: group.id,
                expenseId: id,
                expectedRevision: revision,
                expenseFormValues: {
                  amount: values.amount,
                  currencyCode: values.currencyCode,
                  expenseDate: values.expenseDate,
                  paidBy: values.paidBy,
                  paidFor: values.paidFor,
                  splitMode: 'EVENLY',
                  notes: values.notes,
                },
              })
            } else {
              try {
                await create.mutateAsync({
                  groupId: group.id,
                  expenseId: id,
                  expenseFormValues: parsed.data,
                })
              } catch (cause) {
                const recorded = await utils.groups.expenses.get
                  .fetch({ groupId: group.id, expenseId: id })
                  .catch(() => null)
                if (!recorded?.expense) throw cause
              }
            }
            await finish()
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not save payment.',
            )
            setSaving(false)
          }
        }}
      >
        <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="payment-from">From</label>
            <NativeSelect
              id="payment-from"
              className="h-11"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="" disabled>
                Who sent the money?
              </option>
              {group.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <label htmlFor="payment-to">To</label>
            <NativeSelect
              id="payment-to"
              className="h-11"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="" disabled>
                Who received it?
              </option>
              {group.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <label htmlFor="payment-amount">Amount</label>
            <Input
              id="payment-amount"
              name="amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="payment-currency">Currency</label>
            <CurrencySelector
              id="payment-currency"
              currencies={defaultCurrencyList(locale)}
              defaultValue={currencyCode}
              onValueChange={setCurrencyCode}
              isLoading={saving}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="payment-date">Payment date</label>
            <Input
              id="payment-date"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="payment-note">Note (optional)</label>
            <Textarea
              id="payment-note"
              rows={2}
              maxLength={EXPENSE_NOTES_MAX}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Bank transfer"
            />
          </div>
        </fieldset>
        {suggested && (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm"
            disabled={saving}
            onClick={() => setAmount(suggested.amount)}
          >
            Use suggested amount:{' '}
            {formatCurrency(
              getCurrency(currencyCode),
              suggested.amount,
              locale,
            )}{' '}
            {currencyCode}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          Updates balances in {currencyCode} only. Other currencies stay
          separate.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving}>
            {saving ? 'Saving…' : payment ? 'Save payment' : 'Record payment'}
          </Button>
          <Button variant="ghost" asChild>
            <Link href={`${groupPath(group)}/payments`}>Cancel</Link>
          </Button>
          {payment && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={async () => {
                if (
                  !window.confirm(
                    'Delete this payment? Balances will be recalculated.',
                  )
                )
                  return
                setSaving(true)
                setError('')
                try {
                  await remove.mutateAsync({
                    groupId: group.id,
                    expenseId: id,
                    expectedRevision: revision,
                  })
                  await finish()
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Could not delete payment.',
                  )
                  setSaving(false)
                }
              }}
            >
              Delete payment
            </Button>
          )}
        </div>
      </form>
      {payment && <ExpenseLog groupId={group.id} expenseId={payment.id} />}
    </div>
  )
}
