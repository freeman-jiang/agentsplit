// Recording a payment between two people, ported from the current app's
// src/app/groups/[groupId]/payments/payment-form.tsx. A payment is an expense
// of kind 'payment': the sender pays, the recipient is the only share. The
// server accepts any payment shape (P-BAL-93); this form records the common one.
// It also records repayments of ungrouped expenses (P-UNGROUP-72).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { localDate } from '~/client/components/local-date'
import { money } from '~/client/components/money'
import { balancesQuery, invalidateMoney } from '~/client/queries/expenses'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import type { ExpenseDetail } from '~/shared/api'
import type { CurrencyCode } from '~/shared/currencies'
import { validateExpense, type ExpenseDraft } from '~/shared/expense-rules'
import { DeleteDialog } from './delete-dialog'
import { CurrencySelect, leavePage, type FormGroup, type GroupTarget, type PageTarget } from './expense-form'
import { toInput } from './expense-form-state'
import { describeWriteError, type WriteFailure } from './write-error'

type DetailData = typeof ExpenseDetail.Type

/** A payment the form can edit: one sender and one recipient (P-BAL-89). */
export const isSimplePayment = (detail: DetailData) => detail.expense.kind === 'payment' && detail.expense.payers.length === 1 && detail.expense.shares.length === 1

export type PaymentPrefill = { from?: string; to?: string; amount?: string; currencyCode?: CurrencyCode }

/** A payment saves in its group or private context, which exists already, so it never needs `create`. */
export type PaymentTarget = GroupTarget | Omit<PageTarget, 'create' | 'privateExpense'>

export function PaymentForm(
  props: { group: FormGroup; target: PaymentTarget } & ({ mode: 'create'; expenseId: string; prefill: PaymentPrefill } | { mode: 'edit'; detail: DetailData; onReload: () => void }),
) {
  const { group, target } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const saved = props.mode === 'edit' ? props.detail.expense : null
  const [from, setFrom] = useState(saved?.payers[0]?.participantId ?? (props.mode === 'create' ? (props.prefill.from ?? group.participantId ?? '') : ''))
  const [to, setTo] = useState(saved?.shares[0]?.participantId ?? (props.mode === 'create' ? (props.prefill.to ?? '') : ''))
  const [amount, setAmount] = useState(saved?.amount ?? (props.mode === 'create' ? (props.prefill.amount ?? '') : ''))
  const [currency, setCurrency] = useState<CurrencyCode>(saved?.currency ?? (props.mode === 'create' ? (props.prefill.currencyCode ?? group.defaultCurrency) : group.defaultCurrency))
  // Today where the person recording the payment is (P-BAL-73).
  const [date, setDate] = useState(saved?.expenseDate ?? localDate())
  const [note, setNote] = useState(saved?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const keys = useRef(new Map<string, string>())
  const { data: balances } = useQuery(balancesQuery(target.kind === 'group' ? target.groupParam : group.id))
  const suggestion = balances?.currencies.find((c) => c.currency === currency)?.settlements.find((s) => s.from === from && s.to === to)

  const submit = async () => {
    setFailure(null)
    if (!from || !to) return setError('Choose a sender and recipient.')
    if (from === to) return setError('Sender and recipient must be different people.')
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount.trim()) || /^0(?:\.0*)?$/.test(amount.trim())) return setError('Enter an amount greater than zero.')
    const draft: ExpenseDraft = {
      kind: 'payment',
      title: saved?.title ?? 'Payment',
      vendor: saved?.vendor ?? null,
      notes: note,
      // Payments use the Payment category on every path (DECISIONS.md, P-BAL-92).
      categoryId: saved?.categoryId ?? 1,
      expenseDate: date,
      currency,
      amount: amount.trim(),
      payers: [{ participantId: from, amount: amount.trim() }],
      splitMode: 'evenly',
      shares: [{ participantId: to, weight: '1' }],
      recurrence: saved?.recurrence ?? 'none',
    }
    const checked = validateExpense({ draft, participantIds: new Set(group.participants.map((p) => p.id)) })
    if (!checked.ok) return setError(checked.issues.map((i) => i.message).join(' '))
    setError(null)
    const expense = toInput({ draft, documents: props.mode === 'edit' ? props.detail.documents : [] })
    const signature = JSON.stringify(expense)
    const idempotencyKey = keys.current.get(signature) ?? crypto.randomUUID()
    keys.current.set(signature, idempotencyKey)
    setBusy(true)
    try {
      if (props.mode === 'create') await rpc((api) => api('expenses.create', { groupId: group.id, expenseId: props.expenseId, idempotencyKey, expense }))
      else
        await rpc((api) =>
          api('expenses.update', { groupId: group.id, expenseId: props.detail.expense.id, expectedRevision: props.detail.expense.revision, idempotencyKey, expense }),
        )
      if (target.kind === 'page') return await leavePage({ queryClient, navigate, back: target.back })
      await invalidateMoney({ queryClient, group: target.groupParam })
      await navigate({ to: '/$group/payments', params: { group: target.groupParam } })
    } catch (cause) {
      const described = describeWriteError(cause)
      // A create whose ID exists here was saved by an earlier attempt (P-BAL-84).
      if (props.mode === 'create' && described.kind === 'conflict') {
        if (target.kind === 'page') {
          toast.success('This payment was already saved.')
          return await leavePage({ queryClient, navigate, back: target.back })
        }
        await invalidateMoney({ queryClient, group: target.groupParam })
        toast.success('This payment was already saved.')
        await navigate({ to: '/$group/payments', params: { group: target.groupParam } })
        return
      }
      setFailure(described)
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string, label: string, value: string, onChange: (value: string) => void) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a participant</option>
        {group.participants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  )

  return (
    <form
      noValidate
      className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h2 className="font-display text-xl">{props.mode === 'create' ? 'Record payment' : 'Edit payment'}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {select('from', 'From', from, setFrom)}
        {select('to', 'To', to, setTo)}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="amount">Amount</Label>
        <div className="flex gap-2">
          <Input id="amount" inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} />
          <CurrencySelect id="currency" label="Currency" value={currency} onChange={setCurrency} />
        </div>
        {suggestion && suggestion.amount !== amount.trim() && (
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => setAmount(suggestion.amount)}>
            Use suggested amount: {suggestion.amount} {currency}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">Updates balances in {currency} only. Other currencies stay separate.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="date">Payment date</Label>
        <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="note">Note (optional)</Label>
        <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {(error || failure) && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error ?? failure?.message}</p>
          {failure?.kind === 'conflict' && props.mode === 'edit' && (
            <Button type="button" variant="outline" size="sm" onClick={props.onReload}>
              Load the latest version
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : props.mode === 'create' ? 'Record payment' : 'Save changes'}
        </Button>
        {props.mode === 'edit' && (
          <DeleteDialog
            label="Delete payment"
            title="Delete this payment?"
            description="Balances will be recalculated."
            onConfirm={async () => {
              await rpc((api) =>
                api('expenses.delete', { groupId: group.id, expenseId: props.detail.expense.id, expectedRevision: props.detail.expense.revision, idempotencyKey: crypto.randomUUID() }),
              )
              if (target.kind === 'page') return await leavePage({ queryClient, navigate, back: target.back })
              await invalidateMoney({ queryClient, group: target.groupParam })
              await navigate({ to: '/$group/payments', params: { group: target.groupParam } })
            }}
          />
        )}
        <Button type="button" variant="ghost" asChild>
          {target.kind === 'page' ? (
            <Link {...target.back}>Cancel</Link>
          ) : (
            <Link to="/$group/payments" params={{ group: target.groupParam }}>
              Cancel
            </Link>
          )}
        </Button>
      </div>
      {amount && /^\d/.test(amount) && from && to && from !== to && (
        <p className="text-sm text-muted-foreground">
          {group.participants.find((p) => p.id === from)?.name} pays {group.participants.find((p) => p.id === to)?.name}{' '}
          {/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount.trim()) ? money(amount.trim(), currency) : ''}
        </p>
      )}
    </form>
  )
}
