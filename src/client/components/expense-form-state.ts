// The expense form's state and the pure rules behind it: building the draft
// that validateExpense checks, the live share preview, and the auto-filled
// amounts of an amount split. Ported from the current app's expense-form.tsx.
import type { CurrencyCode } from '~/shared/currencies'
import { checkMoney, validateExpense, type ExpenseDraft, type ExpenseIssue, type ResolvedExpense } from '~/shared/expense-rules'
import { formatMinor, minor, minorOrNull, sumMinor, type Minor } from '~/shared/minor'
import { compareIds } from '~/shared/ids'
import { apportion, parseWeight, preferredPayer, weightText } from '~/shared/split'
import { CATEGORY, SPLIT_MODE_NAMES, SPLIT_MODES, type ExpenseKind, type Recurrence, type SplitMode } from '~/shared/vocabulary'
import { todayUtc } from '~/shared/dates'
import type { FormDocument } from './expense-documents'

export type FormState = {
  readonly kind: ExpenseKind
  readonly title: string
  readonly vendor: string
  readonly notes: string
  readonly categoryId: number
  readonly expenseDate: string
  readonly currency: CurrencyCode
  readonly amount: string
  /** One payer, or several with an amount each. */
  readonly payerMode: 'one' | 'several'
  readonly payer: string
  readonly payerAmounts: Readonly<Record<string, string>>
  readonly splitMode: SplitMode
  readonly selected: Readonly<Record<string, boolean>>
  /** Typed weights: share counts, percentages, or (in amount mode) decimal amounts. */
  readonly weights: Readonly<Record<string, string>>
  /** In amount mode: who typed their amount, and who emptied the input (P-EXP-84, P-EXP-85). */
  readonly edits: Readonly<Record<string, 'edited' | 'cleared'>>
  readonly recurrence: Recurrence
  readonly documents: readonly FormDocument[]
  readonly saveDefault: boolean
}

export const isIncome = (amount: string) => amount.trim().startsWith('-')

/** The payers the draft names, in group order. */
function payersOf(state: FormState, order: readonly string[]) {
  if (state.payerMode === 'one') return state.payer ? [{ participantId: state.payer, amount: state.amount.trim() }] : []
  return order.filter((id) => (state.payerAmounts[id] ?? '').trim() !== '').map((id) => ({ participantId: id, amount: (state.payerAmounts[id] ?? '').trim() }))
}

/** The payer who gets the first leftover unit, when the payers parse. */
function preferredOf(state: FormState, order: readonly string[]): string | null {
  const payers = payersOf(state, order).flatMap((p) => {
    const parsed = minorOrNull({ amount: p.amount, currency: state.currency })
    return parsed === null ? [] : [{ participantId: p.participantId, amount: parsed }]
  })
  return payers.length ? preferredPayer(payers) : null
}

/**
 * In amount mode, every selected person who has not typed an amount shares
 * what is left evenly, in minor units, with the payer first (P-MONEY-83).
 * The map is empty when the total or a typed amount does not parse.
 */
export function autoAmounts(state: FormState, order: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  const total = minorOrNull({ amount: state.amount.trim(), currency: state.currency })
  if (total === null) return result
  const selected = order.filter((id) => state.selected[id])
  const typed = selected.filter((id) => state.edits[id] === 'edited')
  let typedSum = 0n
  for (const id of typed) {
    const parsed = minorOrNull({ amount: (state.weights[id] ?? '').trim(), currency: state.currency })
    if (parsed === null) return result
    typedSum += parsed
  }
  const rest = selected.filter((id) => state.edits[id] !== 'edited').sort(compareIds)
  if (rest.length === 0) return result
  const preferred = preferredOf(state, order)
  const parts = apportion({ amount: minor(total - typedSum), weights: rest.map(() => parseWeight('1')), preferred: rest.findIndex((id) => id === preferred) })
  rest.forEach((id, index) => result.set(id, formatMinor({ amount: parts[index] ?? minor(0n), currency: state.currency })))
  return result
}

/** The value an amount-mode input shows, and its placeholder when it was emptied. */
export function amountInput(state: FormState, auto: ReadonlyMap<string, string>, id: string) {
  const edit = state.edits[id]
  if (edit === 'edited') return { value: state.weights[id] ?? '', placeholder: '' }
  if (edit === 'cleared') return { value: '', placeholder: auto.get(id) ?? '' }
  return { value: auto.get(id) ?? '', placeholder: '' }
}

export function toDraft(state: FormState, order: readonly string[]): ExpenseDraft {
  const auto = state.splitMode === 'amount' ? autoAmounts(state, order) : new Map<string, string>()
  return {
    kind: state.kind,
    title: state.title,
    vendor: state.vendor.trim() || null,
    notes: state.notes,
    categoryId: state.categoryId,
    expenseDate: state.expenseDate,
    currency: state.currency,
    amount: state.amount.trim(),
    payers: payersOf(state, order),
    splitMode: state.splitMode,
    shares: order
      .filter((id) => state.selected[id])
      .map((id) => ({
        participantId: id,
        weight:
          state.splitMode === 'evenly'
            ? '1'
            : state.splitMode === 'amount'
              ? state.edits[id] === 'edited'
                ? (state.weights[id] ?? '').trim()
                : (auto.get(id) ?? '')
              : (state.weights[id] ?? '').trim(),
      })),
    recurrence: state.recurrence,
  }
}

/** Whether each person pays or shares: a private expense keeps all its people (P-UNGROUP-48). */
export function involvesEveryone(state: FormState, order: readonly string[]) {
  const payers = new Set(payersOf(state, order).map((p) => p.participantId))
  return order.every((id) => state.selected[id] || payers.has(id))
}

export type Check = { readonly draft: ExpenseDraft; readonly resolved: ResolvedExpense | null; readonly issues: readonly ExpenseIssue[]; readonly preview: ReadonlyMap<string, string> | null }

/** Validates the draft, and resolves the split for the preview, which shows before the title is typed. */
export function check(state: FormState, order: readonly string[]): Check {
  const draft = toDraft(state, order)
  const participantIds = new Set(order)
  const result = validateExpense({ draft, participantIds })
  const issues = result.ok ? [] : result.issues
  const resolved = result.ok ? result.value : null
  // While several payers do not add up yet, preview with the payer who would get the leftover unit.
  const preferred = preferredOf(state, order)
  const payers = payerRemainder(state, order) === 0n || !preferred ? draft.payers : [{ participantId: preferred, amount: draft.amount }]
  const money = checkMoney({ money: { ...draft, payers }, participantIds })
  const preview = money.ok
    ? new Map(money.value.shares.map((s) => [s.participantId, formatMinor({ amount: s.amount, currency: state.currency })]))
    : null
  return { draft, resolved, issues, preview }
}

/** What is left to assign among several payers, when every amount parses. */
export function payerRemainder(state: FormState, order: readonly string[]): Minor | null {
  const total = minorOrNull({ amount: state.amount.trim(), currency: state.currency })
  if (total === null) return null
  const amounts = payersOf(state, order).map((p) => minorOrNull({ amount: p.amount, currency: state.currency }))
  if (amounts.some((a) => a === null)) return null
  return minor(total - sumMinor(amounts.flatMap((a) => (a === null ? [] : [a]))))
}

// ---------- saved splitting defaults ----------

// The current app's localStorage format, so defaults saved there keep working (P-EXP-93).
type Stored = { splitMode: (typeof SPLIT_MODE_NAMES)[SplitMode]; paidFor: { participant: string; shares: string }[] | null }
const storageKey = (groupId: string) => `${groupId}-defaultSplittingOptions-v2`

type SplitDefaults = { splitMode: SplitMode; weights: Record<string, string>; selected: Record<string, boolean> }

const everyoneEvenly = (participants: readonly string[]): SplitDefaults => ({
  splitMode: 'evenly',
  weights: Object.fromEntries(participants.map((id) => [id, '1'])),
  selected: Object.fromEntries(participants.map((id) => [id, true])),
})

/** The saved default split for a group, or every participant evenly (P-EXP-94, P-EXP-95). */
export function loadSplitDefaults(data: { groupId: string; participants: readonly string[] }): SplitDefaults {
  const evenly = everyoneEvenly(data.participants)
  let stored: Stored | null = null
  try {
    stored = JSON.parse(localStorage.getItem(storageKey(data.groupId)) ?? 'null') as Stored | null
  } catch {
    return evenly
  }
  if (!stored) return evenly
  const mode = SPLIT_MODES.find((m) => SPLIT_MODE_NAMES[m] === stored.splitMode)
  if (!mode) return evenly
  if (stored.paidFor === null) return { ...evenly, splitMode: mode }
  if (!Array.isArray(stored.paidFor)) return evenly
  if (stored.paidFor.some((p) => !data.participants.includes(p.participant))) {
    localStorage.removeItem(storageKey(data.groupId))
    return evenly
  }
  const picked = new Map(stored.paidFor.map((p) => [p.participant, String(p.shares)]))
  return {
    splitMode: mode,
    weights: Object.fromEntries(data.participants.map((id) => [id, picked.get(id) ?? '1'])),
    selected: Object.fromEntries(data.participants.map((id) => [id, picked.has(id)])),
  }
}

export function saveSplitDefaults(data: { groupId: string; state: FormState; participants: readonly string[] }) {
  const { state } = data
  const picked = data.participants.filter((id) => state.selected[id])
  const value: Stored = {
    splitMode: SPLIT_MODE_NAMES[state.splitMode],
    paidFor:
      state.splitMode === 'amount'
        ? null
        : picked.map((id) => ({ participant: id, shares: state.splitMode === 'evenly' ? '1' : (state.weights[id] ?? '1') })),
  }
  localStorage.setItem(storageKey(data.groupId), JSON.stringify(value))
}

// ---------- initial state ----------

type SavedExpense = {
  readonly kind: ExpenseKind
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly expenseDate: string
  readonly currency: CurrencyCode
  readonly amount: string
  readonly splitMode: SplitMode
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly amount: string }>
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly weight: string }>
  readonly recurrence: Recurrence
}

/** The form for a saved expense: every stored value as it was saved (P-EXP-46, P-MONEY-86, P-MONEY-95). */
export function stateFromExpense(data: { expense: SavedExpense; documents: readonly FormDocument[]; participants: readonly string[] }): FormState {
  const { expense } = data
  const shares = new Map(expense.shares.map((s) => [s.participantId, s.weight]))
  const shown = (weight: string) => weightText({ splitMode: expense.splitMode, currency: expense.currency, weight })
  const [onlyPayer] = expense.payers
  return {
    kind: expense.kind,
    title: expense.title,
    vendor: expense.vendor ?? '',
    notes: expense.notes,
    categoryId: expense.categoryId,
    expenseDate: expense.expenseDate,
    currency: expense.currency,
    amount: expense.amount,
    payerMode: expense.payers.length === 1 ? 'one' : 'several',
    payer: onlyPayer?.participantId ?? '',
    payerAmounts: Object.fromEntries(expense.payers.map((p) => [p.participantId, p.amount])),
    splitMode: expense.splitMode,
    selected: Object.fromEntries(data.participants.map((id) => [id, shares.has(id)])),
    weights: Object.fromEntries(data.participants.map((id) => [id, shares.has(id) ? shown(shares.get(id) ?? '1') : '1'])),
    edits: expense.splitMode === 'amount' ? Object.fromEntries(expense.shares.map((s) => [s.participantId, 'edited' as const])) : {},
    recurrence: expense.recurrence,
    documents: data.documents,
    saveDefault: false,
  }
}

export type Prefill = {
  readonly title?: string
  readonly vendor?: string
  readonly date?: string
  readonly amount?: string
  readonly categoryId?: number
  readonly currencyCode?: CurrencyCode
}

/**
 * A new expense: the saved split defaults, the viewer as payer, and any URL prefill (P-EXP-66, P-EXP-71, P-EXP-96).
 * A new private expense has no group (`groupId: null`), so it starts with everyone, evenly.
 */
export function newExpenseState(data: { groupId: string | null; participants: readonly string[]; viewer: string | null; defaultCurrency: CurrencyCode; prefill: Prefill }): FormState {
  const defaults = data.groupId === null ? everyoneEvenly(data.participants) : loadSplitDefaults({ groupId: data.groupId, participants: data.participants })
  const { prefill } = data
  return {
    kind: 'expense',
    title: prefill.title ?? '',
    vendor: prefill.vendor ?? '',
    notes: '',
    categoryId: prefill.categoryId ?? CATEGORY.general,
    // Today as a UTC calendar date, as the current expense form defaults (P-EXP-68).
    expenseDate: prefill.date ?? todayUtc(),
    currency: prefill.currencyCode ?? data.defaultCurrency,
    amount: prefill.amount ?? '',
    payerMode: 'one',
    payer: data.viewer ?? '',
    payerAmounts: {},
    splitMode: defaults.splitMode,
    selected: defaults.selected,
    weights: defaults.weights,
    edits: {},
    recurrence: 'none',
    documents: [],
    saveDefault: false,
  }
}
