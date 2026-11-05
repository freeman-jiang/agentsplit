// Readers for stored history snapshots. Two formats exist and stay as stored:
// rows imported from the current app carry `schemaVersion: 1` (decimal major
// units, one payer in `paidBy`, `paidFor` with share weights, `BY_AMOUNT` style
// split modes), and v2 writes `schemaVersion: 2` (formatted decimals, `payers`
// and `shares` arrays). Every reader turns both into one SavedExpense, so the
// Log, historical reads, balances and exports cannot disagree.
import { Result, Schema } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'
import { formatMinor, minor, parseMinor, sumMinor, type DecimalString, type Minor } from './money'
import { parseWeight, resolveShares, type SplitMode } from './split'

export type Category = { readonly grouping: string; readonly name: string }
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

/** One saved expense revision, whatever format stored it. Money is decimal text at the currency's precision. */
export type SavedExpense = {
  readonly schemaVersion: 1 | 2
  readonly id: string
  readonly revision: number
  readonly kind: 'expense' | 'payment'
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly category: Category | null
  /** YYYY-MM-DD. */
  readonly expenseDate: string
  /** ISO timestamp of the expense's creation, as saved. */
  readonly createdAt: string
  readonly currency: CurrencyCode
  readonly amount: DecimalString
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly name: string; readonly amount: DecimalString }>
  readonly splitMode: SplitMode
  /** `weight` is the split input as people read it: a share count, a percentage, or an amount in major units. */
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly name: string; readonly amount: DecimalString; readonly weight: string }>
  readonly recurrence: Recurrence
  readonly originalAmount: string | null
  readonly originalCurrency: string | null
  readonly conversionRate: string | null
  /** Saved document pointers. v2 snapshots store only the count. */
  readonly documents: ReadonlyArray<{ readonly id: string; readonly url: string }>
  readonly documentCount: number
  /**
   * The group as the revision saved it; `currency` is its code when one was
   * saved. Readers fill it; the RPC contract leaves it out, so clients lack it.
   */
  readonly group?: { readonly id: string; readonly name: string; readonly slug: string | null; readonly currency: string } | null
}

export type SavedGroup = {
  readonly schemaVersion: 1 | 2
  readonly name: string
  readonly slug: string | null
  readonly currency: string
  readonly information: string
  readonly participants: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type SavedState = { readonly _tag: 'expense'; readonly expense: SavedExpense } | { readonly _tag: 'group'; readonly group: SavedGroup }

// ---------- stored formats ----------

const Currency = Schema.Literals(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]])
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
    currencyCode: Currency,
    expenseDate: Schema.String,
    createdAt: Schema.String,
    categoryId: Schema.Number,
    category: Schema.NullOr(Schema.Struct({ grouping: Schema.String, name: Schema.String })),
    originalAmount: Schema.NullOr(Schema.String),
    originalCurrency: Schema.NullOr(Schema.String),
    conversionRate: Schema.NullOr(Schema.String),
    paidBy: Person,
    paidFor: Schema.Array(Schema.Struct({ participantId: Schema.String, name: Schema.String, shares: Schema.String })),
    splitMode: Schema.Literals(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT']),
    isReimbursement: Schema.Boolean,
    notes: Schema.NullOr(Schema.String),
    recurrenceRule: Schema.NullOr(Schema.Literals(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'])),
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

/** v2's snapshot (src/server/ledger.ts `snapshot`). */
const V2Expense = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literals(['expense', 'payment']),
  group: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.NullOr(Schema.String), currency: Schema.String })),
  expense: Schema.Struct({
    id: Schema.String,
    revision: Schema.Number,
    kind: Schema.Literals(['expense', 'payment']),
    title: Schema.String,
    vendor: Schema.NullOr(Schema.String),
    notes: Schema.String,
    categoryId: Schema.Number,
    expenseDate: Schema.String,
    currency: Currency,
    amount: Schema.String,
    splitMode: Schema.Literals(['evenly', 'shares', 'percentage', 'amount']),
    payers: Schema.Array(Schema.Struct({ participantId: Schema.String, amount: Schema.String, name: Schema.String })),
    shares: Schema.Array(Schema.Struct({ participantId: Schema.String, amount: Schema.String, weight: Schema.String, name: Schema.String })),
    recurrence: Schema.Literals(['none', 'daily', 'weekly', 'monthly']),
    createdAt: Schema.String,
    documentCount: Schema.Number,
    originalAmount: Schema.optional(Schema.NullOr(Schema.String)),
    originalCurrency: Schema.optional(Schema.NullOr(Schema.String)),
    conversionRate: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

/**
 * The v2 group snapshot that group writes must store: the settings and the
 * participants at write time. Kept here so the reader and the writers agree.
 */
export const V2GroupSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.NullOr(Schema.String),
    currency: Currency,
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
    defaultCurrency: Currency,
    information: Schema.String,
    revision: Schema.Number,
    participants: Schema.Array(Person),
  }),
})

const decodeV1Expense = Schema.decodeUnknownSync(V1Expense)
const decodeV1Group = Schema.decodeUnknownSync(V1Group)
const decodeV2Expense = Schema.decodeUnknownSync(V2Expense)
const decodeV2Group = Schema.decodeUnknownSync(Schema.Union([V2GroupSnapshot, V2PrivateGroupRow]))

const V1_SPLIT: Record<'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE' | 'BY_AMOUNT', SplitMode> = {
  EVENLY: 'evenly',
  BY_SHARES: 'shares',
  BY_PERCENTAGE: 'percentage',
  BY_AMOUNT: 'amount',
}
const V1_RECURRENCE: Record<'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY', Recurrence> = { NONE: 'none', DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }

export class UnreadableSnapshot extends Error {}

const toMinor = (amount: string, currency: CurrencyCode): Minor => {
  const parsed = parseMinor({ amount, currency })
  if (Result.isFailure(parsed)) throw new UnreadableSnapshot(`Amount ${amount} does not fit ${currency}`)
  return parsed.success
}
const tryMinor = (amount: string, currency: CurrencyCode): Minor | undefined => {
  const parsed = parseMinor({ amount, currency })
  return Result.isSuccess(parsed) ? parsed.success : undefined
}

/** Canonical decimal text of a non-negative weight ("1.50" → "1.5"); a sign stays. */
function canonicalWeight(text: string): string {
  const negative = text.startsWith('-')
  try {
    const { units, scale } = parseWeight(negative ? text.slice(1) : text)
    const digits = units.toString().padStart(scale + 1, '0')
    const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    return negative && units !== 0n ? `-${body}` : body
  } catch {
    return text
  }
}

/**
 * The current app's allocation of a v1 snapshot (src/lib/shares.ts
 * getExpenseShares): an amount split whose parts add up is taken as is,
 * anything else is apportioned by weight with the payer first for leftovers.
 */
export function v1Allocations(data: {
  amount: Minor
  currency: CurrencyCode
  splitMode: SplitMode
  payerId: string
  paidFor: ReadonlyArray<{ readonly participantId: string; readonly shares: string }>
}): ReadonlyMap<string, Minor> {
  if (data.splitMode === 'amount') {
    const exact = data.paidFor.map((p) => tryMinor(p.shares, data.currency))
    if (exact.every((v) => v !== undefined) && sumMinor(exact) === data.amount)
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
  const splitMode = V1_SPLIT[e.splitMode]
  const parts = v1Allocations({ amount, currency, splitMode, payerId: e.paidBy.id, paidFor: e.paidFor })
  const money = (value: Minor) => formatMinor({ amount: value, currency })
  const weight = (shares: string) => {
    const exact = splitMode === 'amount' ? tryMinor(shares, currency) : undefined
    return exact === undefined ? canonicalWeight(shares) : money(exact)
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
    recurrence: V1_RECURRENCE[e.recurrenceRule ?? 'NONE'],
    originalAmount: e.originalAmount,
    originalCurrency: e.originalCurrency,
    conversionRate: e.conversionRate,
    documents: e.documents.map((d) => ({ id: d.id, url: d.url })),
    documentCount: e.documents.length,
    group: raw.group ? { id: raw.group.id, name: raw.group.name, slug: raw.group.slug ?? null, currency: raw.group.currencyCode ?? raw.group.currency } : null,
  }
}

function fromV2(raw: typeof V2Expense.Type, categories: ReadonlyMap<number, Category>): SavedExpense {
  const e = raw.expense
  const currency = e.currency
  const money = (amount: string) => formatMinor({ amount: toMinor(amount, currency), currency })
  // Amount-split weights are stored as minor units; show them as amounts.
  const weight = (text: string) => (e.splitMode === 'amount' && /^-?\d+$/.test(text) ? formatMinor({ amount: minor(BigInt(text)), currency }) : canonicalWeight(text))
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
    documents: [],
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

// ---------- display ----------

/** "1,234.50 USD": the currency's decimals and the ISO code, as the current app's revision panel shows. */
export function codeAmount(amount: string, currency: string): string {
  const decimals = currency in CURRENCIES ? CURRENCIES[currency as CurrencyCode].decimals : 2
  const negative = amount.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const digits = decimals === 0 ? '' : `.${fraction.padEnd(decimals, '0').slice(0, decimals)}`
  return `${negative ? '-' : ''}${grouped}${digits} ${currency}`
}

export const REVISION_FIELDS = [
  ['title', 'Title'],
  ['vendor', 'Vendor'],
  ['amount', 'Amount'],
  ['date', 'Expense date'],
  ['payer', 'Paid by'],
  ['splits', 'Split between'],
  ['splitMode', 'Split rule'],
  ['reimbursement', 'Payment'],
  ['category', 'Category'],
  ['originalAmount', 'Original amount'],
  ['conversionRate', 'Exchange rate'],
  ['recurrence', 'Recurrence'],
  ['notes', 'Notes'],
  ['attachments', 'Attachment references'],
] as const
export type RevisionField = (typeof REVISION_FIELDS)[number][0]

const SPLIT_LABEL: Record<SplitMode, string> = { evenly: 'Evenly', shares: 'By shares', percentage: 'By percentage', amount: 'By amount' }
const RECURRENCE_LABEL: Record<Recurrence, string> = { none: 'None', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

/**
 * Every field of the revision panel as text. Changed fields are found by
 * comparing these strings, as the current app does, so a v1 revision and the
 * v2 revision after it compare equal when nothing changed.
 */
export function describeRevision(expense: SavedExpense): Record<RevisionField, string> {
  const money = (amount: string, currency: string = expense.currency) => codeAmount(amount, currency)
  return {
    title: expense.title,
    vendor: expense.vendor ?? '',
    amount: money(expense.amount),
    date: expense.expenseDate,
    payer: expense.payers.length === 1 ? (expense.payers[0]?.name ?? '') : expense.payers.map((p) => `${p.name}: ${money(p.amount)}`).join('\n'),
    splits: expense.shares.map((s) => `${s.name}: ${money(s.amount)} (share ${s.weight})`).join('\n'),
    splitMode: SPLIT_LABEL[expense.splitMode],
    reimbursement: expense.kind === 'payment' ? 'Yes' : 'No',
    category: expense.category?.name ?? '',
    originalAmount: expense.originalAmount === null ? '' : money(expense.originalAmount, expense.originalCurrency ?? expense.currency),
    conversionRate: expense.conversionRate ?? '',
    recurrence: RECURRENCE_LABEL[expense.recurrence],
    notes: expense.notes,
    attachments:
      expense.documents.length > 0
        ? expense.documents
            .map((d) => d.url)
            .sort()
            .join('\n')
        : expense.documentCount > 0
          ? `${expense.documentCount} ${expense.documentCount === 1 ? 'attachment' : 'attachments'}`
          : '',
  }
}

/** The title with its vendor, "<vendor> — <title>", as the current app's expenseTitle. */
export const titleWithVendor = (e: { title: string; vendor: string | null }) => (e.vendor ? `${e.vendor} — ${e.title}` : e.title)
