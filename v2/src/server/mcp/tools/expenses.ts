// Expense tools: list_expenses, get_expense, create_expense, update_expense and
// delete_expense, with the current app's inputs, outputs and errors
// (src/trpc/routers/groups/expenses/*). Writes go through the ledger service,
// which checks membership, validates, records history and checks revisions.
// Multiple payers are new: `payers` beside the current single `paidBy`.
import { Schema } from 'effect'
import { sql, type SQL } from 'drizzle-orm'
import { Conflict, Forbidden, NotFound } from '../../../shared/api'
import type { ExpenseDraft } from '../../../shared/expense-rules'
import type { SavedExpense } from '../../../shared/history'
import { formatMinor, minor } from '../../../shared/money'
import { preferredPayer, type SplitMode } from '../../../shared/split'
import type { Db } from '../../db'
import * as history from '../../history'
import { randomId } from '../../ids'
import * as ledger from '../../ledger'
import { attachUploads, prepareUploads, UploadError } from '../../receipt-uploads'
import { receiptDownloadPath } from '../../receipts'
import { activitySource, displayName, escapeLike, involves, iso, notBaseline } from '../../sql'
import { createUngroupedExpense } from '../../ungrouped'
import { PAYMENT_RULES, RECORDING_RULES } from '../instructions'
import { defineTool, ToolError } from '../registry'
import { categoryOf, ExpenseSnapshot, expenseSnapshot, savedPayer } from './saved'
import {
  CalendarDate,
  CurrencyCodeInput,
  DateTime,
  Decimal,
  HistoryFields,
  Id,
  minorOf,
  MODE_NAMES,
  MODES,
  money,
  Money,
  NonNegativeInt,
  NullableString,
  origin,
  RecordedTime,
  RecurrenceInput,
  type Rule,
  RULE_NAMES,
  RULES,
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
  title: Schema.String.check(Schema.isBetweenLength(2, 200)).annotate({
    description: 'A short title for the purchase, such as "Dinner at Nopa". Keep it short; put the calculation in notes.',
  }),
  vendor: Schema.NullOr(Schema.String).annotate({
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
    .check(Schema.isBetweenLength(1, 100))
    .annotate({
      description:
        'Instead of paidBy, when several people paid: each payer’s participant ID and exact amount. The amounts add up to amount.',
    }),
  paidFor: Schema.Array(Schema.Struct({ participant: Participant, shares: Decimal }))
    .check(Schema.isBetweenLength(1, 100))
    .annotate({
      description:
        'Everyone who shares the cost, with their share. Include the payer with their share, unless the payer paid only for other people. shares: "1" each for EVENLY, relative weights for BY_SHARES, percentages summing to "100" for BY_PERCENTAGE, exact amounts summing to amount for BY_AMOUNT.',
    }),
  splitMode: SplitModeInput,
  isReimbursement: Schema.Boolean,
  documents: DOCUMENTS,
  notes: Schema.String.check(Schema.isMaxLength(5000)).annotate({
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
    contentType: Schema.Literals(['image/jpeg', 'image/png']),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_242_880 })),
  }),
).check(Schema.isMaxLength(10))

const People = Schema.Array(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('account'), id: Schema.String.check(Schema.isBetweenLength(1, 42)), userId: Schema.String.check(Schema.isBetweenLength(1, 128)) }),
    Schema.Struct({
      kind: Schema.Literal('email'),
      id: Schema.String.check(Schema.isBetweenLength(1, 42)),
      name: Schema.String.check(Schema.isBetweenLength(1, 50)),
      email: Schema.String.annotate({ format: 'email' }),
    }),
  ]),
).check(Schema.isBetweenLength(2, 100))

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
      downloadUrl: Schema.String.annotate({
        description: 'Authenticated receipt URL. GET with X-API-Key set to the same API key; do not send the key to the storage URL.',
      }),
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

type Event = { type: 'create_expense' | 'update_expense'; time: string; userId: string | null; actorName: string | null; source: string; currentName: string | null }
type Attribution = typeof Attribution.Type

/**
 * The create and update events of one expense for attribution, oldest first,
 * without baselines. `through` keeps the events up to one recorded event; the
 * names are then the ones recorded at the time, not the accounts' current
 * names, as in the current app (P-FEED-40).
 */
const attributionEvents = (data: { groupId: SQL; expenseId: SQL; through?: SQL }) => sql`
  coalesce((SELECT json_agg(json_build_object('type', a.type, 'time', ${iso(sql`a.time`)}, 'userId', a.actor_user_id, 'actorName', a.actor_name, 'source', ${activitySource(sql`a`)},
      'currentName', ${data.through === undefined ? sql`(SELECT u.name FROM "user" u WHERE u.id = a.actor_user_id AND u.email_verified)` : sql`NULL`}) ORDER BY a.sequence)
    FROM activities a WHERE a.expense_id = ${data.expenseId} AND a.group_id = ${data.groupId} AND a.type IN ('create_expense', 'update_expense') AND ${notBaseline(sql`a`)}
      ${data.through === undefined ? sql`` : sql`AND a.sequence <= (SELECT b.sequence FROM activities b WHERE b.id = ${data.through})`}), '[]')`

/** The current app's expenseAttributions: authors from the audit log, never from the payer. */
function attribution(events: readonly Event[], viewerUserId: string): Attribution {
  const row: { -readonly [K in keyof Attribution]: Attribution[K] } = { createdBy: null, updatedBy: null }
  for (const event of events) {
    const { source } = event
    const actor =
      event.userId || source === 'system'
        ? { userId: event.userId, name: event.currentName ?? event.actorName ?? (source === 'system' ? 'Automatic recurrence' : 'Member'), source }
        : null
    if (event.type === 'create_expense') {
      row.createdBy ??= actor
      row.createdAt ??= event.time
    } else {
      row.updatedBy = actor
      row.updatedAt = event.time
      if (event.userId === viewerUserId) row.lastEditedByYouAt = event.time
    }
  }
  return row
}

type Row = {
  id: string
  group_id: string
  revision: number
  kind: 'expense' | 'payment'
  title: string
  vendor: string | null
  notes: string
  category_id: number
  category: { id: number; name: string; grouping: string } | null
  expense_date: string
  currency: string
  amount: string
  original_amount: string | null
  original_currency: string | null
  conversion_rate: string | null
  split_mode: SplitMode
  recurrence: Rule
  created_at: string
  deleted_at: string | null
  payers: { id: string; name: string; amount: string }[]
  shares: { id: string; name: string; weight: string }[]
  events: Event[]
  document_count: number
  documents: { id: string; url: string; width: number; height: number }[] | null
  link: { id: string; groupId: string; currentFrameExpenseId: string; nextExpenseCreatedAt: string | null; nextExpenseDate: string } | null
}

/** The display name of the participant of payer or share row `part`. */
const partName = (part: SQL) =>
  displayName({ group: sql`${part}.group_id`, participant: sql`${part}.participant_id`, name: sql`(SELECT np.name FROM participants np WHERE np.id = ${part}.participant_id)` })

/** One statement: expenses with their people, names, category, audit events and documents. */
const expenseSelect = (data: { detail: boolean }) => sql`
  SELECT e.id, e.group_id, e.revision, e.kind, e.title, e.vendor, e.notes, e.category_id,
    (SELECT json_build_object('id', c.id, 'name', c.name, 'grouping', c.grouping) FROM categories c WHERE c.id = e.category_id) AS category,
    e.expense_date::text AS expense_date, e.currency, e.amount::text AS amount,
    e.original_amount::text AS original_amount, e.original_currency, e.conversion_rate, e.split_mode, e.recurrence,
    ${iso(sql`e.created_at`)} AS created_at, ${iso(sql`e.deleted_at`)} AS deleted_at,
    coalesce((SELECT json_agg(json_build_object('id', p.participant_id, 'name', ${partName(sql`p`)}, 'amount', p.amount::text) ORDER BY p.participant_id)
      FROM expense_payers p WHERE p.expense_id = e.id), '[]') AS payers,
    coalesce((SELECT json_agg(json_build_object('id', s.participant_id, 'name', ${partName(sql`s`)}, 'weight', s.weight) ORDER BY s.participant_id)
      FROM expense_shares s WHERE s.expense_id = e.id), '[]') AS shares,
    ${attributionEvents({ groupId: sql`e.group_id`, expenseId: sql`e.id` })} AS events,
    (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id) AS document_count,
    ${
      data.detail
        ? sql`coalesce((SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height) ORDER BY d.position)
            FROM expense_documents d WHERE d.expense_id = e.id), '[]') AS documents,
          (SELECT json_build_object('id', l.id, 'groupId', l.group_id, 'currentFrameExpenseId', l.current_frame_expense_id,
              'nextExpenseCreatedAt', ${iso(sql`l.next_expense_created_at`)}, 'nextExpenseDate', l.next_expense_date::text || 'T00:00:00.000Z')
            FROM recurring_links l WHERE l.current_frame_expense_id = e.id) AS link`
        : sql`NULL AS documents, NULL AS link`
    }
  FROM expenses e`

/** A share's split input as the current app writes it: exact amounts in BY_AMOUNT, weights otherwise. */
const shareText = (row: Row, weight: string) => (row.split_mode === 'amount' ? money(weight, row.currency) : weight)

function mainPayer(row: Row) {
  const id = row.payers.length ? preferredPayer(row.payers.map((p) => ({ participantId: p.id, amount: minor(BigInt(p.amount)) }))) : ''
  return row.payers.find((p) => p.id === id) ?? { id, name: '' }
}

const common = (row: Row) => ({
  id: row.id,
  title: row.title,
  vendor: row.vendor,
  amount: money(row.amount, row.currency),
  currencyCode: row.currency,
  createdAt: row.created_at,
  expenseDate: `${row.expense_date}T00:00:00.000Z`,
  originalAmount: row.original_amount === null || row.original_currency === null ? null : money(row.original_amount, row.original_currency),
  originalCurrency: row.original_currency,
  isReimbursement: row.kind === 'payment',
  splitMode: MODE_NAMES[row.split_mode],
  recurrenceRule: RULE_NAMES[row.recurrence],
  category: row.category,
})

const summary = (row: Row, viewer: string): typeof ExpenseSummary.Encoded => {
  const payer = mainPayer(row)
  return {
    ...common(row),
    attribution: attribution(row.events, viewer),
    paidBy: { id: payer.id, name: payer.name },
    payers: row.payers.map((p) => ({ participant: { id: p.id, name: p.name }, amount: money(p.amount, row.currency) })),
    paidFor: row.shares.map((s) => ({ participant: { id: s.id, name: s.name }, shares: shareText(row, s.weight) })),
    _count: { documents: row.document_count },
  }
}

const detail = (row: Row, data: { viewer: string; baseUrl: string }): typeof ExpenseDetail.Encoded => {
  const payer = mainPayer(row)
  return {
    ...common(row),
    groupId: row.group_id,
    categoryId: row.category_id,
    paidById: payer.id,
    conversionRate: row.conversion_rate,
    notes: row.notes === '' ? null : row.notes,
    recurringExpenseLinkId: row.link?.id ?? null,
    deletedAt: row.deleted_at,
    revision: row.revision,
    attribution: attribution(row.events, data.viewer),
    paidBy: { id: payer.id, name: payer.name, groupId: row.group_id },
    payers: row.payers.map((p) => ({ participantId: p.id, name: p.name, amount: money(p.amount, row.currency) })),
    paidFor: row.shares.map((s) => ({ expenseId: row.id, participantId: s.id, shares: shareText(row, s.weight) })),
    documents: (row.documents ?? []).map((d) => ({
      ...d,
      expenseId: row.id,
      downloadUrl: `${origin(data.baseUrl)}${receiptDownloadPath({ groupId: row.group_id, url: d.url })}`,
    })),
    recurringExpenseLink: row.link,
  }
}

const memberOf = (data: { userId: string; groupId: string }) =>
  sql`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${data.userId} AND m.group_id = ${data.groupId} AND m.active)`

async function requireAccess(db: Db, data: { userId: string; groupId: string }) {
  const result = await db.execute<{ ok: boolean }>(sql`SELECT ${memberOf(data)} AS ok`)
  if (!result.rows[0]?.ok) throw new Forbidden({ message: 'Group access denied' })
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
  splitMode: MODE_NAMES[e.splitMode],
  recurrenceRule: RULE_NAMES[e.recurrence],
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
  const result = await db.execute<{ events: Event[] }>(
    sql`SELECT ${attributionEvents({ groupId: sql`${data.groupId}`, expenseId: sql`${data.expenseId}`, through: sql`${data.activityId}` })} AS events`,
  )
  return attribution(result.rows[0]?.events ?? [], data.viewer)
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
    limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    filter: optional(Schema.String.check(Schema.isMaxLength(200))),
    vendor: optional(Schema.String.check(Schema.isBetweenLength(1, 100)).annotate({ description: 'Exact merchant name, case-insensitive.' })),
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
          ...(input.recurrenceRule === undefined ? {} : { recurrence: RULES[input.recurrenceRule] }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
        },
      })
      return { history: saved.history, expenses: saved.expenses.map(savedSummary), hasMore: saved.hasMore, nextCursor: saved.nextCursor }
    }
    const where = [sql`e.group_id = ${input.groupId}`, memberOf({ userId: principal.userId, groupId: input.groupId }), sql`e.deleted_at IS NULL`]
    if (input.filter) where.push(sql`(e.title ILIKE ${escapeLike(input.filter)} OR e.vendor ILIKE ${escapeLike(input.filter)})`)
    // Trimmed, as the current app's z.string().trim() did.
    const vendor = input.vendor?.trim()
    if (vendor) where.push(sql`lower(e.vendor) = lower(${vendor})`)
    if (input.currencyCode) where.push(sql`e.currency = ${input.currencyCode}`)
    if (input.categoryId !== undefined) where.push(sql`e.category_id = ${input.categoryId}`)
    if (input.isReimbursement !== undefined) where.push(sql`e.kind = ${input.isReimbursement ? 'payment' : 'expense'}`)
    if (input.recurrenceRule) where.push(sql`e.recurrence = ${RULES[input.recurrenceRule]}`)
    if (input.from) where.push(sql`e.expense_date >= ${input.from}::date`)
    if (input.to) where.push(sql`e.expense_date <= ${input.to}::date`)
    if (input.paidById) where.push(sql`EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${input.paidById})`)
    if (input.participantId) where.push(involves(sql`${input.participantId}`))
    const result = await db.execute<Row>(sql`${expenseSelect({ detail: false })}
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      LIMIT ${limit + 1} OFFSET ${cursor}`)
    // No rows: an empty page, or not a member. Only then is the separate check needed.
    if (result.rows.length === 0) await requireAccess(db, { userId: principal.userId, groupId: input.groupId })
    return {
      expenses: result.rows.slice(0, limit).map((row) => summary(row, principal.userId)),
      hasMore: result.rows.length > limit,
      nextCursor: cursor + limit,
    }
  },
})

type GetInput = { groupId: string; expenseId: string; revision?: number; asOf?: string; atActivityId?: string }

/** One saved revision in the get_expense shape, with its authors as of that revision. */
async function savedDetail(db: Db, data: { principal: ledger.Principal; baseUrl: string; input: GetInput }) {
  const { input } = data
  const saved = await history.getSavedExpense(db, {
    principal: data.principal,
    group: input.groupId,
    expenseId: input.expenseId,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
    ...(input.atActivityId === undefined ? {} : { atActivityId: input.atActivityId }),
  })
  const e = saved.expense
  const payer = savedPayer(e)
  const expense: typeof ExpenseDetail.Encoded = {
    ...historicalCommon(e),
    groupId: input.groupId,
    categoryId: e.categoryId,
    paidById: payer.id,
    conversionRate: e.conversionRate,
    notes: e.notes === '' ? null : e.notes,
    recurringExpenseLinkId: null,
    deletedAt: saved.deletedAt,
    revision: saved.history.revision,
    attribution: await attributionThrough(db, { groupId: input.groupId, expenseId: input.expenseId, activityId: saved.history.activityId, viewer: data.principal.userId }),
    paidBy: { ...payer, groupId: input.groupId },
    payers: e.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: p.amount })),
    paidFor: e.shares.map((s) => ({ expenseId: e.id, participantId: s.participantId, shares: s.weight })),
    documents: e.documents.map((d) => ({
      id: d.id,
      url: d.url,
      expenseId: e.id,
      downloadUrl: `${origin(data.baseUrl)}${receiptDownloadPath({ groupId: input.groupId, url: d.url })}`,
    })),
    recurringExpenseLink: null,
  }
  return { history: { ...saved.history, snapshot: expenseSnapshot({ expense: e, groupId: input.groupId }) }, expense }
}

export const getExpense = defineTool({
  name: 'get_expense',
  kind: 'read',
  description:
    'Read an expense, current revision, payer, attribution.createdBy and updatedBy (authenticated authors, separate from payer), splits and attached receipt pointers and downloadUrl values. Fetch downloadUrl with X-API-Key set to your API key; storage pointers are private and are kept unchanged in edits. Requires groupId and expenseId. Money and share values are exact decimal strings; receipts are permanent references. paidBy is the payer who paid the most; payers lists every payer. Optional revision, asOf timestamp, or atActivityId selects historical state (choose one). history includes the authoritative saved snapshot, recordedAt and deleted marker. A deletion revision retains the prior snapshot; expense.revision identifies the deletion event. Historical recurrence scheduling links are unavailable; use the saved recurrenceRule. Historical revisions are not current write versions.',
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
    await requireAccess(db, { userId: principal.userId, groupId: input.groupId })
    const result = await db.execute<Row>(sql`${expenseSelect({ detail: true })}
      WHERE e.id = ${input.expenseId} AND e.group_id = ${input.groupId} AND e.deleted_at IS NULL`)
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
    splitMode: MODES[input.splitMode ?? 'EVENLY'],
    shares: input.paidFor.map((p) => ({ participantId: p.participant, weight: p.shares })),
    recurrence: RULES[input.recurrenceRule ?? 'NONE'],
  }
}

/** The saved expense with the changes applied, as one full draft that is validated again. */
function mergedDraft(current: ledger.ApiExpense, changes: Changes): ExpenseDraft {
  const currency = changes.currencyCode ?? current.currency
  const amount = changes.amount ?? current.amount
  const moneyChanged = changes.amount !== undefined || changes.currencyCode !== undefined
  let payers: ExpenseDraft['payers']
  if (changes.paidBy !== undefined || changes.payers !== undefined) payers = payersOf({ paidBy: changes.paidBy, payers: changes.payers, amount })
  else if (current.payers.length === 1 && current.payers[0]) payers = [{ participantId: current.payers[0].participantId, amount }]
  else if (!moneyChanged) payers = current.payers
  else throw new ToolError('BAD_REQUEST', 'This expense has several payers. Send payers with each payer’s new amount.')
  const splitMode = changes.splitMode ? MODES[changes.splitMode] : current.splitMode
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
    recurrence: changes.recurrenceRule ? RULES[changes.recurrenceRule] : current.recurrence,
  }
}

/** Upload failures keep the current app's codes. */
const uploadFailure = (error: unknown) => (error instanceof UploadError ? new ToolError(error.code, error.message) : error)

export const createExpense = defineTool({
  name: 'create_expense',
  kind: 'write',
  destructive: false,
  description: `Create a group or ungrouped expense with expense. ${RECORDING_RULES} groupId is optional: when present, use the existing participant IDs from get_group and omit people. When omitted, supply people including yourself: each has a unique local id label (1-42 characters, e.g. me or friend) plus kind=account/userId from get_expense_options, or kind=email/name/email for a new invitee. expense.paidBy and paidFor.participant then refer to these local labels. Labels may be reused across expenses; the result maps them to stored participantId values for later operations. Ungrouped creation returns groupId as a private accounting context and invitation links; it sends no messages, requires isReimbursement=false and recurrenceRule=NONE, and receipts are added after saving. Optional vendor is the merchant; title describes the purchase without repeating vendor. Money is a decimal string at face value in currencyCode. One payer: paidBy. Several payers: payers with each exact amount, adding up to amount. Split modes: EVENLY, BY_SHARES (relative weights), BY_PERCENTAGE (sum 100), BY_AMOUNT (sum amount). ${PAYMENT_RULES} Recurrence uses NONE/DAILY/WEEKLY/MONTHLY. Optional uploads file metadata (JPEG or PNG, at most 5 MiB, at most 10 files, when get_reference_data attachments.enabled) returns PUT targets; you may ignore them. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (300 seconds); a used or expired url is refused. Then attach the uploadIds within 24 hours with update_expense, the current revision and attachUploadIds. No receipt is saved merely by requesting a target or uploading. Supply a stable 21-character expenseId and read it before retrying an uncertain create.`,
  input: Schema.Struct({
    groupId: optional(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description: 'Named group ID, or a private context ID when recording its repayment. Omit for a new ungrouped expense and supply people.',
      }),
    ),
    people: optional(People),
    expense: ExpenseCreateInput,
    uploads: optional(Uploads),
    expenseId: optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}$/))),
  }),
  strict: ['', 'expense', 'uploads[]'],
  output: Schema.Struct({
    groupId: Id,
    ...ExpenseWrite,
    participants: optional(Schema.Array(Schema.Struct({ localId: Id, participantId: Id, name: Schema.String }))),
    invitations: optional(Schema.Array(Schema.Struct({ email: Schema.String, url: Schema.String, expiresAt: DateTime }))),
  }),
  run: async ({ db, principal, baseUrl, documentsEnabled }, input) => {
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
    const targets = await prepareUploads(db, { principal, groupId: saved.groupId, expenseId: saved.id, requests: input.uploads, baseUrl, enabled: documentsEnabled })
    return { groupId: saved.groupId, expenseId: saved.id, revision: saved.revision, amount: saved.amount, currencyCode: saved.currency, ...targets }
  },
})

export const updateExpense = defineTool({
  name: 'update_expense',
  kind: 'write',
  description: `Partially edit an expense using changes and its current expectedRevision from get_expense. Omitted fields stay unchanged. ${RECORDING_RULES} Set vendor to null or empty string to clear it. To change who paid, send paidBy (one payer) or payers (several, each with an amount); an expense with several payers needs payers again when its amount changes. Use documents to retain/remove existing receipt references. Optional uploads returns PUT targets for this expense. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (300 seconds); a used or expired url is refused. attachUploadIds then adds those uploaded images to this expense in one audited revision; only your own uploads for this expense can be attached, each once. Empty changes can request targets without changing the expense. Edits are audited; a stale revision fails rather than overwriting another edit.`,
  input: Schema.Struct({
    expenseId: Schema.String.check(Schema.isMinLength(1)),
    groupId: Schema.String.check(Schema.isMinLength(1)),
    changes: optional(ExpenseChanges.annotate({ default: {} })),
    expectedRevision: NonNegativeInt,
    uploads: optional(Uploads),
    attachUploadIds: optional(Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}$/))).check(Schema.isMaxLength(10))),
  }),
  strict: ['', 'changes', 'uploads[]'],
  output: Schema.Struct(ExpenseWrite),
  run: async ({ db, principal, baseUrl, bucket, documentsEnabled }, input) => {
    const changes = input.changes ?? {}
    // One read for the tool and the ledger write. Each call is new, so it sends no idempotency key.
    const context = await ledger.loadWriteContext(db, { principal, group: input.groupId, expenseId: input.expenseId, op: 'change', idempotencyKey: null })
    // A stale revision conflicts before any upload is checked, so a failed call changes nothing.
    const stored = ledger.currentExpense(context, input.expectedRevision)
    const current = stored.value
    const attached = await attachUploads(db, {
      principal,
      groupId: current.groupId,
      expenseId: current.id,
      uploadIds: input.attachUploadIds ?? [],
      bucket,
      enabled: documentsEnabled,
    }).catch((error: unknown) => {
      throw uploadFailure(error)
    })
    let saved = current
    // No change, no revision, as in the current app.
    if (Object.keys(changes).length > 0 || attached.length > 0) {
      // documents replaces the saved list; attached receipts join it, or the saved list when documents is omitted.
      const documents = attached.length ? [...(changes.documents ?? stored.documents), ...attached] : changes.documents
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
    const targets = await prepareUploads(db, { principal, groupId: current.groupId, expenseId: current.id, requests: input.uploads, baseUrl, enabled: documentsEnabled })
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
