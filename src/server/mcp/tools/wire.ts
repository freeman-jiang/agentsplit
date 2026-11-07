// The current app's MCP wire format of results: the output schemas the tools
// share, and the one mapper from each service value to them. The services
// (src/server/) return v2 values; this module gives them the current app's
// names (src/shared/vocabulary.ts), timestamps and money text, so every tool
// that returns an expense, a snapshot or a group returns the same shape.
import { Schema } from 'effect'
import { RecordedTime as ContractRecordedTime } from '../../../shared/api/history'
import { CURRENCIES, type CurrencyCode } from '../../../shared/currencies'
import { legacyDateTime } from '../../../shared/dates'
import type { SavedExpense, SavedState } from '../../../shared/history'
import { formatMinor, minor } from '../../../shared/minor'
import { mainPayer, weightText } from '../../../shared/split'
import { ACTIVITY_TYPE_LIST, RECURRENCE_LIST, RECURRENCE_NAMES, SPLIT_MODE_LIST, SPLIT_MODE_NAMES } from '../../../shared/vocabulary'
import { attributionOf, type AttributionEvent } from '../../activity'
import type { DocumentState, ReadExpense } from '../../expense-read'
import { absoluteUrl, receiptDownloadPath } from '../../../shared/paths'

/** An optional key: absent, never undefined. */
export const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

// ---------- primitives ----------

export const Id = Schema.String
export const NullableString = Schema.NullOr(Schema.String)
/** An ISO timestamp in output. */
export const DateTime = Schema.String.annotate({ format: 'date-time' })
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Money = Schema.String.annotate({ description: 'Exact decimal string in the stated currency, e.g. 12.34' })

/** The contract's recorded time: a time zone, and at most millisecond precision. */
export const RecordedTime = ContractRecordedTime.annotate({
  format: 'date-time',
  description: 'Recorded-change timestamp with timezone, e.g. 2026-10-01T15:00:00Z; not the expense date.',
})

// The current app's names for v2 values.
export const SplitModeName = Schema.Literals(SPLIT_MODE_LIST)
export const RecurrenceName = Schema.Literals(RECURRENCE_LIST)
export const ActivityTypeName = Schema.Literals(ACTIVITY_TYPE_LIST)

export const isCurrencyCode = (code: string): code is CurrencyCode => code in CURRENCIES

/** Stored minor units as decimal text at the currency's full precision. */
export const money = (amount: string, currency: string) => (isCurrencyCode(currency) ? formatMinor({ amount: minor(BigInt(amount)), currency }) : amount)

/** The current app's `currency` field: the symbol. v2 stores only the code. */
export const symbolOf = (code: string) => (isCurrencyCode(code) ? CURRENCIES[code].symbol : code)

/** The authenticated receipt URL of a stored receipt pointer. */
const downloadUrl = (data: { baseUrl: string; groupId: string; url: string }) => absoluteUrl({ baseUrl: data.baseUrl, path: receiptDownloadPath(data) })

// ---------- output schemas ----------

export const Person = Schema.Struct({ id: Id, name: Schema.String })
export const Category = Schema.NullOr(Schema.Struct({ id: Schema.Int, name: Schema.String, grouping: Schema.String }))
const Actor = Schema.NullOr(Schema.Struct({ userId: NullableString, name: Schema.String, source: Schema.String }))
export const Attribution = Schema.Struct({
  createdAt: optional(NullableString),
  updatedAt: optional(NullableString),
  lastEditedByYouAt: optional(NullableString),
  createdBy: Actor,
  updatedBy: Actor,
})
export const Revision = NonNegativeInt

/** Set for a receipt that was deleted for good: who deleted it (their account name) and when. History keeps the pointer. */
export const ReceiptDeleted = Schema.NullOr(Schema.Struct({ by: Schema.String, at: DateTime }))

/** The current app's expense row: list_activity's live `expense`, and the base of the feed row and of get_expense. */
const expenseRowFields = {
  id: Id,
  groupId: Id,
  title: Schema.String,
  vendor: NullableString,
  amount: Money,
  currencyCode: Schema.String,
  createdAt: DateTime,
  expenseDate: DateTime,
  categoryId: Schema.Int,
  paidById: Id,
  originalAmount: Schema.NullOr(Money),
  originalCurrency: NullableString,
  conversionRate: NullableString,
  isReimbursement: Schema.Boolean,
  splitMode: SplitModeName,
  notes: NullableString,
  recurrenceRule: Schema.NullOr(RecurrenceName),
  recurringExpenseLinkId: Schema.NullOr(Id),
  deletedAt: Schema.NullOr(DateTime),
  revision: Revision,
}
export const ExpenseRow = Schema.Struct(expenseRowFields)

/** The people parts of a list row: names beside IDs. */
const listParts = {
  paidBy: Person,
  payers: Schema.Array(Schema.Struct({ participant: Person, amount: Money })),
  paidFor: Schema.Array(Schema.Struct({ participant: Person, shares: Schema.String })),
  category: Category,
  _count: Schema.Struct({ documents: NonNegativeInt }),
}

/** A row of list_expenses. */
export const ExpenseSummary = Schema.Struct({
  id: Id,
  title: Schema.String,
  vendor: NullableString,
  amount: Money,
  currencyCode: Schema.String,
  createdAt: DateTime,
  expenseDate: DateTime,
  originalAmount: Schema.NullOr(Money),
  originalCurrency: NullableString,
  isReimbursement: Schema.Boolean,
  splitMode: SplitModeName,
  recurrenceRule: Schema.NullOr(RecurrenceName),
  attribution: optional(Attribution),
  ...listParts,
})

/** A row of list_all_expenses. */
export const FeedRow = Schema.Struct({
  ...expenseRowFields,
  group: Schema.NullOr(Schema.Struct({ id: Id, name: Schema.String, slug: NullableString })),
  contextExpenseId: NullableString,
  contextExpenseTitle: NullableString,
  participantId: NullableString,
  attribution: optional(Attribution),
  ...listParts,
})

/** get_expense's expense. */
export const ExpenseDetail = Schema.Struct({
  ...expenseRowFields,
  attribution: Attribution,
  paidBy: Schema.Struct({ id: Id, name: Schema.String, groupId: Id }),
  payers: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, amount: Money })),
  paidFor: Schema.Array(Schema.Struct({ expenseId: Id, participantId: Id, shares: Schema.String })),
  category: Category,
  documents: Schema.Array(
    Schema.Struct({
      id: Id,
      url: Schema.String,
      downloadUrl: optional(
        Schema.String.annotate({
          description:
            'Authenticated receipt URL. GET with X-API-Key set to the same API key; do not send the key to the storage URL. Absent when the receipt was deleted for good.',
        }),
      ),
      /** The receipt's ID for list_receipts and delete_receipts; null for a legacy pointer without one. */
      receiptId: optional(Schema.NullOr(Id)),
      deleted: optional(ReceiptDeleted),
      // Saved revisions keep only the receipt pointer, so historical reads have no size.
      width: optional(Schema.Int),
      height: optional(Schema.Int),
      expenseId: Schema.NullOr(Id),
    }),
  ),
  recurringExpenseLink: Schema.NullOr(
    Schema.Struct({ id: Id, groupId: Id, currentFrameExpenseId: Id, nextExpenseCreatedAt: Schema.NullOr(DateTime), nextExpenseDate: DateTime }),
  ),
})

/** The boundary of a historical read: complete=false names expenses without a saved state there. */
export const HistoryView = Schema.Struct({
  asOf: RecordedTime,
  atActivityId: NullableString,
  complete: Schema.Boolean,
  unavailableExpenseIds: Schema.Array(Id),
})

/**
 * One saved revision. `schemaVersion` is the stored format: 1 for revisions
 * from the current app, 2 for revisions v2 wrote.
 */
export const ExpenseSnapshot = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  kind: Schema.Literal('expense'),
  /** The group as the revision saved it. Every stored format saves it. */
  group: Schema.Struct({ id: Id, name: Schema.String, slug: NullableString, currency: Schema.String, currencyCode: NullableString }),
  expense: Schema.Struct({
    id: Id,
    groupId: Id,
    revision: NonNegativeInt,
    title: Schema.String,
    vendor: NullableString,
    amount: Money,
    currencyCode: Schema.String,
    expenseDate: DateTime,
    createdAt: DateTime,
    categoryId: Schema.Int,
    category: Category,
    originalAmount: NullableString,
    originalCurrency: NullableString,
    conversionRate: NullableString,
    paidBy: Person,
    payers: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, amount: Money })),
    paidFor: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, shares: Schema.String })),
    splitMode: SplitModeName,
    isReimbursement: Schema.Boolean,
    notes: NullableString,
    recurrenceRule: Schema.NullOr(RecurrenceName),
    documents: Schema.Array(Schema.Struct({ id: Id, url: Schema.String, deleted: optional(ReceiptDeleted) })),
  }),
})

const GroupSnapshot = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    id: Id,
    name: Schema.String,
    slug: NullableString,
    currency: Schema.String,
    currencyCode: NullableString,
    information: NullableString,
    participants: Schema.Array(Person),
  }),
})

export const Snapshot = Schema.NullOr(Schema.Union([ExpenseSnapshot, GroupSnapshot]))

/** The current group wire shape. `currency` is the currency's symbol; v2 stores only the code. */
export const GroupFields = {
  id: Id,
  name: Schema.String,
  slug: NullableString,
  information: NullableString,
  revision: NonNegativeInt,
  currency: Schema.String,
  currencyCode: NullableString,
  createdAt: DateTime,
}
export const GroupParticipant = Schema.Struct({ id: Id, name: Schema.String, groupId: Id })

// ---------- expenses ----------

/** What every expense shape reads, from a live row or a saved revision alike. A share is the split input as people read it. */
type Source = {
  readonly id: string
  readonly revision: number
  readonly kind: 'expense' | 'payment'
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly category: typeof Category.Type
  readonly expenseDate: string
  readonly createdAt: string
  readonly currency: CurrencyCode
  readonly amount: string
  readonly originalAmount: string | null
  readonly originalCurrency: string | null
  readonly conversionRate: string | null
  readonly splitMode: keyof typeof SPLIT_MODE_NAMES
  readonly recurrence: keyof typeof RECURRENCE_NAMES
  readonly payers: readonly { readonly participantId: string; readonly name: string; readonly amount: string }[]
  readonly shares: readonly { readonly participantId: string; readonly name: string; readonly shares: string }[]
  readonly documentCount: number
}

/**
 * A live expense. Names come from the read (`parts.names`) or from `names`;
 * an amount split stores minor units, which the current app shows as amounts.
 */
export function liveSource(e: ReadExpense, names?: ReadonlyMap<string, string>): Source {
  const nameOf = (part: { participantId: string; name?: string }) => part.name ?? names?.get(part.participantId) ?? ''
  return {
    ...e,
    payers: e.payers.map((p) => ({ participantId: p.participantId, name: nameOf(p), amount: p.amount })),
    shares: e.shares.map((s) => ({ participantId: s.participantId, name: nameOf(s), shares: weightText({ splitMode: e.splitMode, currency: e.currency, weight: s.weight }) })),
  }
}

/** A saved revision. Its shares are already the split input as people read it. */
export const savedSource = (e: SavedExpense): Source => ({
  ...e,
  category: e.category ? { id: e.categoryId, name: e.category.name, grouping: e.category.grouping } : null,
  shares: e.shares.map((s) => ({ participantId: s.participantId, name: s.name, shares: s.weight })),
})

/** The payer who paid the most, with the name, as the current app's paidBy. */
function payerOf(s: Source) {
  const id = mainPayer(s) ?? ''
  return { id, name: s.payers.find((p) => p.participantId === id)?.name ?? '' }
}

const names = (s: Source) => ({
  isReimbursement: s.kind === 'payment',
  splitMode: SPLIT_MODE_NAMES[s.splitMode],
  recurrenceRule: RECURRENCE_NAMES[s.recurrence],
  expenseDate: legacyDateTime(s.expenseDate),
})

/** The base row. A saved revision has no live link, and its revision may be the deletion's. */
export const expenseRow = (s: Source, data: { groupId: string; revision: number; linkId: string | null; deletedAt: string | null }): typeof ExpenseRow.Encoded => ({
  id: s.id,
  groupId: data.groupId,
  title: s.title,
  vendor: s.vendor,
  amount: s.amount,
  currencyCode: s.currency,
  createdAt: s.createdAt,
  categoryId: s.categoryId,
  paidById: payerOf(s).id,
  originalAmount: s.originalAmount,
  originalCurrency: s.originalCurrency,
  conversionRate: s.conversionRate,
  notes: s.notes === '' ? null : s.notes,
  recurringExpenseLinkId: data.linkId,
  deletedAt: data.deletedAt,
  revision: data.revision,
  ...names(s),
})

const listPartsOf = (s: Source) => ({
  paidBy: payerOf(s),
  payers: s.payers.map((p) => ({ participant: { id: p.participantId, name: p.name }, amount: p.amount })),
  paidFor: s.shares.map((p) => ({ participant: { id: p.participantId, name: p.name }, shares: p.shares })),
  category: s.category,
  _count: { documents: s.documentCount },
})

type ComputedAttribution = ReturnType<typeof attributionOf>

/** Who added and last edited an expense, from the events a read returned (`parts.attribution`); `viewer` gets their own last edit. */
export const attributionOfEvents = (events: readonly AttributionEvent[] | null, viewer: string) => attributionOf({ events: events ?? [], viewer })

/** The attribution in the wire form: a time without an event is left out, as in the current app. */
export function attribution(a: ComputedAttribution): typeof Attribution.Encoded {
  return {
    ...(a.createdAt === null ? {} : { createdAt: a.createdAt }),
    ...(a.updatedAt === null ? {} : { updatedAt: a.updatedAt }),
    ...(a.lastEditedByYouAt === null ? {} : { lastEditedByYouAt: a.lastEditedByYouAt }),
    createdBy: a.createdBy,
    updatedBy: a.updatedBy,
  }
}

/** A list_expenses row. Attribution is a current-state field, so a saved revision has none. */
export const expenseSummary = (s: Source, data: { attribution: ComputedAttribution | null }): typeof ExpenseSummary.Encoded => ({
  id: s.id,
  title: s.title,
  vendor: s.vendor,
  amount: s.amount,
  currencyCode: s.currency,
  createdAt: s.createdAt,
  originalAmount: s.originalAmount,
  originalCurrency: s.originalCurrency,
  ...names(s),
  ...(data.attribution ? { attribution: attribution(data.attribution) } : {}),
  ...listPartsOf(s),
})

/** A feed expense as src/server/feed.ts returns it. */
type FeedExpense = ReadExpense & {
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly group: { readonly id: string; readonly name: string; readonly slug: string | null } | null
  readonly contextExpenseId: string | null
  readonly contextExpenseTitle: string | null
  readonly participantId: string | null
  readonly attribution: ComputedAttribution
}

export function feedRow(e: FeedExpense): typeof FeedRow.Encoded {
  const s = liveSource(e, new Map(e.people.map((p) => [p.id, p.name])))
  return {
    ...expenseRow(s, { groupId: e.groupId, revision: e.revision, linkId: e.link?.id ?? null, deletedAt: null }),
    group: e.group,
    contextExpenseId: e.contextExpenseId,
    contextExpenseTitle: e.contextExpenseTitle,
    participantId: e.participantId,
    attribution: attribution(e.attribution),
    ...listPartsOf(s),
  }
}

type Document = Pick<DocumentState, 'id' | 'url'> & Partial<Pick<DocumentState, 'width' | 'height' | 'receiptId'>> & { readonly deleted?: DocumentState['deleted'] | undefined }

/**
 * get_expense's expense, live or saved. A live read has the receipt sizes,
 * IDs and the recurring link; a saved revision keeps only the pointers.
 */
export function expenseDetail(
  s: Source,
  data: {
    groupId: string
    revision: number
    baseUrl: string
    attribution: ComputedAttribution
    documents: readonly Document[]
    link: ReadExpense['link']
    deletedAt: string | null
  },
): typeof ExpenseDetail.Encoded {
  const { groupId } = data
  const payer = payerOf(s)
  return {
    ...expenseRow(s, { groupId, revision: data.revision, linkId: data.link?.id ?? null, deletedAt: data.deletedAt }),
    attribution: attribution(data.attribution),
    paidBy: { ...payer, groupId },
    payers: s.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: p.amount })),
    paidFor: s.shares.map((p) => ({ expenseId: s.id, participantId: p.participantId, shares: p.shares })),
    category: s.category,
    documents: data.documents.map((d) => ({
      id: d.id,
      url: d.url,
      ...(d.width === undefined ? {} : { width: d.width }),
      ...(d.height === undefined ? {} : { height: d.height }),
      expenseId: s.id,
      ...(d.receiptId === undefined ? {} : { receiptId: d.receiptId }),
      deleted: d.deleted ?? null,
      ...(d.deleted ? {} : { downloadUrl: downloadUrl({ baseUrl: data.baseUrl, groupId, url: d.url }) }),
    })),
    recurringExpenseLink: data.link && {
      id: data.link.id,
      groupId,
      currentFrameExpenseId: s.id,
      nextExpenseCreatedAt: data.link.nextExpenseCreatedAt,
      nextExpenseDate: legacyDateTime(data.link.nextExpenseDate),
    },
  }
}

// ---------- snapshots ----------

export function expenseSnapshot(data: { expense: SavedExpense; groupId: string }): typeof ExpenseSnapshot.Encoded {
  const e = data.expense
  const s = savedSource(e)
  return {
    schemaVersion: e.schemaVersion,
    kind: 'expense',
    group: e.group
      ? {
          id: e.group.id,
          name: e.group.name,
          slug: e.group.slug,
          currency: symbolOf(e.group.currency),
          currencyCode: isCurrencyCode(e.group.currency) ? e.group.currency : null,
        }
      : // Not seen in stored data; the expense's own group and currency then stand in.
        { id: data.groupId, name: '', slug: null, currency: symbolOf(e.currency), currencyCode: e.currency },
    expense: {
      id: e.id,
      groupId: data.groupId,
      revision: e.revision,
      title: e.title,
      vendor: e.vendor,
      amount: e.amount,
      currencyCode: e.currency,
      expenseDate: legacyDateTime(e.expenseDate),
      createdAt: e.createdAt,
      categoryId: e.categoryId,
      category: s.category,
      originalAmount: e.originalAmount,
      originalCurrency: e.originalCurrency,
      conversionRate: e.conversionRate,
      paidBy: payerOf(s),
      payers: s.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: p.amount })),
      paidFor: s.shares.map((p) => ({ participantId: p.participantId, name: p.name, shares: p.shares })),
      splitMode: SPLIT_MODE_NAMES[e.splitMode],
      isReimbursement: e.kind === 'payment',
      notes: e.notes === '' ? null : e.notes,
      recurrenceRule: RECURRENCE_NAMES[e.recurrence],
      documents: e.documents.map((d) => ({ id: d.id, url: d.url, ...(d.deleted === undefined ? {} : { deleted: d.deleted }) })),
    },
  }
}

export function snapshotOf(data: { state: SavedState | null; groupId: string }): typeof Snapshot.Encoded {
  const { state } = data
  if (state === null) return null
  if (state._tag === 'expense') return expenseSnapshot({ expense: state.expense, groupId: data.groupId })
  const g = state.group
  return {
    schemaVersion: g.schemaVersion,
    kind: 'group',
    group: {
      id: data.groupId,
      name: g.name,
      slug: g.slug,
      currency: symbolOf(g.currency),
      currencyCode: isCurrencyCode(g.currency) ? g.currency : null,
      information: g.information === '' ? null : g.information,
      participants: g.participants.map((p) => ({ id: p.id, name: p.name })),
    },
  }
}

// ---------- groups ----------

export const groupFields = (g: { id: string; name: string; slug: string | null; information: string; revision: number; defaultCurrency: string; createdAt: string }) => ({
  id: g.id,
  name: g.name,
  slug: g.slug,
  // The current app stores a missing description as null.
  information: g.information === '' ? null : g.information,
  revision: g.revision,
  currency: symbolOf(g.defaultCurrency),
  currencyCode: g.defaultCurrency,
  createdAt: g.createdAt,
})
