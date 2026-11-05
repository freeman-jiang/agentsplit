// A compact payment editor for repayments of ungrouped expenses and for payments
// opened from the dashboard. It overlaps the payments area's editor.
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { errorMessage } from '~/client/queries/feed'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { decimal, type ExpenseValues } from './-expense-form'

const CODES = (Object.keys(CURRENCIES) as CurrencyCode[]).sort()
/** The "Payment" category: one category for every payment (DECISIONS.md, P-BAL-92). */
const PAYMENT_CATEGORY = 1

export function PaymentForm(props: {
  people: readonly { readonly id: string; readonly name: string }[]
  initial: { from: string; to: string; amount: string; currency: CurrencyCode; date: string; notes: string; title: string }
  editing: boolean
  back: { to: '/' } | { to: '/expenses/$expenseId'; params: { expenseId: string } }
  onSubmit: (input: ExpenseValues) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const { initial } = props
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [amount, setAmount] = useState(initial.amount)
  const [currency, setCurrency] = useState(initial.currency)
  const [date, setDate] = useState(initial.date)
  const [notes, setNotes] = useState(initial.notes)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const run = async (work: () => Promise<void>) => {
    setSaving(true)
    try {
      await work()
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!props.people.some((p) => p.id === from) || !props.people.some((p) => p.id === to)) return setError('Choose a sender and recipient.')
    if (from === to) return setError('Sender and recipient must be different people.')
    const total = decimal(amount.trim())
    if (!total || total.startsWith('-') || /^0(\.0*)?$/.test(total)) return setError('Enter an amount greater than zero.')
    void run(() =>
      props.onSubmit({
        kind: 'payment',
        title: initial.title,
        vendor: null,
        notes,
        categoryId: PAYMENT_CATEGORY,
        expenseDate: date,
        currency,
        amount: total,
        payers: [{ participantId: from, amount: total }],
        splitMode: 'evenly',
        shares: [{ participantId: to, weight: '1' }],
        recurrence: 'none',
      }),
    )
  }
  const person = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label className="space-y-2 text-sm">
      <span>{label}</span>
      <NativeSelect id={id} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a person</option>
        {props.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  )
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl">{props.editing ? 'Edit payment' : 'Record payment'}</h1>
      <p className="text-sm text-muted-foreground">Record money already paid between two people.</p>
      <form className="space-y-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          {person('payment-from', 'From', from, setFrom)}
          {person('payment-to', 'To', to, setTo)}
          <label className="space-y-2 text-sm">
            <span>Amount</span>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </label>
          <label className="space-y-2 text-sm">
            <span>Currency</span>
            <NativeSelect value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
              {CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-2 text-sm">
            <span>Payment date</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="space-y-2 text-sm">
            <span>Note (optional)</span>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Bank transfer" maxLength={5000} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Updates balances in {currency} only. Other currencies stay separate.</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving}>{saving ? 'Saving…' : props.editing ? 'Save payment' : 'Record payment'}</Button>
          <Button variant="ghost" asChild>
            <Link {...props.back}>Cancel</Link>
          </Button>
          {props.onDelete && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                if (window.confirm('Delete this payment? Balances will be recalculated.') && props.onDelete) void run(props.onDelete)
              }}
            >
              Delete payment
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
