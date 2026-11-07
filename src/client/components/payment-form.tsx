// Recording a payment between two people, ported from the current app's
// src/app/groups/[groupId]/payments/payment-form.tsx. A payment is an expense
// of kind 'payment': the sender pays, the recipient is the only share. The
// server accepts any payment shape (P-BAL-93); this form records the common one.
// It also records repayments of ungrouped expenses (P-UNGROUP-72).
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { money } from '~/client/components/money'
import { localDate } from '~/client/dates'
import { balancesQuery } from '~/client/queries/expenses'
import { Button } from '~/client/ui/button'
import { CurrencySelect } from '~/client/ui/currency-select'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import type { ExpenseDetail, Participant } from '~/shared/api'
import type { CurrencyCode } from '~/shared/currencies'
import { validateExpense, type ExpenseDraft } from '~/shared/expense-rules'
import { DECIMAL } from '~/shared/minor'
import { CATEGORY } from '~/shared/vocabulary'
import { DeleteDialog } from './delete-dialog'
import { toInput, useEntryWrite, type GroupEntryTarget } from './entry-write'

type DetailData = typeof ExpenseDetail.Type

/** A payment the form can edit: one sender and one recipient (P-BAL-89). */
export const isSimplePayment = (detail: DetailData) => detail.expense.kind === 'payment' && detail.expense.payers.length === 1 && detail.expense.shares.length === 1

type PaymentPrefill = { from?: string; to?: string; amount?: string; currencyCode?: CurrencyCode }

/** A decimal amount without a sign. */
const unsigned = (text: string) => DECIMAL.test(text) && !text.startsWith('-')

/**
 * A payment saves in its group or private context, which exists already. A new
 * payment starts from the viewer, the prefill and the default currency.
 */
export function PaymentForm(
  props: { participants: ReadonlyArray<typeof Participant.Type>; target: GroupEntryTarget } & (
    | { mode: 'create'; expenseId: string; prefill: PaymentPrefill; viewer: string | null; defaultCurrency: CurrencyCode }
    | { mode: 'edit'; detail: DetailData; onReload: () => void }
  ),
) {
  const { participants, target } = props
  const write = useEntryWrite({
    target,
    entry: props.mode === 'create' ? { mode: 'create', expenseId: props.expenseId } : { mode: 'edit', expenseId: props.detail.expense.id, revision: props.detail.expense.revision },
    noun: 'payment',
  })
  const saved = props.mode === 'edit' ? props.detail.expense : null
  const created = props.mode === 'create' ? props : null
  const [from, setFrom] = useState(saved?.payers[0]?.participantId ?? created?.prefill.from ?? created?.viewer ?? '')
  const [to, setTo] = useState(saved?.shares[0]?.participantId ?? created?.prefill.to ?? '')
  const [amount, setAmount] = useState(saved?.amount ?? created?.prefill.amount ?? '')
  const [currency, setCurrency] = useState<CurrencyCode>(props.mode === 'edit' ? props.detail.expense.currency : (props.prefill.currencyCode ?? props.defaultCurrency))
  // Today where the person recording the payment is (P-BAL-73).
  const [date, setDate] = useState(saved?.expenseDate ?? localDate())
  const [note, setNote] = useState(saved?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const { busy, failure } = write
  const { data: balances } = useQuery(balancesQuery(target.groupId))
  const suggestion = balances?.currencies.find((c) => c.currency === currency)?.settlements.find((s) => s.from === from && s.to === to)

  const submit = async () => {
    write.clearFailure()
    if (!from || !to) return setError('Choose a sender and recipient.')
    if (from === to) return setError('Sender and recipient must be different people.')
    if (!unsigned(amount.trim()) || /^0(?:\.0*)?$/.test(amount.trim())) return setError('Enter an amount greater than zero.')
    const draft: ExpenseDraft = {
      kind: 'payment',
      title: saved?.title ?? 'Payment',
      vendor: saved?.vendor ?? null,
      notes: note,
      categoryId: saved?.categoryId ?? CATEGORY.payment,
      expenseDate: date,
      currency,
      amount: amount.trim(),
      payers: [{ participantId: from, amount: amount.trim() }],
      splitMode: 'evenly',
      shares: [{ participantId: to, weight: '1' }],
      recurrence: saved?.recurrence ?? 'none',
    }
    const checked = validateExpense({ draft, participantIds: new Set(participants.map((p) => p.id)) })
    if (!checked.ok) return setError(checked.issues.map((i) => i.message).join(' '))
    setError(null)
    await write.submit(toInput({ draft, resolved: checked.value, documents: props.mode === 'edit' ? props.detail.documents : [] }))
  }

  const select = (id: string, label: string, value: string, onChange: (value: string) => void) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a participant</option>
        {participants.map((p) => (
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
          <CurrencySelect id="currency" aria-label="Currency" compact value={currency} onChange={setCurrency} wrapperClassName="w-24 shrink-0" />
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
          <DeleteDialog trigger={<Button variant="destructive">Delete payment</Button>} title="Delete this payment?" description="Balances will be recalculated." onConfirm={write.remove} />
        )}
        <Button type="button" variant="ghost" asChild>
          <Link {...target.back}>Cancel</Link>
        </Button>
      </div>
      {amount && /^\d/.test(amount) && from && to && from !== to && (
        <p className="text-sm text-muted-foreground">
          {participants.find((p) => p.id === from)?.name} pays {participants.find((p) => p.id === to)?.name}{' '}
          {unsigned(amount.trim()) ? money(amount.trim(), currency) : ''}
        </p>
      )}
    </form>
  )
}
