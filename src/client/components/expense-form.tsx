// The expense create and edit form, ported from the current app's
// src/app/groups/[groupId]/expenses/expense-form.tsx, with several payers.
// validateExpense checks the draft here and again on the server. The same form
// edits ungrouped (private) expenses, with the current app's privateExpense options.
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { invalidateMoney } from '~/client/queries/expenses'
import { invalidateExpenses } from '~/client/queries/feed'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Checkbox } from '~/client/ui/checkbox'
import { disclosure, DisclosureSummary } from '~/client/ui/disclosure'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import type { ExpenseDetail, Group, Reference } from '~/shared/api'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { LIMITS } from '~/shared/expense-rules'
import type { SplitMode } from '~/shared/split'
import { DeleteDialog } from './delete-dialog'
import { ExpenseDocuments } from './expense-documents'
import { amountInput, autoAmounts, check, involvesEveryone, isIncome, payerRemainder, saveSplitDefaults, toDraft, toInput, type ExpenseInputData, type FormState } from './expense-form-state'
import { describeWriteError, type WriteFailure } from './write-error'

type GroupData = typeof Group.Type
type DetailData = typeof ExpenseDetail.Type
type ReferenceData = typeof Reference.Type

export const COMMON_CURRENCIES = ['USD', 'EUR', 'JPY', 'GBP', 'CNY'] as const satisfies readonly CurrencyCode[]

const SPLIT_MODES: readonly [SplitMode, string][] = [
  ['evenly', 'Evenly'],
  ['shares', 'Unevenly – By shares'],
  ['percentage', 'Unevenly – By percentage'],
  ['amount', 'Unevenly – By amount'],
]
const RECURRENCE = [
  ['none', 'None'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
] as const

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' })

export function CurrencySelect(props: {
  id: string
  label: string
  value: CurrencyCode
  onChange: (currency: CurrencyCode) => void
  className?: string
  selectClassName?: string
}) {
  const others = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((c) => !(COMMON_CURRENCIES as readonly string[]).includes(c))
  return (
    <NativeSelect
      id={props.id}
      aria-label={props.label}
      value={props.value}
      displayValue={props.value}
      onChange={(e) => props.onChange(e.target.value as CurrencyCode)}
      wrapperClassName={cn('w-24 shrink-0', props.className)}
      className={props.selectClassName}
    >
      {[
        ['Common', COMMON_CURRENCIES],
        ['Other', others],
      ].map(([label, codes]) => (
        <optgroup key={String(label)} label={String(label)}>
          {(codes as readonly CurrencyCode[]).map((code) => (
            <option key={code} value={code}>
              {code} – {CURRENCIES[code].name}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  )
}

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

/** The group fields the expense and payment forms read. The /expenses pages pass the expense context's people. */
export type FormGroup = Pick<GroupData, 'id' | 'participants' | 'participantId' | 'defaultCurrency'>

/** Where a form on the /expenses pages returns after a save, a delete or Cancel: the original private expense, or the dashboard. */
export type PageBack = { to: '/' } | { to: '/expenses/$expenseId'; params: { expenseId: string } }

export type GroupTarget = {
  kind: 'group'
  /** The group's URL segment (slug or ID), for links and cache keys. */
  groupParam: string
}

/**
 * An expense on the /expenses pages: an ungrouped expense, its repayment, or a
 * group expense opened from the dashboard. `privateExpense` turns on the
 * current app's options for ungrouped expenses. A new ungrouped expense has no
 * context yet, so `create` saves it; it throws to show the error in the form.
 */
export type PageTarget = {
  kind: 'page'
  privateExpense: boolean
  back: PageBack
  create?: (data: { expense: ExpenseInputData; idempotencyKey: string }) => Promise<void>
}

export type FormTarget = GroupTarget | PageTarget

const PRIVATE_HINT = 'Edits stay in this expense’s private log.'
const PRIVATE_INVOLVED = 'The people with access to this private expense cannot be changed. Each person must pay or share.'

export type ExpenseFormProps = {
  group: FormGroup
  reference: ReferenceData
  target: FormTarget
  initial: FormState
} & ({ mode: 'create'; expenseId: string } | { mode: 'edit'; detail: DetailData; onReload: () => void })

export function ExpenseForm(props: ExpenseFormProps) {
  const { group, reference, target } = props
  const isPrivate = target.kind === 'page' && target.privateExpense
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [state, setState] = useState<FormState>(props.initial)
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  // One idempotency key per distinct draft, so a retry after a lost response cannot save twice.
  const keys = useRef(new Map<string, string>())
  const order = useMemo(() => group.participants.map((p) => p.id), [group.participants])
  const names = useMemo(() => new Map(group.participants.map((p) => [p.id, p.name])), [group.participants])

  const set = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }))
  const touch = (field: string) => setTouched((t) => new Set(t).add(field))
  const income = isIncome(state.amount)
  const noun = income ? 'income' : 'expense'
  const checked = check(state, order)
  const { preview } = checked
  // A private expense keeps its people: each one pays or shares (P-UNGROUP-48).
  const issues = isPrivate && !involvesEveryone(state, order) ? [...checked.issues, { field: 'shares', message: PRIVATE_INVOLVED }] : checked.issues
  const shown = (field: string) => (submitted || touched.has(field) ? issues.find((i) => i.field === field)?.message : undefined)
  const rowError = (list: 'shares' | 'payers', id: string) => (submitted || touched.has(list) ? issues.find((i) => i.participantId === id && i.field.startsWith(`${list}.`))?.message : undefined)
  const auto = state.splitMode === 'amount' ? autoAmounts(state, order) : new Map<string, string>()
  const allSelected = order.every((id) => state.selected[id])
  const category = reference.categories.find((c) => c.id === state.categoryId)
  const headingVerb = props.mode === 'create' ? 'Add' : 'Edit'

  // Changing the mode or the amount forgets which amounts were typed (P-MONEY-85).
  const setAmount = (amount: string) => set({ amount, edits: {}, ...(isIncome(amount) ? { kind: 'expense' as const } : {}) })
  const setMode = (splitMode: SplitMode) => set({ splitMode, edits: {} })

  const submit = async () => {
    setSubmitted(true)
    setFailure(null)
    if (issues.length) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    const expense = toInput({ draft: toDraft(state, order), documents: state.documents })
    const signature = JSON.stringify(expense)
    const idempotencyKey = keys.current.get(signature) ?? crypto.randomUUID()
    keys.current.set(signature, idempotencyKey)
    setBusy(true)
    try {
      if (props.mode === 'create' && target.kind === 'page' && target.create) {
        // The caller opens the saved expense, or its invitations, and checks whether a failed save arrived (P-UNGROUP-19).
        await target.create({ expense, idempotencyKey })
        return
      }
      if (props.mode === 'create') {
        await rpc((api) => api('expenses.create', { groupId: group.id, expenseId: props.expenseId, idempotencyKey, expense }))
      } else {
        await rpc((api) =>
          api('expenses.update', { groupId: group.id, expenseId: props.detail.expense.id, expectedRevision: props.detail.expense.revision, idempotencyKey, expense }),
        )
      }
      if (state.saveDefault) saveSplitDefaults({ groupId: group.id, state, participants: order })
      if (target.kind === 'page') return await leavePage({ queryClient, navigate, back: target.back })
      await invalidateMoney({ queryClient, group: target.groupParam })
      await navigate({ to: '/$group/expenses', params: { group: target.groupParam } })
    } catch (error) {
      const described = describeWriteError(error)
      // A create whose ID already exists here was saved by an earlier attempt (P-EXP-39).
      if (props.mode === 'create' && described.kind === 'conflict' && target.kind === 'group') {
        await invalidateMoney({ queryClient, group: target.groupParam })
        toast.success('This expense was already saved.')
        await navigate({ to: '/$group/expenses/$expenseId/edit', params: { group: target.groupParam, expenseId: props.expenseId } })
        return
      }
      setFailure(described)
    } finally {
      setBusy(false)
    }
  }

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
      className="space-y-4 sm:space-y-6"
    >
      <h2 className="font-display text-xl">
        {headingVerb} {noun}
      </h2>
      {props.mode === 'edit' && <Attribution detail={props.detail} />}

      <section className="space-y-2 rounded-2xl border bg-card p-4 sm:space-y-4 sm:p-6" aria-label={income ? 'Income details' : 'Expense details'}>
        <Field id="title" label="Description" error={shown('title')}>
          <Input
            id="title"
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
                className="h-12 min-w-0 flex-1 text-[2rem]! leading-none font-semibold tabular-nums placeholder:font-normal placeholder:text-muted-foreground/70"
                value={state.amount}
                aria-invalid={!!shown('amount')}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={() => touch('amount')}
              />
              <CurrencySelect
                id="currency"
                label={income ? 'Currency of income' : 'Currency of expense'}
                value={state.currency}
                onChange={(currency) => set({ currency, edits: {} })}
                selectClassName="h-12"
              />
            </div>
          </Field>
          <Field id="date" label={income ? 'Income date' : 'Expense date'} error={shown('expenseDate')}>
            <Input
              id="date"
              type="date"
              className="block h-10 sm:h-12"
              value={state.expenseDate}
              aria-invalid={!!shown('expenseDate')}
              onChange={(e) => set({ expenseDate: e.target.value })}
              onBlur={() => touch('expenseDate')}
            />
          </Field>
        </div>
        <Field id="vendor" label="Vendor (optional)" error={shown('vendor')}>
          <Input id="vendor" placeholder="e.g. Costco" maxLength={LIMITS.vendorMax} value={state.vendor} onChange={(e) => set({ vendor: e.target.value })} onBlur={() => touch('vendor')} />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{income ? 'Received by' : 'Paid by'}</legend>
          {state.payerMode === 'one' ? (
            <NativeSelect id="payer" aria-label={income ? 'Received by' : 'Paid by'} value={state.payer} aria-invalid={!!payersError} onChange={(e) => set({ payer: e.target.value })}>
              <option value="">Select a participant</option>
              {group.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <ul className="divide-y">
              {group.participants.map((p) => (
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
          {remainder !== null && remainder !== formatZero(state.currency) && (
            <p className="text-xs text-muted-foreground" data-testid="payer-remainder">
              {remainder.startsWith('-') ? `Assigned ${money(remainder.slice(1), state.currency)} more than the amount` : `Left to assign: ${money(remainder, state.currency)}`}
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

      <section className="space-y-3 rounded-2xl border bg-card p-4 sm:p-6" aria-labelledby="paid-for">
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
          <NativeSelect id="split-mode" value={state.splitMode} onChange={(e) => setMode(e.target.value as SplitMode)}>
            {SPLIT_MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <ul className="divide-y">
          {group.participants.map((p) => {
            const selected = !!state.selected[p.id]
            const input = state.splitMode === 'amount' ? amountInput(state, auto, p.id) : { value: state.weights[p.id] ?? '', placeholder: '' }
            const error = rowError('shares', p.id)
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
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
        <details className={cn(disclosure, 'px-4 py-1.5 sm:px-6')} open={!!state.notes || state.documents.length > 0 || !!shown('notes')}>
          <DisclosureSummary>Notes & receipts</DisclosureSummary>
          <div className="space-y-4 pt-2 pb-3">
            <Field id="notes" label="Notes" error={shown('notes')}>
              <Textarea id="notes" rows={4} value={state.notes} onChange={(e) => set({ notes: e.target.value })} onBlur={() => touch('notes')} />
            </Field>
            {/* A new private expense has no context to store receipts in yet (P-UNGROUP-14, P-UNGROUP-15). */}
            {reference.attachments.enabled && !(isPrivate && props.mode === 'create') && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Receipts</p>
                <p className="text-xs text-muted-foreground">See and attach receipts to the {noun}.</p>
                <ExpenseDocuments groupId={group.id} documents={state.documents} onChange={(documents) => set({ documents })} />
              </div>
            )}
          </div>
        </details>

        <details className={cn(disclosure, 'px-4 py-1.5 sm:px-6')} open={state.kind === 'payment' || state.recurrence !== 'none'}>
          <DisclosureSummary>
            More options
            <span className="ml-2 font-normal text-muted-foreground">
              {category?.name ?? 'General'} · {RECURRENCE.find(([v]) => v === state.recurrence)?.[1]}
            </span>
          </DisclosureSummary>
          <div className="space-y-4 pt-2 pb-3">
            <Field id="category" label="Category">
              <NativeSelect id="category" value={String(state.categoryId)} onChange={(e) => set({ categoryId: Number(e.target.value) })}>
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
              <NativeSelect id="recurrence" disabled={isPrivate} value={state.recurrence} onChange={(e) => set({ recurrence: e.target.value as FormState['recurrence'] })}>
                {RECURRENCE.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
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

      <Summary state={state} names={names} hint={isPrivate ? PRIVATE_HINT : 'Edits stay in the group’s log.'} />

      {failure && (
        <div role="alert" className="space-y-2 border border-destructive/50 p-3 text-sm text-destructive">
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

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {props.mode === 'create' ? (busy ? 'Creating…' : 'Create') : busy ? 'Saving…' : 'Save changes'}
        </Button>
        {props.mode === 'edit' && (
          <DeleteDialog
            label="Delete"
            title="Delete this expense?"
            description={isPrivate ? 'It leaves the expense list and the balances. This expense’s private log keeps its history.' : "It leaves the expense list and the balances. The group's log keeps its history."}
            onConfirm={async () => {
              await rpc((api) =>
                api('expenses.delete', { groupId: group.id, expenseId: props.detail.expense.id, expectedRevision: props.detail.expense.revision, idempotencyKey: crypto.randomUUID() }),
              )
              if (target.kind === 'page') return await leavePage({ queryClient, navigate, back: target.back })
              await invalidateMoney({ queryClient, group: target.groupParam })
              await navigate({ to: '/$group/expenses', params: { group: target.groupParam } })
            }}
          />
        )}
        <Button type="button" variant="ghost" asChild>
          {target.kind === 'page' ? (
            <Link {...target.back}>Cancel</Link>
          ) : (
            <Link to="/$group/expenses" params={{ group: target.groupParam }}>
              Cancel
            </Link>
          )}
        </Button>
      </div>
    </form>
  )
}

/** After a write on the /expenses pages: every screen that shows expenses or balances reads again, then the form returns. */
export async function leavePage(data: { queryClient: QueryClient; navigate: ReturnType<typeof useNavigate>; back: PageBack }) {
  await invalidateExpenses(data.queryClient)
  await data.navigate(data.back)
}

const formatZero = (currency: CurrencyCode) => (CURRENCIES[currency].decimals ? `0.${'0'.repeat(CURRENCIES[currency].decimals)}` : '0')

/** The wide-screen summary (P-EXP-48). */
function Summary(props: { state: FormState; names: ReadonlyMap<string, string>; hint: string }) {
  const { state } = props
  const amount = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(state.amount.trim()) ? money(state.amount.trim(), state.currency) : '—'
  const payers =
    state.payerMode === 'one'
      ? props.names.get(state.payer)
      : Object.keys(state.payerAmounts)
          .filter((id) => state.payerAmounts[id]?.trim())
          .map((id) => props.names.get(id))
          .join(', ')
  const people = Object.values(state.selected).filter(Boolean).length
  return (
    <aside className="hidden rounded-2xl border bg-muted/40 p-4 text-sm sm:block" aria-label="Expense total">
      <p className="text-2xl tabular-nums">{amount}</p>
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
    added ? `Added ${shortDate(added.at)}${added.by ? ` by ${added.by}` : ''}` : null,
    edited ? `Last edited ${shortDate(edited.at)}${edited.by ? ` by ${edited.by}` : ''}` : null,
    myLastEdit ? `Your last edit ${shortDate(myLastEdit)}` : null,
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
