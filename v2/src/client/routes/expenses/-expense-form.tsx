// A compact expense form for ungrouped expenses and the /expenses/<id> page.
// It overlaps the group expense form of the expenses area; once that form
// exists, these pages should use it, with the private options below.
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { errorMessage } from '~/client/queries/feed'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import type { ExpenseInput } from '~/shared/api'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import type { DecimalString } from '~/shared/money'
import type { SplitMode } from '~/shared/split'

export type ExpenseValues = typeof ExpenseInput.Type
type Person = { readonly id: string; readonly name: string }
type Category = { readonly id: number; readonly grouping: string; readonly name: string }

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const CODES = (Object.keys(CURRENCIES) as CurrencyCode[]).sort()
const MODES: [SplitMode, string][] = [
  ['evenly', 'Evenly'],
  ['shares', 'By shares'],
  ['percentage', 'By percentage'],
  ['amount', 'By amount'],
]
const SEVERAL = '__several__'

/** Today as a calendar date in the browser's time zone. */
export function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export const decimal = (value: string) => (DECIMAL.test(value) ? (value as DecimalString) : null)

export function ExpenseForm(props: {
  people: readonly Person[]
  categories: readonly Category[]
  initial: ExpenseValues
  /** Private expenses: every person stays involved, and the expense never recurs. */
  fixedPeople: boolean
  hint: string
  submitLabel: string
  cancel: { to: '/' } | { to: '/expenses/$expenseId'; params: { expenseId: string } }
  onSubmit: (input: ExpenseValues) => Promise<void>
}) {
  const { initial } = props
  const [title, setTitle] = useState(initial.title)
  const [amount, setAmount] = useState<string>(initial.amount)
  const [currency, setCurrency] = useState<CurrencyCode>(initial.currency)
  const [date, setDate] = useState(initial.expenseDate)
  const [categoryId, setCategoryId] = useState(initial.categoryId)
  const [vendor, setVendor] = useState(initial.vendor ?? '')
  const [notes, setNotes] = useState(initial.notes)
  const several = initial.payers.length > 1
  const [payer, setPayer] = useState(several ? SEVERAL : (initial.payers[0]?.participantId ?? props.people[0]?.id ?? ''))
  const [mode, setMode] = useState<SplitMode>(initial.splitMode)
  const [included, setIncluded] = useState(() => new Set(props.fixedPeople ? props.people.map((p) => p.id) : initial.shares.map((s) => s.participantId)))
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(initial.shares.map((s) => [s.participantId, s.weight])))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    const total = decimal(amount.trim())
    if (!total) return setError('Enter an amount, such as 12.50.')
    const shares = props.people
      .filter((p) => included.has(p.id))
      .map((p) => ({ participantId: p.id, weight: mode === 'evenly' ? '1' : (weights[p.id] ?? '').trim() }))
    if (shares.length === 0) return setError('Choose at least one person.')
    if (mode !== 'evenly' && shares.some((s) => !decimal(s.weight))) return setError('Enter a number for each person.')
    const payers = payer === SEVERAL ? initial.payers : [{ participantId: payer, amount: total }]
    setSaving(true)
    try {
      await props.onSubmit({
        kind: 'expense',
        title,
        vendor: vendor.trim() || null,
        notes,
        categoryId,
        expenseDate: date,
        currency,
        amount: total,
        payers,
        splitMode: mode,
        shares,
        recurrence: props.fixedPeople ? 'none' : initial.recurrence,
      })
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm sm:col-span-2">
          <span>Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={2} maxLength={200} placeholder="Monday evening restaurant" />
        </label>
        <label className="space-y-2 text-sm">
          <span>Amount</span>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required placeholder="0.00" />
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
          <span>Expense date</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="space-y-2 text-sm">
          <span>Category</span>
          <NativeSelect value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.grouping === c.name ? c.name : `${c.grouping} · ${c.name}`}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-2 text-sm">
          <span>Vendor (optional)</span>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={100} />
        </label>
        <label className="space-y-2 text-sm">
          <span>Paid by</span>
          <NativeSelect value={payer} onChange={(e) => setPayer(e.target.value)}>
            {several && <option value={SEVERAL}>Several people (as recorded)</option>}
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-2 text-sm">
          <span>Repeat</span>
          <NativeSelect value={props.fixedPeople ? 'none' : initial.recurrence} disabled>
            <option value="none">Never</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </NativeSelect>
        </label>
        <label className="space-y-2 text-sm sm:col-span-2">
          <span>Notes</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </label>
      </div>
      <fieldset className="space-y-3 border p-4">
        <legend className="px-1 text-sm font-medium">Paid for</legend>
        <label className="block max-w-xs space-y-2 text-sm">
          <span>Split</span>
          <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as SplitMode)}>
            {MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <ul className="divide-y">
          {props.people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={included.has(p.id)}
                  disabled={props.fixedPeople}
                  onChange={(e) =>
                    setIncluded((current) => {
                      const next = new Set(current)
                      if (e.target.checked) next.add(p.id)
                      else next.delete(p.id)
                      return next
                    })
                  }
                />
                {p.name}
              </label>
              {mode !== 'evenly' && included.has(p.id) && (
                <Input
                  aria-label={`${MODES.find(([m]) => m === mode)?.[1]} for ${p.name}`}
                  className="w-28"
                  inputMode="decimal"
                  value={weights[p.id] ?? ''}
                  onChange={(e) => setWeights((w) => ({ ...w, [p.id]: e.target.value }))}
                />
              )}
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="text-xs text-muted-foreground">{props.hint}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={saving}>{saving ? 'Saving…' : props.submitLabel}</Button>
        <Button variant="ghost" asChild>
          <Link {...props.cancel}>Cancel</Link>
        </Button>
      </div>
    </form>
  )
}

