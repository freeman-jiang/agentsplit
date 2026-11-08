// Readers for stored history snapshots. Two formats exist and stay as stored:
// rows imported from the current app carry `schemaVersion: 1` (decimal major
// units, one payer in `paidBy`, `paidFor` with share weights, `BY_AMOUNT` style
// split modes), and v2 writes `schemaVersion: 2` (formatted decimals, `payers`
// and `shares` arrays). Every reader turns both into one SavedExpense, so the
// Log, historical reads, balances and exports cannot disagree.
import { Schema } from 'effect'
import type { CurrencyCode } from './currencies'
import type { Category, SavedExpense, SavedState } from './history'
import { formatMinor, minor, minorOrNull, sumMinor, type Minor } from './minor'
import { CurrencyCodeSchema } from './money'
import { formatWeight, parseWeight, resolveShares, weightText } from './split'
import { EXPENSE_KINDS, RECURRENCE_BY_NAME, RECURRENCE_LIST, RECURRENCES, SPLIT_MODE_BY_NAME, SPLIT_MODE_LIST, SPLIT_MODES, type SplitMode } from './vocabulary'

// ---------- stored formats ----------

const Person = Schema.Struct({ id: Schema.String, name: Schema.String })

/** The current app's snapshot (src/lib/expense-history.ts expenseSnapshotSchema). */
const V1Expense = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal('expense'),
  group: Schema.optional(
    Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.optional(Schema.NullOr(Schema.String)), currency: Schema.String, currencyCode: Schema.NullOr(Schema.String) }),
  ),
  expense: Schema.Struct({
    id: Schema.String,
    revision: Schema.Number,
    title: Schema.String,
    vendor: Schema.optional(Schema.NullOr(Schema.String)),
    amount: Schema.String,
    currencyCode: CurrencyCodeSchema,
    expenseDate: Schema.String,
    createdAt: Schema.String,
    categoryId: Schema.Number,
    category: Schema.NullOr(Schema.Struct({ grouping: Schema.String, name: Schema.String })),
    originalAmount: Schema.NullOr(Schema.String),
    originalCurrency: Schema.NullOr(Schema.String),
    conversionRate: Schema.NullOr(Schema.String),
    paidBy: Person,
    paidFor: Schema.Array(Schema.Struct({ participantId: Schema.String, name: Schema.String, shares: Schema.String })),
    splitMode: Schema.Literals(SPLIT_MODE_LIST),
    isReimbursement: Schema.Boolean,
    notes: Schema.NullOr(Schema.String),
    recurrenceRule: Schema.NullOr(Schema.Literals(RECURRENCE_LIST)),
    documents: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
  }),
})

const V1Group = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    name: Schema.String,
    slug: Schema.optional(Schema.NullOr(Schema.String)),
    currency: Schema.String,
    currencyCode: Schema.NullOr(Schema.String),
    information: Schema.NullOr(Schema.String),
    participants: Schema.Array(Person),
  }),
})

/** v2's snapshot. The writer (expenseSnapshot in src/server/activity.ts) is checked against it. */
export const V2ExpenseSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literals(EXPENSE_KINDS),
  group: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.NullOr(Schema.String), currency: Schema.String })),
  expense: Schema.Struct({
    id: Schema.String,
    groupId: Schema.optional(Schema.String),
    revision: Schema.Number,
    kind: Schema.Literals(EXPENSE_KINDS),
    title: Schema.String,
    vendor: Schema.NullOr(Schema.String),
    notes: Schema.String,
    categoryId: Schema.Number,
    expenseDate: Schema.String,
    currency: CurrencyCodeSchema,
    amount: Schema.String,
    splitMode: Schema.Literals(SPLIT_MODES),
    payers: Schema.Array(Schema.Struct({ participantId: Schema.String, amount: Schema.String, name: Schema.String })),
    shares: Schema.Array(Schema.Struct({ participantId: Schema.String, amount: Schema.String, weight: Schema.String, name: Schema.String })),
    recurrence: Schema.Literals(RECURRENCES),
    createdAt: Schema.String,
    updatedAt: Schema.optional(Schema.String),
    documentCount: Schema.Number,
    documents: Schema.optional(
      Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String, width: Schema.optional(Schema.Number), height: Schema.optional(Schema.Number) })),
    ),
    originalAmount: Schema.optional(Schema.NullOr(Schema.String)),
    originalCurrency: Schema.optional(Schema.NullOr(Schema.String)),
    conversionRate: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

/**
 * The v2 group snapshot: the settings and the participants at write time. The
 * writer (groupSnapshot in src/server/activity.ts) is checked against it.
 */
export const V2GroupSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.NullOr(Schema.String),
    currency: CurrencyCodeSchema,
    information: Schema.String,
    revision: Schema.Number,
    participants: Schema.Array(Person),
  }),
})

/**
 * The private-context `create_group` snapshot that v2 wrote until the parity
 * audit (P-HIST-03): the group row itself, so the currency is in
 * `defaultCurrency`. Activities are permanent, so these rows stay readable.
 */
const V2PrivateGroupRow = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal('private'),
    name: Schema.String,
    slug: Schema.Null,
    defaultCurrency: CurrencyCodeSchema,
    information: Schema.String,
    revision: Schema.Number,
    participants: Schema.Array(Person),
  }),
})

const decodeV1Expense = Schema.decodeUnknownSync(V1Expense)
const decodeV1Group = Schema.decodeUnknownSync(V1Group)
const decodeV2Expense = Schema.decodeUnknownSync(V2ExpenseSnapshot)
const decodeV2Group = Schema.decodeUnknownSync(Schema.Union([V2GroupSnapshot, V2PrivateGroupRow]))

class UnreadableSnapshot extends Error {}

const toMinor = (amount: string, currency: CurrencyCode): Minor => {
  const value = minorOrNull({ amount, currency })
  if (value === null) throw new UnreadableSnapshot(`Amount ${amount} does not fit ${currency}`)
  return value
}

/** Canonical decimal text of a non-negative weight ("1.50" → "1.5"); a sign stays. */
function canonicalWeight(text: string): string {
  const negative = text.startsWith('-')
  try {
    const weight = parseWeight(negative ? text.slice(1) : text)
    const body = formatWeight(weight)
    return negative && weight.units !== 0n ? `-${body}` : body
  } catch {
    return text
  }
}

/**
 * The current app's allocation of a v1 snapshot (src/lib/shares.ts
 * getExpenseShares): an amount split whose parts add up is taken as is,
 * anything else is apportioned by weight with the payer first for leftovers.
 */
function v1Allocations(data: {
  amount: Minor
  currency: CurrencyCode
  splitMode: SplitMode
  payerId: string
  paidFor: ReadonlyArray<{ readonly participantId: string; readonly shares: string }>
}): ReadonlyMap<string, Minor> {
  if (data.splitMode === 'amount') {
    const exact = data.paidFor.map((p) => minorOrNull({ amount: p.shares, currency: data.currency }))
    if (exact.every((v) => v !== null) && sumMinor(exact) === data.amount)
      return new Map(data.paidFor.map((p, i) => [p.participantId, exact[i] ?? minor(0n)]))
  }
  return resolveShares({
    amount: data.amount,
    // Decimal weights in proportion, as the current app falls back to for a mismatched amount split.
    mode: data.splitMode === 'evenly' ? 'evenly' : 'shares',
    preferredParticipantId: data.payerId,
    participants: data.paidFor.map((p) => ({ participantId: p.participantId, weight: p.shares })),
  })
}

function fromV1(raw: typeof V1Expense.Type, categories: ReadonlyMap<number, Category>): SavedExpense {
  const e = raw.expense
  const currency = e.currencyCode
  const amount = toMinor(e.amount, currency)
  const splitMode = SPLIT_MODE_BY_NAME[e.splitMode]
  const parts = v1Allocations({ amount, currency, splitMode, payerId: e.paidBy.id, paidFor: e.paidFor })
  const money = (value: Minor) => formatMinor({ amount: value, currency })
  const weight = (shares: string) => {
    const exact = splitMode === 'amount' ? minorOrNull({ amount: shares, currency }) : null
    return exact === null ? canonicalWeight(shares) : money(exact)
  }
  return {
    schemaVersion: 1,
    id: e.id,
    revision: e.revision,
    kind: e.isReimbursement ? 'payment' : 'expense',
    title: e.title,
    vendor: e.vendor ?? null,
    notes: e.notes ?? '',
    categoryId: e.categoryId,
    category: e.category ?? categories.get(e.categoryId) ?? null,
    expenseDate: e.expenseDate.slice(0, 10),
    createdAt: e.createdAt,
    currency,
    amount: money(amount),
    payers: [{ participantId: e.paidBy.id, name: e.paidBy.name, amount: money(amount) }],
    splitMode,
    shares: e.paidFor.map((p) => ({ participantId: p.participantId, name: p.name, amount: money(parts.get(p.participantId) ?? minor(0n)), weight: weight(p.shares) })),
    recurrence: RECURRENCE_BY_NAME[e.recurrenceRule ?? 'NONE'],
    originalAmount: e.originalAmount,
    originalCurrency: e.originalCurrency,
    conversionRate: e.conversionRate,
    documents: e.documents.map((d) => ({ id: d.id, url: d.url })),
    documentCount: e.documents.length,
    group: raw.group ? { id: raw.group.id, name: raw.group.name, slug: raw.group.slug ?? null, currency: raw.group.currencyCode ?? raw.group.currency } : null,
  }
}

function fromV2(raw: typeof V2ExpenseSnapshot.Type, categories: ReadonlyMap<number, Category>): SavedExpense {
  const e = raw.expense
  const currency = e.currency
  const money = (amount: string) => formatMinor({ amount: toMinor(amount, currency), currency })
  const weight = (text: string) => (e.splitMode === 'amount' && /^-?\d+$/.test(text) ? weightText({ splitMode: e.splitMode, currency, weight: text }) : canonicalWeight(text))
  return {
    schemaVersion: 2,
    id: e.id,
    revision: e.revision,
    kind: e.kind,
    title: e.title,
    vendor: e.vendor,
    notes: e.notes,
    categoryId: e.categoryId,
    category: categories.get(e.categoryId) ?? null,
    expenseDate: e.expenseDate,
    createdAt: e.createdAt,
    currency,
    amount: money(e.amount),
    payers: e.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: money(p.amount) })),
    splitMode: e.splitMode,
    shares: e.shares.map((s) => ({ participantId: s.participantId, name: s.name, amount: money(s.amount), weight: weight(s.weight) })),
    recurrence: e.recurrence,
    originalAmount: e.originalAmount ?? null,
    originalCurrency: e.originalCurrency ?? null,
    conversionRate: e.conversionRate ?? null,
    documents: (e.documents ?? []).map((d) => ({ id: d.id, url: d.url })),
    documentCount: e.documentCount,
    group: raw.group ?? null,
  }
}

const version = (raw: unknown) =>
  typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? { schemaVersion: raw.schemaVersion, kind: 'kind' in raw ? raw.kind : undefined } : undefined

/**
 * Reads one stored snapshot. A snapshot that matches neither format throws
 * UnreadableSnapshot: history is evidence, so it is never guessed.
 */
export function readSnapshot(data: { raw: unknown; categories: ReadonlyMap<number, Category> }): SavedState {
  // `raw` is unknown because it is a jsonb column; the decoders below check it.
  const v = version(data.raw)
  try {
    if (v?.schemaVersion === 1 && v.kind === 'group') {
      const g = decodeV1Group(data.raw).group
      return {
        _tag: 'group',
        group: { schemaVersion: 1, name: g.name, slug: g.slug ?? null, currency: g.currencyCode ?? g.currency, information: g.information ?? '', participants: g.participants },
      }
    }
    if (v?.schemaVersion === 1) return { _tag: 'expense', expense: fromV1(decodeV1Expense(data.raw), data.categories) }
    if (v?.schemaVersion === 2 && v.kind === 'group') {
      const g = decodeV2Group(data.raw).group
      const currency = 'currency' in g ? g.currency : g.defaultCurrency
      return { _tag: 'group', group: { schemaVersion: 2, name: g.name, slug: g.slug, currency, information: g.information, participants: g.participants } }
    }
    if (v?.schemaVersion === 2) return { _tag: 'expense', expense: fromV2(decodeV2Expense(data.raw), data.categories) }
  } catch (cause) {
    if (cause instanceof UnreadableSnapshot) throw cause
    throw new UnreadableSnapshot(`The snapshot does not match schemaVersion ${String(v?.schemaVersion)}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  throw new UnreadableSnapshot(`Unknown snapshot schemaVersion ${String(v?.schemaVersion)}`)
}

/** The ledger entry of a saved expense, for historical balances. */
export function savedEntry(expense: SavedExpense) {
  const m = (amount: string) => toMinor(amount, expense.currency)
  const sum = (list: ReadonlyArray<{ participantId: string; amount: string }>) => {
    const map = new Map<string, Minor>()
    for (const p of list) map.set(p.participantId, minor((map.get(p.participantId) ?? 0n) + m(p.amount)))
    return map
  }
  return { currency: expense.currency, payers: sum(expense.payers), shares: sum(expense.shares) }
}

