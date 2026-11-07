// The expense create and edit form, ported from the current app's
// src/app/groups/[groupId]/expenses/expense-form.tsx, with several payers.
// validateExpense checks the draft here and again on the server. The same form
// edits ungrouped (private) expenses, with the current app's privateExpense options.
import { Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { formatMoment } from '~/client/dates'
import { Button } from '~/client/ui/button'
import { Checkbox } from '~/client/ui/checkbox'
import { ChoiceSelect } from '~/client/ui/choice-select'
import { CurrencySelect } from '~/client/ui/currency-select'
import { DisclosureSummary } from '~/client/ui/disclosure'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import type { ExpenseDetail, Participant, Reference } from '~/shared/api'
import { CURRENCIES } from '~/shared/currencies'
import { LIMITS } from '~/shared/limits'
import { DECIMAL, formatMinor, minor } from '~/shared/minor'
import { RECURRENCE_LABELS, RECURRENCES, SPLIT_MODE_LABELS, SPLIT_MODES, type SplitMode } from '~/shared/vocabulary'
import { DeleteDialog } from './delete-dialog'
import { ExpenseDocuments } from './expense-documents'
import { amountInput, autoAmounts, check, involvesEveryone, isIncome, payerRemainder, saveSplitDefaults, type FormState } from './expense-form-state'
import { toInput, useEntryWrite, type EntryTarget } from './entry-write'

type DetailData = typeof ExpenseDetail.Type
type ReferenceData = typeof Reference.Type

const SPLIT_OPTIONS = SPLIT_MODES.map((mode) => ({ value: mode, label: SPLIT_MODE_LABELS[mode] }))
const RECURRENCE_OPTIONS = RECURRENCES.map((rule) => ({ value: rule, label: RECURRENCE_LABELS[rule] }))

function Field(props: { id: string; label: ReactNode; error?: string | undefined; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      {props.error && (
        <p id={`${props.id}-error`} className="text-sm text-destructive">
          {props.error}
        </p>
      )}
    </div>
  )
}

const PRIVATE_HINT = 'Edits stay in this expense’s private log.'
const PRIVATE_INVOLVED = 'The people with access to this private expense cannot be changed. Each person must pay or share.'

type ExpenseFormProps = {
  participants: ReadonlyArray<typeof Participant.Type>
  reference: ReferenceData
  target: EntryTarget
  initial: FormState
} & ({ mode: 'create'; expenseId: string } | { mode: 'edit'; detail: DetailData; onReload: () => void })

export function ExpenseForm(props: ExpenseFormProps) {
  const { participants, reference, target } = props
  const isPrivate = target.privateExpense
  const write = useEntryWrite({
    target,
    entry: props.mode === 'create' ? { mode: 'create', expenseId: props.expenseId } : { mode: 'edit', expenseId: props.detail.expense.id, revision: props.detail.expense.revision },
    noun: 'expense',
  })
  const [state, setState] = useState<FormState>(props.initial)
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const order = useMemo(() => participants.map((p) => p.id), [participants])
  const names = useMemo(() => new Map(participants.map((p) => [p.id, p.name])), [participants])

  const set = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }))
  const touch = (field: string) => setTouched((t) => new Set(t).add(field))
  const income = isIncome(state.amount)
  const noun = income ? 'income' : 'expense'
  const checked = check(state, order)
  const { preview } = checked
  // A private expense keeps its people: each one pays or shares (P-UNGROUP-48).
  const issues = isPrivate && !involvesEveryone(state, order) ? [...checked.issues, { field: 'shares', message: PRIVATE_INVOLVED }] : checked.issues
  const shown = (field: string) => (submitted || touched.has(field) ? issues.find((i) => i.field === field)?.message : undefined)
  const rowError = (list: 'shares' | 'payers', id: string) => (submitted || touched.has(list) ? issues.find((i) => i.row?.list === list && i.row.participantId === id)?.message : undefined)
  const auto = state.splitMode === 'amount' ? autoAmounts(state, order) : new Map<string, string>()
  const allSelected = order.every((id) => state.selected[id])
  const category = reference.categories.find((c) => c.id === state.categoryId)
  const headingVerb = props.mode === 'create' ? 'Add' : 'Edit'

  // Changing the mode or the amount forgets which amounts were typed (P-MONEY-85).
  const setAmount = (amount: string) => set({ amount, edits: {}, ...(isIncome(amount) ? { kind: 'expense' as const } : {}) })
  const setMode = (splitMode: SplitMode) => set({ splitMode, edits: {} })

  const submit = async () => {
    setSubmitted(true)
    write.clearFailure()
    const { draft, resolved } = checked
    if (issues.length || !resolved) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    const { groupId } = target
    await write.submit(toInput({ draft, resolved, documents: state.documents }), () => {
      if (state.saveDefault && groupId !== null) saveSplitDefaults({ groupId, state, participants: order })
    })
  }
  const { busy, failure } = write

  const sharesError = shown('shares')
  const payersError = shown('payers')
  const remainder = state.payerMode === 'several' ? payerRemainder(state, order) : null

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="space-y-4"
    >
      <h2 className="font-display text-xl">
        {headingVerb} {noun}
      </h2>
      {props.mode === 'edit' && <Attribution detail={props.detail} />}

      {/* One 24 px gap between the form's blocks, as between page blocks elsewhere. */}
      <div className="space-y-6">

        <section className="space-y-2 rounded-2xl border bg-card p-4 sm:space-y-3 sm:px-6 sm:py-5" aria-label={income ? 'Income details' : 'Expense details'}>
          <Field id="title" label="Description" error={shown('title')}>
            <Input
              id="title"
              className="h-11"
              placeholder="Monday evening restaurant"
              value={state.title}
              aria-invalid={!!shown('title')}
              onChange={(e) => set({ title: e.target.value })}
              onBlur={() => touch('title')}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
            <Field id="amount" label="Amount" error={shown('amount')}>
              <div className="flex gap-2">
                <Input
                  id="amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="h-11 min-w-0 flex-1 text-xl! font-semibold tabular-nums placeholder:font-normal placeholder:text-muted-foreground/70"
                  value={state.amount}
                  aria-invalid={!!shown('amount')}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setAmount(e.target.value)}
                  onBlur={() => touch('amount')}
                />
                <CurrencySelect
                  id="currency"
                  aria-label={income ? 'Currency of income' : 'Currency of expense'}
                  compact
                  value={state.currency}
                  onChange={(currency) => set({ currency, edits: {} })}
                  wrapperClassName="w-24 shrink-0"
                  className="h-11"
                />
              </div>
            </Field>
            <Field id="date" label={income ? 'Income date' : 'Expense date'} error={shown('expenseDate')}>
              <Input
                id="date"
                type="date"
                // The browser's calendar glyph is heavier than the other icons: quiet until hovered.
              className="block h-11 [&::-webkit-calendar-picker-indicator]:opacity-50 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
                value={state.expenseDate}
                aria-invalid={!!shown('expenseDate')}
                onChange={(e) => set({ expenseDate: e.target.value })}
                onBlur={() => touch('expenseDate')}
              />
            </Field>
          </div>
          <Field id="vendor" label="Vendor (optional)" error={shown('vendor')}>
            <Input id="vendor" className="h-11" placeholder="e.g. Costco" maxLength={LIMITS.vendorMax} value={state.vendor} onChange={(e) => set({ vendor: e.target.value })} onBlur={() => touch('vendor')} />
          </Field>

          <fieldset className="space-y-1.5">
            <legend className="text-sm leading-none font-medium">{income ? 'Received by' : 'Paid by'}</legend>
            {state.payerMode === 'one' ? (
              <NativeSelect id="payer" className="h-11" aria-label={income ? 'Received by' : 'Paid by'} value={state.payer} aria-invalid={!!payersError} onChange={(e) => set({ payer: e.target.value })}>
                <option value="">Select a participant</option>
                {participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <ul className="divide-y">
                {participants.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Label htmlFor={`payer-${p.id}`} className="font-normal">
                      {p.name}
                    </Label>
                    <div className="text-right">
                      <Input
                        id={`payer-${p.id}`}
                        inputMode="decimal"
                        placeholder="0"
                        className="w-32 text-right"
                        value={state.payerAmounts[p.id] ?? ''}
                        aria-invalid={!!rowError('payers', p.id)}
                        onChange={(e) => set({ payerAmounts: { ...state.payerAmounts, [p.id]: e.target.value } })}
                      />
                      {rowError('payers', p.id) && <p className="mt-1 text-xs text-destructive">{rowError('payers', p.id)}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {remainder !== null && remainder !== 0n && (
              <p className="text-xs text-muted-foreground" data-testid="payer-remainder">
                {remainder < 0n
                  ? `Assigned ${money(formatMinor({ amount: minor(-remainder), currency: state.currency }), state.currency)} more than the amount`
                  : `Left to assign: ${money(formatMinor({ amount: remainder, currency: state.currency }), state.currency)}`}
              </p>
            )}
            {payersError && <p className="text-sm text-destructive">{payersError}</p>}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 underline underline-offset-4"
              onClick={() =>
                state.payerMode === 'one'
                  ? set({ payerMode: 'several', payerAmounts: state.payer ? { [state.payer]: state.amount } : {} })
                  : set({ payerMode: 'one', payer: Object.keys(state.payerAmounts).find((id) => state.payerAmounts[id]?.trim()) ?? state.payer })
              }
            >
              {state.payerMode === 'one' ? 'Several people paid' : 'One person paid'}
            </Button>
          </fieldset>
        </section>

        <section className="space-y-3 rounded-2xl border bg-card p-4 sm:px-6 sm:py-5" aria-labelledby="paid-for">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="paid-for" className="text-base font-semibold leading-tight">
              {income ? 'Received for' : 'Paid for'}
            </h3>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 underline underline-offset-4"
              onClick={() => set({ selected: Object.fromEntries(order.map((id) => [id, !allSelected])), edits: {} })}
            >
              {allSelected ? 'Select none' : 'Select all'}
            </Button>
          </div>
          <Field id="split-mode" label="Split mode">
            <ChoiceSelect id="split-mode" className="h-11" value={state.splitMode} options={SPLIT_OPTIONS} onChange={setMode} />
          </Field>
          <ul className="divide-y">
            {participants.map((p) => {
              const selected = !!state.selected[p.id]
              const input = state.splitMode === 'amount' ? amountInput(state, auto, p.id) : { value: state.weights[p.id] ?? '', placeholder: '' }
              const error = rowError('shares', p.id)
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 sm:py-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`share-${p.id}`}
                      checked={selected}
                      onCheckedChange={(value) => set({ selected: { ...state.selected, [p.id]: value === true }, edits: {} })}
                    />
                    <Label htmlFor={`share-${p.id}`} className="font-normal">
                      {p.name}
                    </Label>
                  </div>
                  <div className="flex items-center gap-3">
                    {selected && state.kind !== 'payment' && preview?.get(p.id) !== undefined && (
                      <span className="text-sm tabular-nums text-muted-foreground" data-testid="share-preview">
                        {money(preview.get(p.id) ?? '0', state.currency)}
                      </span>
                    )}
                    {state.splitMode !== 'evenly' && (
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`${p.name} ${state.splitMode === 'amount' ? 'amount' : state.splitMode === 'percentage' ? 'percentage' : 'shares'}`}
                          inputMode="decimal"
                          disabled={!selected}
                          className="w-24 text-right"
                          value={selected ? input.value : ''}
                          placeholder={input.placeholder}
                          aria-invalid={!!error}
                          onChange={(e) => {
                            const value = e.target.value
                            set({
                              weights: { ...state.weights, [p.id]: value },
                              ...(state.splitMode === 'amount' ? { edits: { ...state.edits, [p.id]: value.trim() === '' ? 'cleared' : 'edited' } } : {}),
                            })
                          }}
                          onBlur={() => touch('shares')}
                        />
                        <span className="w-14 text-xs text-muted-foreground">
                          {state.splitMode === 'shares' ? 'share(s)' : state.splitMode === 'percentage' ? '%' : CURRENCIES[state.currency].symbol}
                        </span>
                      </div>
                    )}
                  </div>
                  {error && <p className="w-full text-xs text-destructive">{error}</p>}
                </li>
              )
            })}
          </ul>
          {sharesError && (
            <p role="alert" className="text-sm text-destructive">
              {sharesError}
            </p>
          )}
        </section>

        <div className="divide-y rounded-2xl border bg-card">
          <details className="px-4 py-1.5 sm:px-6" open={!!state.notes || state.documents.length > 0 || !!shown('notes')}>
            <DisclosureSummary>Notes & receipts</DisclosureSummary>
            <div className="space-y-4 pt-2 pb-3">
              <Field id="notes" label="Notes" error={shown('notes')}>
                <Textarea id="notes" rows={4} value={state.notes} onChange={(e) => set({ notes: e.target.value })} onBlur={() => touch('notes')} />
              </Field>
              {/* A new private expense has no context to store receipts in yet (P-UNGROUP-14, P-UNGROUP-15). */}
              {target.groupId !== null && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Receipts</p>
                  <p className="text-xs text-muted-foreground">See and attach receipts to the {noun}.</p>
                  <ExpenseDocuments groupId={target.groupId} attachments={reference.attachments} documents={state.documents} onChange={(documents) => set({ documents })} />
                </div>
              )}
            </div>
          </details>

          <details className="px-4 py-1.5 sm:px-6" open={state.kind === 'payment' || state.recurrence !== 'none'}>
            <DisclosureSummary>
              More options
              <span className="ml-2 font-normal text-muted-foreground">
                {category?.name ?? 'General'} · {RECURRENCE_LABELS[state.recurrence]}
              </span>
            </DisclosureSummary>
            <div className="space-y-4 pt-2 pb-3">
              <Field id="category" label="Category">
                <NativeSelect id="category" className="h-11" value={String(state.categoryId)} onChange={(e) => set({ categoryId: Number(e.target.value) })}>
                  {[...new Set(reference.categories.map((c) => c.grouping))].map((grouping) => (
                    <optgroup key={grouping} label={grouping}>
                      {reference.categories
                        .filter((c) => c.grouping === grouping)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                id="recurrence"
                label="Expense Recurrence"
                hint={
                  props.mode === 'edit' && props.detail.nextOccurrence
                    ? `The next copy is created on ${props.detail.nextOccurrence}. Choose None to stop the series.`
                    : 'Select how often the expense should repeat.'
                }
              >
                <ChoiceSelect id="recurrence" className="h-11" disabled={isPrivate} value={state.recurrence} options={RECURRENCE_OPTIONS} onChange={(recurrence) => set({ recurrence })} />
              </Field>
              {!income && !isPrivate && (
                <div className="flex items-center gap-2">
                  <Checkbox id="is-payment" checked={state.kind === 'payment'} onCheckedChange={(value) => set({ kind: value === true ? 'payment' : 'expense' })} />
                  <Label htmlFor="is-payment" className="font-normal">
                    This is a payment
                  </Label>
                </div>
              )}
              {/* Each private expense has its own people, so a saved default would never apply again. */}
              {!isPrivate && (
                <div className="flex items-center gap-2">
                  <Checkbox id="save-default" checked={state.saveDefault} onCheckedChange={(value) => set({ saveDefault: value === true })} />
                  <Label htmlFor="save-default" className="font-normal">
                    Save as default splitting options
                  </Label>
                </div>
              )}
            </div>
          </details>
        </div>

        {failure && (
          <div role="alert" className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{failure.message}</p>
            {failure.kind === 'conflict' && props.mode === 'edit' && (
              <Button type="button" variant="outline" size="sm" onClick={props.onReload}>
                Load the latest version
              </Button>
            )}
          </div>
        )}
        {submitted && issues.length > 0 && !failure && (
          <p role="alert" className="text-sm text-destructive">
            Fix the fields marked above, then save again.
          </p>
        )}

        {/* On wide screens the total and the actions share one bar at the end of the form. */}
        <div className="flex flex-wrap items-center justify-between gap-4 sm:rounded-2xl sm:border sm:bg-card sm:py-4 sm:ps-6 sm:pe-4">
          <Summary state={state} names={names} hint={isPrivate ? PRIVATE_HINT : 'Edits stay in the group’s log.'} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {props.mode === 'create' ? (busy ? 'Creating…' : 'Create') : busy ? 'Saving…' : 'Save changes'}
            </Button>
            {props.mode === 'edit' && (
              <DeleteDialog
                trigger={<Button variant="destructive">Delete</Button>}
                title="Delete this expense?"
                description={isPrivate ? 'It leaves the expense list and the balances. This expense’s private log keeps its history.' : "It leaves the expense list and the balances. The group's log keeps its history."}
                onConfirm={write.remove}
              />
            )}
            <Button type="button" variant="ghost" asChild>
              <Link {...target.back}>Cancel</Link>
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

/** The wide-screen summary (P-EXP-48). */
function Summary(props: { state: FormState; names: ReadonlyMap<string, string>; hint: string }) {
  const { state } = props
  const valid = DECIMAL.test(state.amount.trim())
  // Without a valid amount the total shows a muted zero, like the field's placeholder.
  const amount = money(valid ? state.amount.trim() : formatMinor({ amount: minor(0n), currency: state.currency }), state.currency)
  const payers =
    state.payerMode === 'one'
      ? props.names.get(state.payer)
      : Object.keys(state.payerAmounts)
          .filter((id) => state.payerAmounts[id]?.trim())
          .map((id) => props.names.get(id))
          .join(', ')
  const people = Object.values(state.selected).filter(Boolean).length
  return (
    <aside className="hidden min-w-0 text-sm sm:block" aria-label="Expense total">
      <p className={cn('text-xl font-semibold tabular-nums', !valid && 'text-muted-foreground')}>{amount}</p>
      <p className="text-muted-foreground">
        {state.currency} · {payers || 'No payer yet'} · {people} {people === 1 ? 'person' : 'people'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>
    </aside>
  )
}

function Attribution(props: { detail: DetailData }) {
  const { added, edited, myLastEdit } = props.detail
  const lines = [
    added ? `Added ${formatMoment.date(added.at)}${added.by ? ` by ${added.by}` : ''}` : null,
    edited ? `Last edited ${formatMoment.date(edited.at)}${edited.by ? ` by ${edited.by}` : ''}` : null,
    myLastEdit ? `Your last edit ${formatMoment.date(myLastEdit)}` : null,
  ].filter(Boolean)
  if (lines.length === 0) return null
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Attribution">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}
