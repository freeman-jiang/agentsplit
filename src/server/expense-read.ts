// The expense read model: one projection of an expense row and one mapper, for
// the ledger, the feed, stats, export, recurring and the MCP tools. PostgreSQL
// builds each row's parts as JSON, so the server parses one value per row
// instead of several result sets. Minor units travel as text, never as JSON numbers.
import { sql, type SQL } from 'drizzle-orm'
import type { ExpenseFilter as Filter } from '../shared/api'
import type { CurrencyCode } from '../shared/currencies'
import type { SavedExpense } from '../shared/history'
import { formatMinor, minor } from '../shared/minor'
import type { ExpenseKind, Recurrence, SplitMode } from '../shared/vocabulary'
import { actorName, attributionEvents, type AttributionEvent } from './activity'
import type { Db } from './core/db'
import { randomId } from './core/ids'
import { displayName } from './people'
import { escapeLike, iso, isoMicro, textList } from './sql'

/** The expense row's own fields: what a write sets, an unchanged edit compares and a recurring occurrence copies. */
export const EXPENSE_FIELDS = ['kind', 'title', 'vendor', 'notes', 'categoryId', 'expenseDate', 'currency', 'amount', 'splitMode', 'recurrence'] as const
export type ExpenseField = (typeof EXPENSE_FIELDS)[number]

/** The column of a field: the snake_case of its name, as Drizzle's casing names it. */
export const fieldColumn = (field: string) => sql.identifier(field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))

/** A receipt pointer of an expense, in its saved order. */
export type StoredDocument = { id: string; url: string; width: number; height: number }

/** The expense_documents rows of `documents` for expense `expenseId`, in order. A row keeps its ID only when `keep` has it. */
export const documentRows = (data: { expenseId: string; documents: readonly StoredDocument[]; keep: ReadonlySet<string> }) =>
  data.documents.map((d, position) => ({ id: data.keep.has(d.id) ? d.id : randomId(), expenseId: data.expenseId, url: d.url, width: d.width, height: d.height, position }))

/** Who deleted a receipt and when, as readers show it in place of the image. */
export type Tombstone = { by: string; at: string }

/** A receipt as readers show it: its receipt ID (null for a legacy pointer without a receipt row) and its tombstone (null unless deleted). */
export type DocumentState = StoredDocument & { receiptId: string | null; deleted: Tombstone | null }

/**
 * The receipts of expense row `expense` as a JSON array of DocumentState, in
 * their saved order, or NULL when it has none.
 */
export const documentStatesJson = (expense: SQL) => sql`(SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height,
    'receiptId', r.id, 'deleted', CASE WHEN dr.receipt_id IS NULL THEN NULL ELSE json_build_object('by', du.name, 'at', ${iso(sql`dr.deleted_at`)}) END) ORDER BY d.position)
  FROM expense_documents d
  LEFT JOIN receipts r ON r.group_id = ${expense}.group_id AND r.url = d.url
  LEFT JOIN deleted_receipts dr ON dr.receipt_id = r.id
  LEFT JOIN "user" du ON du.id = dr.deleted_by
  WHERE d.expense_id = ${expense}.id)`

/**
 * The deleted receipts of group `group` as one JSON object, receipt URL →
 * Tombstone, or NULL when none is deleted. History snapshots name receipts by
 * URL, so readers look each one up here.
 */
export const tombstonesJson = (group: SQL) => sql`(SELECT json_object_agg(r.url, json_build_object('by', u.name, 'at', ${iso(sql`d.deleted_at`)}))
  FROM deleted_receipts d JOIN receipts r ON r.id = d.receipt_id JOIN "user" u ON u.id = d.deleted_by
  WHERE r.group_id = ${group})`

/** The exact keys of a row of an expense list, after its ID: the next page starts right after them. */
export type OrderKeys = { readonly a: string; readonly b: string; readonly id: string }
type ExpenseOrder = { readonly by: SQL; readonly keys: SQL; readonly after: (keys: OrderKeys) => SQL }

/**
 * The orders of expense lists on row `e`, newest first. `keys` selects
 * `key_a` and `key_b` with microseconds, so rows created in the same
 * millisecond are never skipped.
 */
export const EXPENSE_ORDERS: { readonly date: ExpenseOrder; readonly updated: ExpenseOrder } = {
  date: {
    by: sql`e.expense_date DESC, e.created_at DESC, e.id DESC`,
    keys: sql`e.expense_date::text AS key_a, ${isoMicro(sql`e.created_at`)} AS key_b`,
    after: (k) => sql`(e.expense_date, e.created_at, e.id) < (${k.a}::date, ${k.b}::timestamptz, ${k.id})`,
  },
  updated: {
    by: sql`e.updated_at DESC, e.id DESC`,
    keys: sql`${isoMicro(sql`e.updated_at`)} AS key_a, '' AS key_b`,
    after: (k) => sql`(e.updated_at, e.id) < (${k.a}::timestamptz, ${k.id})`,
  },
}
export type OrderedRow = { key_a: string; key_b: string }

/** Is expense `e` paid for or shared by participant `who`? */
export const involves = (who: SQL) => sql`(EXISTS (SELECT 1 FROM expense_payers ip WHERE ip.expense_id = e.id AND ip.participant_id = ${who})
  OR EXISTS (SELECT 1 FROM expense_shares iss WHERE iss.expense_id = e.id AND iss.participant_id = ${who}))`

/** The display name of the participant of payer or share row `part`. */
const partName = (part: SQL) =>
  displayName({ group: sql`${part}.group_id`, participant: sql`${part}.participant_id`, name: sql`(SELECT np.name FROM participants np WHERE np.id = ${part}.participant_id)` })

/** Which expenses a list keeps (the contract's ExpenseFilter); the live and the historical lists read it alike. */
export type ExpenseFilter = typeof Filter.Type

type FilterKey = Exclude<keyof ExpenseFilter, 'sort'>
type FilterRule<V> = {
  /** The condition on expense row `e`, or null when the value keeps every row. */
  readonly live: (value: V) => SQL | null
  /** The same condition on a saved revision. */
  readonly saved: (expense: SavedExpense, value: V) => boolean
}

const lower = (text: string) => text.trim().toLocaleLowerCase()

/**
 * Every filter, for the live list (SQL, ledger.ts) and the historical one
 * (saved revisions, history.ts). The type requires both forms of each key.
 */
const FILTERS: { readonly [K in FilterKey]-?: FilterRule<NonNullable<ExpenseFilter[K]>> } = {
  search: {
    live: (v) => {
      const term = escapeLike(v.trim())
      return v.trim() ? sql`(e.title ILIKE ${term} OR e.vendor ILIKE ${term} OR e.notes ILIKE ${term})` : null
    },
    saved: (e, v) => !lower(v) || [e.title, e.vendor ?? '', e.notes].some((t) => t.toLocaleLowerCase().includes(lower(v))),
  },
  vendor: {
    live: (v) => (v.trim() ? sql`lower(e.vendor) = lower(${v.trim()})` : null),
    saved: (e, v) => !lower(v) || e.vendor?.toLocaleLowerCase() === lower(v),
  },
  currency: { live: (v) => sql`e.currency = ${v}`, saved: (e, v) => e.currency === v },
  categoryId: { live: (v) => sql`e.category_id = ${v}`, saved: (e, v) => e.categoryId === v },
  kind: { live: (v) => sql`e.kind = ${v}`, saved: (e, v) => e.kind === v },
  recurrence: { live: (v) => sql`e.recurrence = ${v}`, saved: (e, v) => e.recurrence === v },
  from: { live: (v) => sql`e.expense_date >= ${v}::date`, saved: (e, v) => e.expenseDate >= v },
  to: { live: (v) => sql`e.expense_date <= ${v}::date`, saved: (e, v) => e.expenseDate <= v },
  payerId: {
    live: (v) => sql`EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${v})`,
    saved: (e, v) => e.payers.some((p) => p.participantId === v),
  },
  participantId: {
    live: (v) => involves(sql`${v}`),
    saved: (e, v) => e.payers.some((p) => p.participantId === v) || e.shares.some((s) => s.participantId === v),
  },
}

const FILTER_KEYS = Object.keys(FILTERS) as FilterKey[]

// TypeScript cannot relate FILTERS[key] to filter[key] for a union key; each entry's own type is checked above.
const rule = (key: FilterKey) => FILTERS[key] as FilterRule<NonNullable<ExpenseFilter[FilterKey]>>

/** The SQL conditions of a filter on expense row `e`. */
export const filterConditions = (filter: ExpenseFilter): SQL[] =>
  FILTER_KEYS.flatMap((key) => {
    const value = filter[key]
    return value === undefined ? [] : (rule(key).live(value) ?? [])
  })

/** Whether a saved revision passes a filter. */
export const passesFilter = (expense: SavedExpense, filter: ExpenseFilter) =>
  FILTER_KEYS.every((key) => {
    const value = filter[key]
    return value === undefined || rule(key).saved(expense, value)
  })

/** What a read adds to the columns of an expense: payer and sharer names, the receipts, and the create and update events. */
export type ExpenseParts = { readonly names?: boolean; readonly documents?: boolean; readonly attribution?: boolean }

/**
 * The columns of expense row `e`. `names` adds each payer's and sharer's
 * display name; `documents` adds the receipts with their states;
 * `attribution` adds the events that attributionOf (activity.ts) reads.
 */
export const expenseColumns = (parts: ExpenseParts = {}) => {
  const name = (part: SQL) => (parts.names ? sql`, 'name', ${partName(part)}` : sql``)
  const event = (where: SQL, by: SQL) =>
    sql`(SELECT json_build_object('at', ${iso(sql`a.time`)}, 'by', ${by}) FROM activities a WHERE a.expense_id = e.id AND ${where})`
  return sql`e.id, e.group_id, e.revision, e.kind, e.title, e.vendor, e.notes, e.category_id,
  (SELECT json_build_object('id', c.id, 'name', c.name, 'grouping', c.grouping) FROM categories c WHERE c.id = e.category_id) AS category,
  e.expense_date::text AS expense_date, e.currency, e.amount::text AS amount,
  e.original_amount::text AS original_amount, e.original_currency, e.conversion_rate, e.split_mode, e.recurrence,
  ${iso(sql`e.created_at`)} AS created_at, ${iso(sql`e.updated_at`)} AS updated_at, e.deleted_at IS NOT NULL AS deleted,
  coalesce((SELECT json_agg(json_build_object('participantId', p.participant_id, 'amount', p.amount::text${name(sql`p`)}) ORDER BY p.participant_id)
    FROM expense_payers p WHERE p.expense_id = e.id), '[]') AS payers,
  coalesce((SELECT json_agg(json_build_object('participantId', s.participant_id, 'amount', s.amount::text, 'weight', s.weight${name(sql`s`)}) ORDER BY s.participant_id)
    FROM expense_shares s WHERE s.expense_id = e.id), '[]') AS shares,
  (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id) AS document_count,
  ${event(sql`a.expense_revision = 1`, actorName)} AS added,
  ${event(sql`a.expense_revision = e.revision AND e.revision > 1 AND a.type = 'update_expense'`, sql`a.actor_name`)} AS edited,
  (SELECT json_build_object('id', l.id, 'nextExpenseDate', l.next_expense_date::text, 'nextExpenseCreatedAt', ${iso(sql`l.next_expense_created_at`)})
    FROM recurring_links l WHERE l.current_frame_expense_id = e.id) AS link,
  ${parts.documents ? sql`coalesce(${documentStatesJson(sql`e`)}, '[]')` : sql`NULL::json`} AS documents,
  ${parts.attribution ? attributionEvents({ groupId: sql`e.group_id`, expenseId: sql`e.id` }) : sql`NULL::json`} AS events`
}

type Part = { participantId: string; amount: string; name?: string }
type Event = { at: string; by: string | null }

export type ExpenseRow = {
  id: string
  group_id: string
  revision: number
  kind: ExpenseKind
  title: string
  vendor: string | null
  notes: string
  category_id: number
  category: { id: number; name: string; grouping: string } | null
  expense_date: string
  currency: CurrencyCode
  amount: string
  original_amount: string | null
  original_currency: CurrencyCode | null
  conversion_rate: string | null
  split_mode: SplitMode
  recurrence: Recurrence
  created_at: string
  updated_at: string
  deleted: boolean
  payers: Part[]
  shares: (Part & { weight: string })[]
  document_count: number
  added: Event | null
  edited: Event | null
  link: { id: string; nextExpenseDate: string; nextExpenseCreatedAt: string | null } | null
  documents: DocumentState[] | null
  events: AttributionEvent[] | null
}

/** An expense row as the services return it. Money is exact decimal text in the expense's currency. */
export function toExpense(e: ExpenseRow) {
  const { currency } = e
  const money = (amount: string, code: CurrencyCode = currency) => formatMinor({ amount: minor(BigInt(amount)), currency: code })
  const named = (p: Part) => (p.name === undefined ? {} : { name: p.name })
  return {
    id: e.id,
    groupId: e.group_id,
    revision: e.revision,
    kind: e.kind,
    title: e.title,
    vendor: e.vendor,
    notes: e.notes,
    categoryId: e.category_id,
    category: e.category,
    expenseDate: e.expense_date,
    currency,
    amount: money(e.amount),
    /** A conversion that the current app recorded, in its original currency; v2 never writes one. */
    originalAmount: e.original_amount === null || e.original_currency === null ? null : money(e.original_amount, e.original_currency),
    originalCurrency: e.original_currency,
    conversionRate: e.conversion_rate,
    splitMode: e.split_mode,
    payers: e.payers.map((p) => ({ participantId: p.participantId, amount: money(p.amount), ...named(p) })),
    shares: e.shares.map((s) => ({ participantId: s.participantId, amount: money(s.amount), weight: s.weight, ...named(s) })),
    recurrence: e.recurrence,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    deleted: e.deleted,
    documentCount: e.document_count,
    /** Revision 1's author as recorded, or the system. */
    addedAt: e.added?.at ?? null,
    addedBy: e.added?.by ?? null,
    /** The current revision's author as recorded, when it is an edit. */
    editedAt: e.edited?.at ?? null,
    editedBy: e.edited?.by ?? null,
    /** The recurring link this expense is the current occurrence of. */
    link: e.link,
    /** null when the read did not ask for them. */
    documents: e.documents,
    /** The create and update events for attributionOf; null when the read did not ask for them. */
    attributionEvents: e.events,
  }
}

export type ReadExpense = ReturnType<typeof toExpense>

/**
 * A live occurrence that still creates the next one: an expense (not a
 * payment) with a rule and an open link (P-RECUR-25).
 */
export const isActiveSeries = (e: ReadExpense) => e.kind === 'expense' && e.recurrence !== 'none' && openLink(e) !== null

/** The expense's link when it still creates the next occurrence, else null. */
export const openLink = (e: ReadExpense) => (e.link?.nextExpenseCreatedAt === null ? e.link : null)

/** The given expenses in the given order; missing IDs are left out. `groupId` keeps only that group's. */
export async function loadExpenses(db: Db, data: { ids: readonly string[]; groupId?: string; parts?: ExpenseParts }) {
  if (data.ids.length === 0) return []
  const result = await db.execute<ExpenseRow>(sql`
    SELECT ${expenseColumns(data.parts)}
    FROM expenses e WHERE e.id IN (${textList(data.ids)}) ${data.groupId === undefined ? sql`` : sql`AND e.group_id = ${data.groupId}`}`)
  const byId = new Map(result.rows.map((r) => [r.id, toExpense(r)]))
  return data.ids.flatMap((id) => byId.get(id) ?? [])
}
