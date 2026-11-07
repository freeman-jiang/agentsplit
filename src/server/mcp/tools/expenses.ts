// Expense tools: list_expenses, get_expense, create_expense, update_expense and
// delete_expense, with the current app's inputs, outputs and errors
// (src/trpc/routers/groups/expenses/*). Writes go through the ledger service,
// which checks membership, validates, records history and checks revisions.
// Multiple payers are new: `payers` beside the current single `paidBy`.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { Conflict, NotFound } from '../../../shared/api'
import type { ExpenseDraft } from '../../../shared/expense-rules'
import type { SavedExpense } from '../../../shared/history'
import { GROUP_ID } from '../../../shared/ids'
import { LIMITS, mebibytes } from '../../../shared/limits'
import { formatMinor, minor, minorOf } from '../../../shared/minor'
import { preferredPayer } from '../../../shared/split'
import { RECURRENCE_BY_NAME, RECURRENCE_NAMES, SPLIT_MODE_BY_NAME, SPLIT_MODE_NAMES, RECEIPT_CONTENT_TYPES } from '../../../shared/vocabulary'
import { memberCte, requireMember, type Principal } from '../../access'
import { attributionEvents, attributionOf, type AttributionEvent } from '../../activity'
import type { Db } from '../../db'
import { expenseColumns, involves, toExpense, type ExpenseRow, type ReadExpense } from '../../expense-read'
import * as history from '../../history'
import { randomId } from '../../ids'
import * as ledger from '../../ledger'
import { attachUploads, prepareUploads, UploadError } from '../../receipt-uploads'
import { receiptDownloadPath } from '../../receipts'
import { escapeLike } from '../../sql'
import { createUngroupedExpense } from '../../ungrouped'
import { PAYMENT_RULES, RECORDING_RULES } from '../instructions'
import { defineTool, ToolError } from '../registry'
import { categoryOf, ExpenseSnapshot, expenseSnapshot, ReceiptDeleted, savedPayer } from './saved'
import {
  CalendarDate,
  CurrencyCodeInput,
  DateTime,
  Decimal,
  HistoryFields,
  Id,
  money,
  Money,
  NonNegativeInt,
  NullableString,
  origin,
  RecordedTime,
  RecurrenceInput,
  ShortId,
  SplitModeInput,
} from './shared'

const Participant = Schema.String.check(Schema.isMaxLength(64))

// ---------- inputs ----------

const DOCUMENTS = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isMaxLength(64)),
    url: Schema.String.check(Schema.isMaxLength(2000)).annotate({ format: 'uri' }),
    width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
).check(Schema.isMaxLength(100))

/** Every expense field, each optional; create requires some of them. */
const expenseFields = {
  currencyCode: CurrencyCodeInput,
  expenseDate: CalendarDate.annotate({ description: 'Calendar date in YYYY-MM-DD format' }),
  title: Schema.String.check(Schema.isBetweenLength(LIMITS.titleMin, LIMITS.titleMax)).annotate({
    description: 'A short title for the purchase, such as "Dinner at Nopa". Keep it short; put the calculation in notes.',
  }),
  vendor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(LIMITS.vendorMax))).annotate({
    description:
      'Optional merchant name, e.g. Costco. Keep the purchase description in title without repeating vendor. Set null or empty string to clear.',
  }),
  category: NonNegativeInt,
  amount: Decimal.annotate({
    description:
      'The full amount paid, as an exact decimal string in currencyCode, including the payer’s own share. A negative amount records income. Never record only what other people owe.',
  }),
  paidBy: Schema.String.annotate({ description: 'The participant ID of the one person who paid the whole amount. Use payers instead when several people paid.' }),
  payers: Schema.Array(Schema.Struct({ participant: Participant, amount: Decimal }))
    .check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup))
    .annotate({
      description:
        'Instead of paidBy, when several people paid: each payer’s participant ID and exact amount. The amounts add up to amount.',
    }),
  paidFor: Schema.Array(Schema.Struct({ participant: Participant, shares: Decimal }))
    .check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup))
    .annotate({
      description:
        'Everyone who shares the cost, with their share. Include the payer with their share, unless the payer paid only for other people. shares: "1" each for EVENLY, relative weights for BY_SHARES, percentages summing to "100" for BY_PERCENTAGE, exact amounts summing to amount for BY_AMOUNT.',
    }),
  splitMode: SplitModeInput,
  isReimbursement: Schema.Boolean,
  documents: DOCUMENTS,
  notes: Schema.String.check(Schema.isMaxLength(LIMITS.notesMax)).annotate({
    description:
      'The full calculation, so that a person can recalculate every number: each item, tax, tip, discount, and how each person’s share was found.',
  }),
  recurrenceRule: RecurrenceInput,
}
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const ExpenseCreateInput = Schema.Struct({
  currencyCode: expenseFields.currencyCode,
  expenseDate: expenseFields.expenseDate,
  title: expenseFields.title,
  vendor: optional(expenseFields.vendor),
  category: optional(expenseFields.category.annotate({ default: 0 })),
  amount: expenseFields.amount,
  paidBy: optional(expenseFields.paidBy),
  payers: optional(expenseFields.payers),
  paidFor: expenseFields.paidFor,
  splitMode: optional(expenseFields.splitMode.annotate({ default: 'EVENLY' })),
  isReimbursement: expenseFields.isReimbursement,
  documents: optional(expenseFields.documents.annotate({ default: [] })),
  notes: optional(expenseFields.notes),
  recurrenceRule: optional(expenseFields.recurrenceRule.annotate({ default: 'NONE' })),
}).annotate({ description: `The expense. ${RECORDING_RULES}` })

const ExpenseChanges = Schema.Struct(
  Object.fromEntries(Object.entries(expenseFields).map(([key, schema]) => [key, optional(schema)])) as {
    [K in keyof typeof expenseFields]: Schema.optionalKey<(typeof expenseFields)[K]>
  },
).annotate({ description: `Only the fields to change. ${RECORDING_RULES}` })

const Uploads = Schema.Array(
  Schema.Struct({
    filename: Schema.String.check(Schema.isBetweenLength(1, 255)),
    contentType: Schema.Literals(RECEIPT_CONTENT_TYPES),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.receiptBytes })),
  }),
).check(Schema.isMaxLength(LIMITS.receiptsPerRequest))

const People = Schema.Array(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('account'), id: Schema.String.check(Schema.isBetweenLength(1, 42)), userId: Schema.String.check(Schema.isBetweenLength(1, 128)) }),
    Schema.Struct({
      kind: Schema.Literal('email'),
      id: Schema.String.check(Schema.isBetweenLength(1, 42)),
      name: Schema.String.check(Schema.isBetweenLength(1, LIMITS.nameMax)),
      email: Schema.String.annotate({ format: 'email' }),
    }),
  ]),
).check(Schema.isBetweenLength(2, LIMITS.participantsPerGroup))

// ---------- outputs ----------

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
const Revision = NonNegativeInt

const ExpenseSummary = Schema.Struct({
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
  splitMode: SplitModeInput,
  recurrenceRule: Schema.NullOr(RecurrenceInput),
  attribution: optional(Attribution),
  paidBy: Person,
  payers: Schema.Array(Schema.Struct({ participant: Person, amount: Money })),
  paidFor: Schema.Array(Schema.Struct({ participant: Person, shares: Schema.String })),
  category: Category,
  _count: Schema.Struct({ documents: NonNegativeInt }),
})

const ExpenseDetail = Schema.Struct({
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
  splitMode: SplitModeInput,
  notes: NullableString,
  recurrenceRule: Schema.NullOr(RecurrenceInput),
  recurringExpenseLinkId: Schema.NullOr(Id),
  deletedAt: Schema.NullOr(DateTime),
  revision: Revision,
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

/** The boundary of a historical list: complete=false names expenses without a saved state there. */
const LedgerHistory = Schema.Struct({
  asOf: RecordedTime,
  atActivityId: NullableString,
  complete: Schema.Boolean,
  unavailableExpenseIds: Schema.Array(Id),
})

const RevisionHistory = Schema.Struct({
  activityId: Id,
  recordedAt: DateTime,
  revision: Schema.Int,
  deleted: Schema.Boolean,
  snapshot: ExpenseSnapshot,
})

const UploadTarget = Schema.Struct({
  uploadId: Id,
  filename: Schema.String,
  method: Schema.Literal('PUT'),
  url: Schema.String,
  headers: Schema.Struct({ 'Content-Type': Schema.String, 'Content-Length': Schema.String }),
  expiresAt: DateTime,
})
const ExpenseWrite = {
  expenseId: Id,
  revision: Revision,
  amount: Money,
  currencyCode: Schema.String,
  uploads: Schema.Array(UploadTarget),
  uploadError: NullableString,
}

// ---------- reading ----------

type Attribution = typeof Attribution.Type

/** The attribution in this tool's wire form: a time without an event is left out, as in the current app. */
function attribution(data: { events: readonly AttributionEvent[]; viewer: string }): Attribution {
  const { createdAt, updatedAt, lastEditedByYouAt, createdBy, updatedBy } = attributionOf(data)
  return {
    ...(createdAt === null ? {} : { createdAt }),
    ...(updatedAt === null ? {} : { updatedAt }),
    ...(lastEditedByYouAt === null ? {} : { lastEditedByYouAt }),
    createdBy,
    updatedBy,
  }
}

type Row = ExpenseRow & { events: AttributionEvent[] }

/** One statement: expenses with their people's names, attribution events and, for a detail, receipts. */
const expenseSelect = (data: { detail: boolean }) => sql`
  SELECT ${expenseColumns({ names: true, documents: data.detail })},
    ${attributionEvents({ groupId: sql`e.group_id`, expenseId: sql`e.id` })} AS events
  FROM expenses e`

/** A share's split input as the current app writes it: exact amounts in BY_AMOUNT, weights otherwise. */
const shareText = (e: ReadExpense, weight: string) => (e.splitMode === 'amount' ? money(weight, e.currency) : weight)

function mainPayer(e: ReadExpense) {
  const id = e.payers.length ? preferredPayer(e.payers.map((p) => ({ participantId: p.participantId, amount: minorOf(p.amount, e.currency) }))) : ''
  const payer = e.payers.find((p) => p.participantId === id)
  return { id, name: payer?.name ?? '' }
}

const common = (e: ReadExpense) => ({
  id: e.id,
  title: e.title,
  vendor: e.vendor,
  amount: e.amount,
  currencyCode: e.currency,
  createdAt: e.createdAt,
  expenseDate: `${e.expenseDate}T00:00:00.000Z`,
  originalAmount: e.originalAmount,
  originalCurrency: e.originalCurrency,
  isReimbursement: e.kind === 'payment',
  splitMode: SPLIT_MODE_NAMES[e.splitMode],
  recurrenceRule: RECURRENCE_NAMES[e.recurrence],
  category: e.category,
})

const summary = (row: Row, viewer: string): typeof ExpenseSummary.Encoded => {
  const e = toExpense(row)
  return {
    ...common(e),
    attribution: attribution({ events: row.events, viewer }),
    paidBy: mainPayer(e),
    payers: e.payers.map((p) => ({ participant: { id: p.participantId, name: p.name ?? '' }, amount: p.amount })),
    paidFor: e.shares.map((s) => ({ participant: { id: s.participantId, name: s.name ?? '' }, shares: shareText(e, s.weight) })),
    _count: { documents: e.documentCount },
  }
}

const detail = (row: Row, data: { viewer: string; baseUrl: string }): typeof ExpenseDetail.Encoded => {
  const e = toExpense(row)
  const payer = mainPayer(e)
  return {
    ...common(e),
    groupId: e.groupId,
    categoryId: e.categoryId,
    paidById: payer.id,
    conversionRate: e.conversionRate,
    notes: e.notes === '' ? null : e.notes,
    recurringExpenseLinkId: e.link?.id ?? null,
    deletedAt: null,
    revision: e.revision,
    attribution: attribution({ events: row.events, viewer: data.viewer }),
    paidBy: { ...payer, groupId: e.groupId },
    payers: e.payers.map((p) => ({ participantId: p.participantId, name: p.name ?? '', amount: p.amount })),
    paidFor: e.shares.map((s) => ({ expenseId: e.id, participantId: s.participantId, shares: shareText(e, s.weight) })),
    documents: (e.documents ?? []).map((d) => ({
      id: d.id,
      url: d.url,
      width: d.width,
      height: d.height,
      expenseId: e.id,
      receiptId: d.receiptId,
      deleted: d.deleted,
      ...(d.deleted ? {} : { downloadUrl: `${origin(data.baseUrl)}${receiptDownloadPath({ groupId: e.groupId, url: d.url })}` }),
    })),
    recurringExpenseLink: e.link && {
      id: e.link.id,
      groupId: e.groupId,
      currentFrameExpenseId: e.id,
      nextExpenseCreatedAt: e.link.nextExpenseCreatedAt,
      nextExpenseDate: `${e.link.nextExpenseDate}T00:00:00.000Z`,
    },
  }
}

// ---------- historical reads: saved revisions, never the live rows ----------

const historicalCommon = (e: SavedExpense) => ({
  id: e.id,
  title: e.title,
  vendor: e.vendor,
  amount: e.amount,
  currencyCode: e.currency,
  createdAt: e.createdAt,
  expenseDate: `${e.expenseDate}T00:00:00.000Z`,
  originalAmount: e.originalAmount,
  originalCurrency: e.originalCurrency,
  isReimbursement: e.kind === 'payment',
  splitMode: SPLIT_MODE_NAMES[e.splitMode],
  recurrenceRule: RECURRENCE_NAMES[e.recurrence],
  category: categoryOf(e),
})

/** A saved revision as a list row. Attribution is a current-state field, so it is left out. */
const savedSummary = (e: SavedExpense): typeof ExpenseSummary.Encoded => ({
  ...historicalCommon(e),
  paidBy: savedPayer(e),
  payers: e.payers.map((p) => ({ participant: { id: p.participantId, name: p.name }, amount: p.amount })),
  paidFor: e.shares.map((s) => ({ participant: { id: s.participantId, name: s.name }, shares: s.weight })),
  _count: { documents: e.documentCount },
})

/** Authors of an expense up to and including one recorded event, from the audit log. */
async function attributionThrough(db: Db, data: { groupId: string; expenseId: string; activityId: string; viewer: string }) {
  const result = await db.execute<{ events: AttributionEvent[] }>(
    sql`SELECT ${attributionEvents({ groupId: sql`${data.groupId}`, expenseId: sql`${data.expenseId}`, through: sql`${data.activityId}` })} AS events`,
  )
  return attribution({ events: result.rows[0]?.events ?? [], viewer: data.viewer })
}

export const listExpenses = defineTool({
  name: 'list_expenses',
  kind: 'read',
  description:
    'Review all expenses with pagination and optional inclusive from/to calendar dates, currencyCode, title/vendor text filter, exact case-insensitive vendor, categoryId, paidById, participantId, isReimbursement, or recurrenceRule. Include reimbursements by default. Follow nextCursor with the same filters. Current rows include attribution.createdBy and updatedBy from the immutable audit log, independently of paidBy. Null means the original actor is not known. Amounts are exact face-value decimal strings. paidBy is the payer who paid the most; payers lists every payer when several people paid. Optional asOf (timestamp) or atActivityId reconstructs saved historical state before applying filters. Reuse history.atActivityId for stable pages; history.complete=false identifies missing legacy snapshots. This read does not process recurrence.',
  input: Schema.Struct({
    ...HistoryFields,
    groupId: ShortId,
    cursor: optional(NonNegativeInt),
    limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.pageMax }))),
    filter: optional(Schema.String.check(Schema.isMaxLength(LIMITS.searchMax))),
    vendor: optional(Schema.String.check(Schema.isBetweenLength(1, LIMITS.vendorMax)).annotate({ description: 'Exact merchant name, case-insensitive.' })),
    currencyCode: optional(CurrencyCodeInput),
    categoryId: optional(NonNegativeInt),
    paidById: optional(ShortId),
    participantId: optional(ShortId),
    isReimbursement: optional(Schema.Boolean),
    recurrenceRule: optional(RecurrenceInput),
    from: optional(CalendarDate.annotate({ description: 'Inclusive expense date, YYYY-MM-DD' })),
    to: optional(CalendarDate.annotate({ description: 'Inclusive expense date, YYYY-MM-DD' })),
  }).check(Schema.makeFilter((i) => !i.from || !i.to || i.from <= i.to || 'from must be on or before to')),
  strict: [''],
  output: Schema.Struct({ history: optional(LedgerHistory), expenses: Schema.Array(ExpenseSummary), hasMore: Schema.Boolean, nextCursor: NonNegativeInt }),
  run: async ({ db, principal }, input) => {
    const cursor = input.cursor ?? 0
    const limit = input.limit ?? 10
    if (input.asOf !== undefined || input.atActivityId !== undefined) {
      const saved = await history.listSavedExpenses(db, {
        principal,
        group: input.groupId,
        ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
        ...(input.atActivityId === undefined ? {} : { atActivityId: input.atActivityId }),
        cursor,
        limit,
        filter: {
          ...(input.filter === undefined ? {} : { search: input.filter }),
          ...(input.vendor?.trim() ? { vendor: input.vendor.trim() } : {}),
          ...(input.currencyCode === undefined ? {} : { currency: input.currencyCode }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.paidById === undefined ? {} : { payerId: input.paidById }),
          ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
          ...(input.isReimbursement === undefined ? {} : { kind: input.isReimbursement ? ('payment' as const) : ('expense' as const) }),
          ...(input.recurrenceRule === undefined ? {} : { recurrence: RECURRENCE_BY_NAME[input.recurrenceRule] }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
        },
      })
      return { history: saved.history, expenses: saved.expenses.map(savedSummary), hasMore: saved.hasMore, nextCursor: saved.nextCursor }
    }
    const member = { principal, group: input.groupId }
    const where = [sql`e.group_id = (SELECT id FROM g WHERE active)`, sql`e.deleted_at IS NULL`]
    if (input.filter) where.push(sql`(e.title ILIKE ${escapeLike(input.filter)} OR e.vendor ILIKE ${escapeLike(input.filter)})`)
    // Trimmed, as the current app's z.string().trim() did.
    const vendor = input.vendor?.trim()
    if (vendor) where.push(sql`lower(e.vendor) = lower(${vendor})`)
    if (input.currencyCode) where.push(sql`e.currency = ${input.currencyCode}`)
    if (input.categoryId !== undefined) where.push(sql`e.category_id = ${input.categoryId}`)
    if (input.isReimbursement !== undefined) where.push(sql`e.kind = ${input.isReimbursement ? 'payment' : 'expense'}`)
    if (input.recurrenceRule) where.push(sql`e.recurrence = ${RECURRENCE_BY_NAME[input.recurrenceRule]}`)
    if (input.from) where.push(sql`e.expense_date >= ${input.from}::date`)
    if (input.to) where.push(sql`e.expense_date <= ${input.to}::date`)
    if (input.paidById) where.push(sql`EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${input.paidById})`)
    if (input.participantId) where.push(involves(sql`${input.participantId}`))
    const result = await db.execute<Row>(sql`WITH ${memberCte(member)} ${expenseSelect({ detail: false })}
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      LIMIT ${limit + 1} OFFSET ${cursor}`)
    // No rows: an empty page, or not a member. Only then is the separate check needed.
    if (result.rows.length === 0) await requireMember(db, member)
    return {
      expenses: result.rows.slice(0, limit).map((row) => summary(row, principal.userId)),
      hasMore: result.rows.length > limit,
      nextCursor: cursor + limit,
    }
  },
})

type GetInput = { groupId: string; expenseId: string; revision?: number; asOf?: string; atActivityId?: string }

/** One saved revision in the get_expense shape, with its authors as of that revision. */
async function savedDetail(db: Db, data: { principal: Principal; baseUrl: string; input: GetInput }) {
  const { input } = data
  const saved = await history.getSavedExpense(db, {
    principal: data.principal,
    group: input.groupId,
    expenseId: input.expenseId,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
    ...(input.atActivityId === undefined ? {} : { atActivityId: input.atActivityId }),
  })
  const { groupId } = saved
  const e = saved.expense
  const payer = savedPayer(e)
  const expense: typeof ExpenseDetail.Encoded = {
    ...historicalCommon(e),
    groupId,
    categoryId: e.categoryId,
    paidById: payer.id,
    conversionRate: e.conversionRate,
    notes: e.notes === '' ? null : e.notes,
    recurringExpenseLinkId: null,
    deletedAt: saved.deletedAt,
    revision: saved.history.revision,
    attribution: await attributionThrough(db, { groupId, expenseId: input.expenseId, activityId: saved.history.activityId, viewer: data.principal.userId }),
    paidBy: { ...payer, groupId },
    payers: e.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: p.amount })),
    paidFor: e.shares.map((s) => ({ expenseId: e.id, participantId: s.participantId, shares: s.weight })),
    documents: e.documents.map((d) => ({
      id: d.id,
      url: d.url,
      expenseId: e.id,
      deleted: d.deleted ?? null,
      ...(d.deleted ? {} : { downloadUrl: `${origin(data.baseUrl)}${receiptDownloadPath({ groupId, url: d.url })}` }),
    })),
    recurringExpenseLink: null,
  }
  return { history: { ...saved.history, snapshot: expenseSnapshot({ expense: e, groupId }) }, expense }
}

export const getExpense = defineTool({
  name: 'get_expense',
  kind: 'read',
  description:
    'Read an expense, current revision, payer, attribution.createdBy and updatedBy (authenticated authors, separate from payer), splits and attached receipt pointers and downloadUrl values. Fetch downloadUrl with X-API-Key set to your API key; storage pointers are private and are kept unchanged in edits. Requires groupId and expenseId. Money and share values are exact decimal strings. A receipt deleted for good has deleted { by, at } and no downloadUrl; documents[].receiptId names a receipt for delete_receipts. paidBy is the payer who paid the most; payers lists every payer. Optional revision, asOf timestamp, or atActivityId selects historical state (choose one). history includes the authoritative saved snapshot, recordedAt and deleted marker. A deletion revision retains the prior snapshot; expense.revision identifies the deletion event. Historical recurrence scheduling links are unavailable; use the saved recurrenceRule. Historical revisions are not current write versions.',
  input: Schema.Struct({
    groupId: Schema.String.check(Schema.isMinLength(1)),
    expenseId: Schema.String.check(Schema.isMinLength(1)),
    ...HistoryFields,
    revision: optional(NonNegativeInt.annotate({ description: 'Exact saved expense revision; exclusive with asOf/atActivityId.' })),
  }),
  strict: [''],
  output: Schema.Struct({ history: optional(RevisionHistory), expense: ExpenseDetail }),
  run: async ({ db, principal, baseUrl }, input) => {
    if (input.revision !== undefined || input.asOf !== undefined || input.atActivityId !== undefined) return savedDetail(db, { principal, baseUrl, input })
    const { groupId } = await requireMember(db, { principal, group: input.groupId })
    const result = await db.execute<Row>(sql`${expenseSelect({ detail: true })}
      WHERE e.id = ${input.expenseId} AND e.group_id = ${groupId} AND e.deleted_at IS NULL`)
    const row = result.rows[0]
    if (!row) throw new NotFound({ entity: 'expense', id: input.expenseId })
    return { expense: detail(row, { viewer: principal.userId, baseUrl }) }
  },
})

// ---------- writing ----------

type ExpenseInput = typeof ExpenseCreateInput.Type
type Changes = typeof ExpenseChanges.Type

const DUPLICATE_ID = 'Expense ID already exists. Read it before retrying; use a new ID only for a distinct expense.'

function payersOf(data: { paidBy: string | undefined; payers: ExpenseInput['payers']; amount: string }): ExpenseDraft['payers'] {
  if (data.paidBy !== undefined && data.payers !== undefined)
    throw new ToolError('BAD_REQUEST', 'Use paidBy for one payer or payers for several people, not both.')
  if (data.payers) return data.payers.map((p) => ({ participantId: p.participant, amount: p.amount }))
  if (data.paidBy === undefined) throw new ToolError('BAD_REQUEST', 'Choose who paid: paidBy, or payers with each amount.')
  return [{ participantId: data.paidBy, amount: data.amount }]
}

function draftOf(input: ExpenseInput): ExpenseDraft {
  return {
    kind: input.isReimbursement ? 'payment' : 'expense',
    title: input.title,
    vendor: input.vendor ?? null,
    notes: input.notes ?? '',
    categoryId: input.category ?? 0,
    expenseDate: input.expenseDate,
    currency: input.currencyCode,
    amount: input.amount,
    payers: payersOf({ paidBy: input.paidBy, payers: input.payers, amount: input.amount }),
    splitMode: SPLIT_MODE_BY_NAME[input.splitMode ?? 'EVENLY'],
    shares: input.paidFor.map((p) => ({ participantId: p.participant, weight: p.shares })),
    recurrence: RECURRENCE_BY_NAME[input.recurrenceRule ?? 'NONE'],
  }
}

/** The saved expense with the changes applied, as one full draft that is validated again. */
function mergedDraft(current: ReadExpense, changes: Changes): ExpenseDraft {
  const currency = changes.currencyCode ?? current.currency
  const amount = changes.amount ?? current.amount
  const moneyChanged = changes.amount !== undefined || changes.currencyCode !== undefined
  let payers: ExpenseDraft['payers']
  if (changes.paidBy !== undefined || changes.payers !== undefined) payers = payersOf({ paidBy: changes.paidBy, payers: changes.payers, amount })
  else if (current.payers.length === 1 && current.payers[0]) payers = [{ participantId: current.payers[0].participantId, amount }]
  else if (!moneyChanged) payers = current.payers
  else throw new ToolError('BAD_REQUEST', 'This expense has several payers. Send payers with each payer’s new amount.')
  const splitMode = changes.splitMode ? SPLIT_MODE_BY_NAME[changes.splitMode] : current.splitMode
  return {
    kind: changes.isReimbursement === undefined ? current.kind : changes.isReimbursement ? 'payment' : 'expense',
    title: changes.title ?? current.title,
    vendor: changes.vendor === undefined ? current.vendor : changes.vendor,
    notes: changes.notes ?? current.notes,
    categoryId: changes.category ?? current.categoryId,
    expenseDate: changes.expenseDate ?? current.expenseDate,
    currency,
    amount,
    payers,
    splitMode,
    shares: changes.paidFor
      ? changes.paidFor.map((p) => ({ participantId: p.participant, weight: p.shares }))
      : // Stored amount weights are minor units of the saved currency; send them as decimal text.
        current.shares.map((s) => ({
          participantId: s.participantId,
          weight: current.splitMode === 'amount' ? formatMinor({ amount: minor(BigInt(s.weight)), currency: current.currency }) : s.weight,
        })),
    recurrence: changes.recurrenceRule ? RECURRENCE_BY_NAME[changes.recurrenceRule] : current.recurrence,
  }
}

/** Upload failures keep the current app's codes. */
const uploadFailure = (error: unknown) => (error instanceof UploadError ? new ToolError(error.code, error.message) : error)

export const createExpense = defineTool({
  name: 'create_expense',
  kind: 'write',
  destructive: false,
  description: `Create a group or ungrouped expense with expense. ${RECORDING_RULES} groupId is optional: when present, use the existing participant IDs from get_group and omit people. When omitted, supply people including yourself: each has a unique local id label (1-42 characters, e.g. me or friend) plus kind=account/userId from get_expense_options, or kind=email/name/email for a new invitee. expense.paidBy and paidFor.participant then refer to these local labels. Labels may be reused across expenses; the result maps them to stored participantId values for later operations. Ungrouped creation returns groupId as a private accounting context and invitation links; it sends no messages, requires isReimbursement=false and recurrenceRule=NONE, and receipts are added after saving. Optional vendor is the merchant; title describes the purchase without repeating vendor. Money is a decimal string at face value in currencyCode. One payer: paidBy. Several payers: payers with each exact amount, adding up to amount. Split modes: EVENLY, BY_SHARES (relative weights), BY_PERCENTAGE (sum 100), BY_AMOUNT (sum amount). ${PAYMENT_RULES} Recurrence uses NONE/DAILY/WEEKLY/MONTHLY. Optional uploads file metadata (JPEG or PNG, at most ${mebibytes(LIMITS.receiptBytes)}, at most ${LIMITS.receiptsPerRequest} files) returns PUT targets; you may ignore them. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (${LIMITS.uploadTargetSeconds} seconds); a used or expired url is refused. Then attach the uploadIds within ${LIMITS.uploadAttachHours} hours with update_expense, the current revision and attachUploadIds. No receipt is saved merely by requesting a target or uploading. Supply a stable 21-character expenseId and read it before retrying an uncertain create.`,
  input: Schema.Struct({
    groupId: optional(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description: 'Named group ID, or a private context ID when recording its repayment. Omit for a new ungrouped expense and supply people.',
      }),
    ),
    people: optional(People),
    expense: ExpenseCreateInput,
    uploads: optional(Uploads),
    expenseId: optional(Schema.String.check(Schema.isPattern(GROUP_ID))),
  }),
  strict: ['', 'expense', 'uploads[]'],
  output: Schema.Struct({
    groupId: Id,
    ...ExpenseWrite,
    participants: optional(Schema.Array(Schema.Struct({ localId: Id, participantId: Id, name: Schema.String }))),
    invitations: optional(Schema.Array(Schema.Struct({ email: Schema.String, url: Schema.String, expiresAt: DateTime }))),
  }),
  run: async ({ db, principal, baseUrl }, input) => {
    if (input.groupId === undefined && !input.people) throw new ToolError('BAD_REQUEST', 'Supply groupId for a group expense, or people for an ungrouped expense.')
    if (input.groupId !== undefined && input.people) throw new ToolError('BAD_REQUEST', 'With groupId, use its existing participant IDs and omit people.')
    const expenseId = input.expenseId ?? randomId()
    const draft = draftOf(input.expense)
    // The stable create ID is the idempotency guard: a reused ID is a Conflict, never a second expense.
    // So the tool sends no idempotency key, and the write skips the key's lookup and row.
    const duplicate = (error: unknown) => (error instanceof Conflict && error.id === expenseId ? new ToolError('CONFLICT', DUPLICATE_ID) : error)
    const idempotencyKey = null
    if (input.groupId === undefined) {
      if (input.uploads?.length) throw new ToolError('BAD_REQUEST', 'Save an ungrouped expense first, then attach its receipts.')
      if (input.expense.documents?.length)
        throw new ToolError('BAD_REQUEST', 'Create the expense first, then attach receipts or record a repayment. Ungrouped expenses do not recur.')
      const created = await createUngroupedExpense(db, { principal, baseUrl, expenseId, idempotencyKey, people: input.people ?? [], expense: draft }).catch((error: unknown) => {
        throw duplicate(error)
      })
      return {
        groupId: created.groupId,
        expenseId: created.expenseId,
        revision: created.revision,
        // The ledger accepted the amount, so it has the currency's precision.
        amount: formatMinor({ amount: minorOf(draft.amount, draft.currency), currency: draft.currency }),
        currencyCode: draft.currency,
        participants: created.participants,
        invitations: created.invitations,
        uploads: [],
        uploadError: null,
      }
    }
    const saved = await ledger
      .createExpense(db, { principal, group: input.groupId, expenseId, idempotencyKey, expense: draft, documents: input.expense.documents ?? [] })
      .catch((error: unknown) => {
        throw duplicate(error)
      })
    const targets = await prepareUploads(db, { principal, groupId: saved.groupId, expenseId: saved.id, requests: input.uploads, baseUrl })
    return { groupId: saved.groupId, expenseId: saved.id, revision: saved.revision, amount: saved.amount, currencyCode: saved.currency, ...targets }
  },
})

export const updateExpense = defineTool({
  name: 'update_expense',
  kind: 'write',
  description: `Partially edit an expense using changes and its current expectedRevision from get_expense. Omitted fields stay unchanged. ${RECORDING_RULES} Set vendor to null or empty string to clear it. To change who paid, send paidBy (one payer) or payers (several, each with an amount); an expense with several payers needs payers again when its amount changes. Use documents to retain/remove existing receipt references. Optional uploads returns PUT targets for this expense. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (${LIMITS.uploadTargetSeconds} seconds); a used or expired url is refused. attachUploadIds then adds those uploaded images to this expense in one audited revision; only your own uploads for this expense can be attached, each once. Empty changes can request targets without changing the expense. Edits are audited; a stale revision fails rather than overwriting another edit.`,
  input: Schema.Struct({
    expenseId: Schema.String.check(Schema.isMinLength(1)),
    groupId: Schema.String.check(Schema.isMinLength(1)),
    changes: optional(ExpenseChanges.annotate({ default: {} })),
    expectedRevision: NonNegativeInt,
    uploads: optional(Uploads),
    attachUploadIds: optional(Schema.Array(Schema.String.check(Schema.isPattern(GROUP_ID))).check(Schema.isMaxLength(LIMITS.receiptsPerRequest))),
  }),
  strict: ['', 'changes', 'uploads[]'],
  output: Schema.Struct(ExpenseWrite),
  run: async ({ db, principal, baseUrl, bucket }, input) => {
    const changes = input.changes ?? {}
    // One read for the tool and the ledger write. Each call is new, so it sends no idempotency key.
    const context = await ledger.loadWriteContext(db, { principal, group: input.groupId, expenseId: input.expenseId, op: 'change', idempotencyKey: null })
    // A stale revision conflicts before any upload is checked, so a failed call changes nothing.
    const current = ledger.currentExpense(context, input.expectedRevision)
    const attached = await attachUploads(db, {
      principal,
      groupId: current.groupId,
      expenseId: current.id,
      uploadIds: input.attachUploadIds ?? [],
      bucket,
    }).catch((error: unknown) => {
      throw uploadFailure(error)
    })
    let saved = current
    // No change, no revision, as in the current app.
    if (Object.keys(changes).length > 0 || attached.length > 0) {
      // documents replaces the saved list; attached receipts join it, or the saved list when documents is omitted.
      const documents = attached.length ? [...(changes.documents ?? current.documents ?? []), ...attached] : changes.documents
      saved = await ledger.updateExpense(db, {
        principal,
        group: input.groupId,
        expenseId: input.expenseId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: null,
        expense: mergedDraft(current, changes),
        ...(documents ? { documents } : {}),
        context,
      })
    }
    const targets = await prepareUploads(db, { principal, groupId: current.groupId, expenseId: current.id, requests: input.uploads, baseUrl })
    return { expenseId: saved.id, revision: saved.revision, amount: saved.amount, currencyCode: saved.currency, ...targets }
  },
})

export const deleteExpense = defineTool({
  name: 'delete_expense',
  kind: 'write',
  description:
    'Soft-delete an expense or recorded payment using its current expectedRevision. Current balances exclude it; immutable revisions and permanent receipt references remain in list_activity.',
  input: Schema.Struct({
    expenseId: Schema.String.check(Schema.isMinLength(1)),
    groupId: Schema.String.check(Schema.isMinLength(1)),
    expectedRevision: NonNegativeInt,
  }),
  strict: [''],
  output: Schema.Struct({ expenseId: Id, revision: Revision, deleted: Schema.Literal(true) }),
  run: async ({ db, principal }, input) => {
    const { revision } = await ledger.deleteExpense(db, {
      principal,
      group: input.groupId,
      expenseId: input.expenseId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: null,
    })
    return { expenseId: input.expenseId, revision, deleted: true as const }
  },
})

export const expenseTools = [listExpenses, getExpense, createExpense, updateExpense, deleteExpense]
