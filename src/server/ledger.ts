// Ledger reads and writes. Every function checks group access itself, so the
// RPC handlers and the MCP tools cannot skip it. Writes take a transaction.
import { and, asc, eq, notInArray, sql, type SQL } from 'drizzle-orm'
import { expenseDocuments, expensePayers, expenses, expenseShares, groups, memberships } from '../../db/schema/app'
import { Conflict, Invalid, NotFound } from '../shared/api'
import type { CurrencyCode } from '../shared/currencies'
import { validateExpense, type ExpenseDraft, type ResolvedExpense } from '../shared/expense-rules'
import { compareIds } from '../shared/ids'
import { formatMinor, type Minor } from '../shared/minor'
import type { ExpenseKind, Role } from '../shared/vocabulary'
import { memberCte, requireActive, requireMember, type Membership, type Principal } from './access'
import { recordExpenseEvent, type SnapshotGroup } from './activity'
import type { Db } from './db'
import { expenseColumns, involves, loadExpenses, toExpense, type ExpenseRow, type ReadExpense, type StoredDocument } from './expense-read'
import { idempotent, storedRequestJson, type StoredRequest } from './idempotency'
import { randomId } from './ids'
import { displayNames } from './people'
import { assertPrivateWrite, privateContextOf, type PrivateContext } from './private-context'
import { stopRecurrence, syncRecurrence, type LinkState } from './recurring'
import { escapeLike, textList } from './sql'

// ---------- reads ----------

export async function listGroups(db: Db, principal: Principal) {
  return db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      defaultCurrency: groups.defaultCurrency,
      role: memberships.role,
      participantId: memberships.participantId,
    })
    .from(memberships)
    .innerJoin(groups, eq(groups.id, memberships.groupId))
    .where(and(eq(memberships.userId, principal.userId), eq(memberships.active, true), eq(groups.kind, 'named')))
    .orderBy(asc(groups.name), asc(groups.id))
    .then((rows) => rows.map((r) => ({ ...r, defaultCurrency: r.defaultCurrency as CurrencyCode })))
}

type GroupRow = {
  id: string
  context_expense_id: string | null
  slug: string | null
  name: string
  default_currency: string
  information: string
  revision: number
  role: Role
  participant_id: string | null
  active: boolean
  participants: { id: string; name: string }[]
}

/**
 * A group with its participants, in one statement that also checks the
 * caller's membership, so the request makes one round trip.
 */
export async function getGroup(db: Db, data: { principal: Principal; group: string }) {
  const result = await db.execute<GroupRow>(sql`
    WITH ${memberCte(data)}
    SELECT g.id, g.slug, g.name, g.default_currency, g.information, g.revision, g.role, g.participant_id, g.active,
      (SELECT pc.expense_id FROM private_contexts pc WHERE pc.group_id = g.id) AS context_expense_id,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id)
        FROM (${displayNames(sql`g.id`)}) p), '[]') AS participants
    FROM g
  `)
  const g = requireActive(result.rows[0])
  return {
    id: g.id,
    contextExpenseId: g.context_expense_id,
    slug: g.slug,
    name: g.name,
    defaultCurrency: g.default_currency as CurrencyCode,
    role: g.role,
    participantId: g.participant_id,
    information: g.information,
    revision: g.revision,
    participants: g.participants,
  }
}

export type ExpenseFilter = {
  readonly sort?: 'date' | 'updated'
  readonly search?: string
  readonly participantId?: string
  readonly payerId?: string
  readonly currency?: CurrencyCode
  readonly categoryId?: number
  readonly kind?: ExpenseKind
  readonly from?: string
  readonly to?: string
}

type Cursor = { readonly k: string; readonly c: string; readonly i: string }
const encodeCursor = (c: Cursor) => btoa(JSON.stringify(c))
const decodeCursor = (text: string): Cursor => {
  try {
    const value = JSON.parse(atob(text)) as Cursor
    if (typeof value.k === 'string' && typeof value.c === 'string' && typeof value.i === 'string') return value
  } catch {
    // fall through
  }
  throw new Invalid({ message: 'Invalid cursor', field: 'cursor' })
}

export async function listExpenses(
  db: Db,
  data: { principal: Principal; group: string; filter: ExpenseFilter; cursor: string | null; limit: number },
) {
  const f = data.filter
  const limit = Math.min(Math.max(Math.trunc(data.limit) || 50, 1), 200)
  // The membership check is part of the statement: rows come only from a group the caller belongs to.
  const member = sql`WITH ${memberCte(data)}`
  const where: SQL[] = [sql`e.group_id = (SELECT id FROM g WHERE active)`, sql`e.deleted_at IS NULL`]
  if (f.search?.trim()) {
    const term = escapeLike(f.search.trim())
    where.push(sql`(e.title ILIKE ${term} OR e.vendor ILIKE ${term} OR e.notes ILIKE ${term})`)
  }
  if (f.currency) where.push(sql`e.currency = ${f.currency}`)
  if (f.categoryId !== undefined) where.push(sql`e.category_id = ${f.categoryId}`)
  if (f.kind) where.push(sql`e.kind = ${f.kind}`)
  if (f.from) where.push(sql`e.expense_date >= ${f.from}::date`)
  if (f.to) where.push(sql`e.expense_date <= ${f.to}::date`)
  if (f.payerId) where.push(sql`EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${f.payerId})`)
  if (f.participantId) where.push(involves(sql`${f.participantId}`))
  const byUpdated = f.sort === 'updated'
  if (data.cursor) {
    const c = decodeCursor(data.cursor)
    where.push(
      byUpdated
        ? sql`(e.updated_at, e.id) < (${c.k}::timestamptz, ${c.i})`
        : sql`(e.expense_date, e.created_at, e.id) < (${c.k}::date, ${c.c}::timestamptz, ${c.i})`,
    )
  }
  // The exact PostgreSQL timestamps (microseconds) are the cursor keys.
  const result = await db.execute<ExpenseRow & { created_key: string; updated_key: string }>(sql`
    ${member}
    SELECT ${expenseColumns()}, e.created_at::text AS created_key, e.updated_at::text AS updated_key
    FROM expenses e
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${byUpdated ? sql`e.updated_at DESC, e.id DESC` : sql`e.expense_date DESC, e.created_at DESC, e.id DESC`}
    LIMIT ${limit + 1}
  `)
  const rows = result.rows
  // No rows: an empty page, or not a member. Only then is the separate check needed.
  if (rows.length === 0) await requireMember(db, data)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    expenses: page.map(toExpense),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(byUpdated ? { k: last.updated_key, c: '', i: last.id } : { k: last.expense_date, c: last.created_key, i: last.id })
        : null,
  }
}

export async function getExpense(db: Db, data: { principal: Principal; group: string; expenseId: string }) {
  const { groupId } = await requireMember(db, data)
  const [expense] = await loadExpenses(db, { ids: [data.expenseId], groupId })
  if (!expense || expense.deleted) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return expense
}

// ---------- writes ----------

function resolve(draft: ExpenseDraft, people: readonly { id: string }[]): ResolvedExpense {
  const result = validateExpense({ draft, participantIds: new Set(people.map((p) => p.id)) })
  if (!result.ok) {
    const [first] = result.issues
    throw new Invalid({ message: result.issues.map((i) => `${i.field}: ${i.message}`).join('; '), ...(first ? { field: first.field } : {}) })
  }
  return result.value
}

// ---------- write context ----------

/**
 * Everything an expense write reads before it changes anything, read in one
 * statement at the start of the transaction. An MCP tool loads it, uses it,
 * and gives it to the ledger write, so no row is read twice and the write
 * makes fewer round trips.
 */
export type WriteContext = {
  readonly op: 'create' | 'change'
  readonly expenseId: string
  readonly idempotencyKey: string | null
  readonly membership: Membership
  readonly group: SnapshotGroup
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly categories: ReadonlySet<number>
  readonly privateContext: PrivateContext | null
  readonly previous: StoredRequest | null
  /** create: the expense with this ID in any group. A create must not reuse it. */
  readonly existing: { readonly groupId: string; readonly revision: number } | null
  /** change: the expense in this group, locked for the write, with its receipts. */
  readonly expense: ReadExpense | null
  /** change: the expense's recurring link. */
  readonly link: LinkState | null
}

type ContextRow = {
  group_id: string
  slug: string | null
  name: string
  default_currency: string
  role: Role
  participant_id: string | null
  active: boolean
  people: { id: string; name: string }[]
  categories: number[]
  private_context: PrivateContext | null
  previous: StoredRequest | null
  existing: { groupId: string; revision: number } | null
  expense: ExpenseRow | null
  link: LinkState | null
}

/**
 * Reads the write context and checks membership, as requireMember does. For a
 * change (update or delete), the expense row is locked FOR UPDATE, as the
 * revision check did before. A caller without an idempotency key passes null.
 */
export async function loadWriteContext(
  tx: Db,
  data: { principal: Principal; group: string; expenseId: string; op: 'create' | 'change'; idempotencyKey: string | null },
): Promise<WriteContext> {
  const change = data.op === 'change'
  const none = sql`NULL::json`
  const result = await tx.execute<ContextRow>(sql`
    WITH ${memberCte(data)}${change ? sql`, locked AS (SELECT e.id FROM expenses e WHERE e.id = ${data.expenseId} AND e.group_id = (SELECT id FROM g) FOR UPDATE)` : sql``}
    SELECT g.id AS group_id, g.slug, g.name, g.default_currency, g.role, g.participant_id, g.active,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name)) FROM participants p WHERE p.group_id = g.id), '[]') AS people,
      coalesce((SELECT json_agg(c.id) FROM categories c), '[]') AS categories,
      ${privateContextOf(sql`g.id`)} AS private_context,
      ${data.idempotencyKey === null ? none : storedRequestJson({ principal: data.principal, key: data.idempotencyKey })} AS previous,
      ${change ? none : sql`(SELECT json_build_object('groupId', x.group_id, 'revision', x.revision) FROM expenses x WHERE x.id = ${data.expenseId})`} AS existing,
      ${
        change
          ? sql`(SELECT row_to_json(r) FROM (SELECT ${expenseColumns({ documents: true })} FROM expenses e WHERE e.id = (SELECT id FROM locked)) r)`
          : none
      } AS expense,
      ${
        change
          ? sql`(SELECT json_build_object('id', l.id, 'actedOn', l.next_expense_created_at IS NOT NULL) FROM recurring_links l
              WHERE l.current_frame_expense_id = (SELECT id FROM locked))`
          : none
      } AS link
    FROM g
  `)
  const row = requireActive(result.rows[0])
  return {
    op: data.op,
    expenseId: data.expenseId,
    idempotencyKey: data.idempotencyKey,
    membership: { groupId: row.group_id, role: row.role, participantId: row.participant_id },
    group: { id: row.group_id, name: row.name, slug: row.slug, defaultCurrency: row.default_currency },
    people: row.people,
    categories: new Set(row.categories),
    privateContext: row.private_context,
    previous: row.previous,
    existing: row.existing,
    expense: row.expense ? toExpense(row.expense) : null,
    link: row.link,
  }
}

/** The given context, or a new one. A context read for another write is a bug. */
async function contextFor(tx: Db, data: { principal: Principal; group: string; expenseId: string; op: 'create' | 'change'; idempotencyKey: string | null; context: WriteContext | undefined }) {
  const { context, ...load } = data
  if (!context) return loadWriteContext(tx, load)
  if (context.op !== data.op || context.expenseId !== data.expenseId || context.idempotencyKey !== data.idempotencyKey)
    throw new Error(`The write context of ${context.op} ${context.expenseId} does not match ${data.op} ${data.expenseId}`)
  return context
}

/** The expense as written, with its receipts, for the activity snapshot and the result. */
async function storedExpense(tx: Db, expenseId: string) {
  const [expense] = await loadExpenses(tx, { ids: [expenseId], documents: true })
  if (!expense) throw new NotFound({ entity: 'expense', id: expenseId })
  return expense
}

/** Records an expense event with the snapshot of the context's group and people. */
const record = (tx: Db, data: { context: WriteContext; principal: Principal; type: 'create_expense' | 'update_expense'; expense: ReadExpense; revision: number }) =>
  recordExpenseEvent(tx, {
    type: data.type,
    expense: data.expense,
    revision: data.revision,
    principal: data.principal,
    snapshot: { group: data.context.group, names: new Map(data.context.people.map((p) => [p.id, p.name])) },
  })

/**
 * Replaces an expense's receipts. Every URL must be a receipt uploaded to this
 * group, as in the current app, and not deleted for good; a document keeps its
 * ID only if it already belongs to this expense, so a client cannot collide
 * with another expense's row. `saved` is the expense's receipts before the write.
 */
async function writeDocuments(tx: Db, data: { groupId: string; expenseId: string; documents: readonly StoredDocument[]; saved: readonly StoredDocument[] }) {
  const urls = [...new Set(data.documents.map((d) => d.url))]
  if (urls.length) {
    const registered = await tx.execute<{ url: string; deleted: boolean }>(
      sql`SELECT url, EXISTS (SELECT 1 FROM deleted_receipts d WHERE d.receipt_id = receipts.id) AS deleted
        FROM receipts WHERE group_id = ${data.groupId} AND url IN (${textList(urls)})`,
    )
    if (registered.rows.length !== urls.length) throw new Invalid({ message: 'Attach only receipts uploaded to this group', field: 'documents' })
    if (registered.rows.some((r) => r.deleted)) throw new Invalid({ message: 'A receipt in this list was deleted. Remove it and save again.', field: 'documents' })
  }
  await replaceDocuments(tx, data)
}

/** Writes the expense's receipt rows in the given order. */
async function replaceDocuments(tx: Db, data: { expenseId: string; documents: readonly StoredDocument[]; saved: readonly StoredDocument[] }) {
  const own = new Set(data.saved.map((d) => d.id))
  if (data.saved.length) await tx.delete(expenseDocuments).where(eq(expenseDocuments.expenseId, data.expenseId))
  if (data.documents.length)
    await tx.insert(expenseDocuments).values(
      data.documents.map((d, position) => ({ id: own.has(d.id) ? d.id : randomId(), expenseId: data.expenseId, url: d.url, width: d.width, height: d.height, position })),
    )
}

function requireCategory(context: WriteContext, categoryId: number) {
  if (!context.categories.has(categoryId)) throw new Invalid({ message: 'categoryId: Unknown category', field: 'categoryId' })
}

/**
 * Writes the expense row (`row`, its INSERT or UPDATE) with its payers and
 * shares in one statement. Parts of people who left the expense are deleted;
 * the others are inserted, or updated in place when they changed. Each sub-statement changes
 * different rows, and deferred triggers check the sums at commit.
 */
async function writeExpense(tx: Db, data: { expenseId: string; groupId: string; expense: ResolvedExpense; row: SQL }) {
  const parts = (table: typeof expensePayers, rows: readonly { participantId: string; amount: Minor; weight: string }[]) => ({
    stale: tx
      .delete(table)
      .where(and(eq(table.expenseId, data.expenseId), notInArray(table.participantId, rows.map((r) => r.participantId))))
      .getSQL(),
    upsert: tx
      .insert(table)
      .values(rows.map((r) => ({ expenseId: data.expenseId, groupId: data.groupId, ...r })))
      .onConflictDoUpdate({
        target: [table.expenseId, table.participantId],
        set: { amount: sql`excluded.amount`, weight: sql`excluded.weight` },
        // An unchanged part is not written again.
        setWhere: sql`(excluded.amount, excluded.weight) IS DISTINCT FROM (${table.amount}, ${table.weight})`,
      })
      .getSQL(),
  })
  const payers = parts(expensePayers, data.expense.payers.map((p) => ({ participantId: p.participantId, amount: p.amount, weight: '1' })))
  const shares = parts(expenseShares, data.expense.shares.map((s) => ({ participantId: s.participantId, amount: s.amount, weight: s.weight })))
  await tx.execute(sql`WITH expense_row AS (${data.row}),
    stale_payers AS (${payers.stale}),
    stale_shares AS (${shares.stale}),
    new_payers AS (${payers.upsert})
    ${shares.upsert}`)
}

const columns = (e: ResolvedExpense) => ({
  kind: e.kind,
  title: e.title,
  vendor: e.vendor,
  notes: e.notes,
  categoryId: e.categoryId,
  expenseDate: e.expenseDate,
  currency: e.currency,
  amount: e.amount as Minor,
  splitMode: e.splitMode,
  recurrence: e.recurrence,
})

/** True when an update would store exactly what is saved. */
function unchanged(data: { before: ReadExpense; after: ResolvedExpense; documentsBefore: readonly StoredDocument[]; documentsAfter: readonly StoredDocument[] | undefined }) {
  const { before, after } = data
  const money = (amount: Minor) => formatMinor({ amount, currency: after.currency })
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const byId = <T extends { participantId: string }>(list: readonly T[]) => [...list].sort((a, b) => compareIds(a.participantId, b.participantId))
  const docs = (list: readonly StoredDocument[]) => list.map((d) => [d.url, d.width, d.height]).sort()
  return (
    same(
      [before.kind, before.title, before.vendor, before.notes, before.categoryId, before.expenseDate, before.currency, before.amount, before.splitMode, before.recurrence],
      [after.kind, after.title, after.vendor, after.notes, after.categoryId, after.expenseDate, after.currency, money(after.amount), after.splitMode, after.recurrence],
    ) &&
    same(
      byId(before.payers.map((p) => ({ participantId: p.participantId, amount: p.amount }))),
      byId(after.payers.map((p) => ({ participantId: p.participantId, amount: money(p.amount) }))),
    ) &&
    same(
      byId(before.shares.map((s) => ({ participantId: s.participantId, amount: s.amount, weight: s.weight }))),
      byId(after.shares.map((s) => ({ participantId: s.participantId, amount: money(s.amount), weight: s.weight }))),
    ) &&
    (data.documentsAfter === undefined || same(docs(data.documentsBefore), docs(data.documentsAfter)))
  )
}

export async function createExpense(
  tx: Db,
  data: {
    principal: Principal
    group: string
    expenseId: string
    /** null for a caller that never retries with the same key. */
    idempotencyKey: string | null
    expense: ExpenseDraft
    documents?: readonly StoredDocument[]
  },
): Promise<ReadExpense> {
  const context = await loadWriteContext(tx, { principal: data.principal, group: data.group, expenseId: data.expenseId, op: 'create', idempotencyKey: data.idempotencyKey })
  const { groupId } = context.membership
  const documents = data.documents ?? []
  const request = { op: 'create', groupId, expenseId: data.expenseId, expense: data.expense, documents }
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request, previous: context.previous }, async () => {
    const { existing } = context
    // Another group's expense does not reveal its revision.
    if (existing) throw new Conflict({ entity: 'expense', id: data.expenseId, currentRevision: existing.groupId === groupId ? existing.revision : 0 })
    assertPrivateWrite(context.privateContext, { expenseId: data.expenseId, op: 'create', draft: data.expense })
    const expense = resolve(data.expense, context.people)
    requireCategory(context, expense.categoryId)
    await writeExpense(tx, {
      expenseId: data.expenseId,
      groupId,
      expense,
      row: tx.insert(expenses).values({ id: data.expenseId, groupId, revision: 1, ...columns(expense) }).getSQL(),
    })
    if (documents.length) await writeDocuments(tx, { groupId, expenseId: data.expenseId, documents, saved: [] })
    // A new expense has no recurring link yet.
    await syncRecurrence(tx, { groupId, expenseId: data.expenseId, rule: expense.recurrence, expenseDate: expense.expenseDate, previous: null, link: null })
    const stored = await storedExpense(tx, data.expenseId)
    await record(tx, { context, principal: data.principal, type: 'create_expense', expense: stored, revision: 1 })
    return stored
  })
}

/** The expense to change: NotFound when it is missing or deleted, Conflict on a stale revision. */
export function currentExpense(context: WriteContext, expectedRevision: number) {
  const { expense } = context
  if (!expense || expense.deleted) throw new NotFound({ entity: 'expense', id: context.expenseId })
  if (expense.revision !== expectedRevision) throw new Conflict({ entity: 'expense', id: context.expenseId, currentRevision: expense.revision })
  return expense
}

/** The documents of an expense read with them. */
const documentsOf = (expense: ReadExpense): readonly StoredDocument[] => expense.documents ?? []

async function ensureBaseline(tx: Db, data: { context: WriteContext; principal: Principal }) {
  const { expense } = data.context
  // Expenses that predate history get a baseline snapshot before their first edit.
  if (expense && expense.revision === 0) await record(tx, { context: data.context, principal: data.principal, type: 'update_expense', expense, revision: 0 })
}

export async function updateExpense(
  tx: Db,
  data: {
    principal: Principal
    group: string
    expenseId: string
    expectedRevision: number
    /** null for a caller that never retries with the same key. */
    idempotencyKey: string | null
    expense: ExpenseDraft
    /** The full list of receipts; omitted keeps the saved ones. */
    documents?: readonly StoredDocument[]
    /** The write context, when the caller already loaded it. */
    context?: WriteContext
  },
): Promise<ReadExpense> {
  const context = await contextFor(tx, { ...data, op: 'change', context: data.context })
  const { groupId } = context.membership
  const request = { op: 'update', groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision, expense: data.expense, documents: data.documents ?? null }
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request, previous: context.previous }, async () => {
    const before = currentExpense(context, data.expectedRevision)
    const revision = before.revision
    assertPrivateWrite(context.privateContext, { expenseId: data.expenseId, op: 'update', draft: data.expense })
    const expense = resolve(data.expense, context.people)
    requireCategory(context, expense.categoryId)
    // An edit that changes nothing adds no revision, as in the current app.
    if (unchanged({ before, after: expense, documentsBefore: documentsOf(before), documentsAfter: data.documents })) return before
    await ensureBaseline(tx, { context, principal: data.principal })
    // A new amount or currency drops a legacy conversion, which no longer describes it (P-EXP-135).
    const moneyChanged = before.currency !== expense.currency || before.amount !== formatMinor({ amount: expense.amount, currency: expense.currency })
    await writeExpense(tx, {
      expenseId: data.expenseId,
      groupId,
      expense,
      row: tx
        .update(expenses)
        .set({ ...columns(expense), revision: revision + 1, ...(moneyChanged ? { originalAmount: null, originalCurrency: null, conversionRate: null } : {}) })
        .where(eq(expenses.id, data.expenseId))
        .getSQL(),
    })
    if (data.documents) await writeDocuments(tx, { groupId, expenseId: data.expenseId, documents: data.documents, saved: documentsOf(before) })
    await syncRecurrence(tx, {
      groupId,
      expenseId: data.expenseId,
      rule: expense.recurrence,
      expenseDate: expense.expenseDate,
      previous: { rule: before.recurrence, expenseDate: before.expenseDate },
      link: context.link,
    })
    const stored = await storedExpense(tx, data.expenseId)
    await record(tx, { context, principal: data.principal, type: 'update_expense', expense: stored, revision: revision + 1 })
    return stored
  })
}

/**
 * Removes receipts from a live expense as one audited revision that changes
 * nothing else: the amounts, payers and splits stay exactly as stored. Used
 * when a receipt is deleted for good (src/server/storage.ts). Returns false
 * when the expense is deleted or has none of the receipts, and writes nothing then.
 */
export async function removeDocuments(tx: Db, data: { principal: Principal; group: string; expenseId: string; urls: ReadonlySet<string> }): Promise<boolean> {
  const context = await loadWriteContext(tx, { principal: data.principal, group: data.group, expenseId: data.expenseId, op: 'change', idempotencyKey: null })
  const current = context.expense
  if (!current || current.deleted) return false
  const saved = documentsOf(current)
  const documents = saved.filter((d) => !data.urls.has(d.url))
  if (documents.length === saved.length) return false
  const revision = current.revision + 1
  await ensureBaseline(tx, { context, principal: data.principal })
  await tx.update(expenses).set({ revision }).where(eq(expenses.id, data.expenseId))
  await replaceDocuments(tx, { expenseId: data.expenseId, documents, saved })
  const stored = await storedExpense(tx, data.expenseId)
  await record(tx, { context, principal: data.principal, type: 'update_expense', expense: stored, revision })
  return true
}

export async function deleteExpense(
  tx: Db,
  data: {
    principal: Principal
    group: string
    expenseId: string
    expectedRevision: number
    /** null for a caller that never retries with the same key. */
    idempotencyKey: string | null
  },
): Promise<{ revision: number }> {
  const context = await loadWriteContext(tx, { principal: data.principal, group: data.group, expenseId: data.expenseId, op: 'change', idempotencyKey: data.idempotencyKey })
  const { groupId } = context.membership
  const request = { op: 'delete', groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision }
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request, previous: context.previous }, async () => {
    const current = currentExpense(context, data.expectedRevision)
    const revision = current.revision + 1
    assertPrivateWrite(context.privateContext, { expenseId: data.expenseId, op: 'delete' })
    await ensureBaseline(tx, { context, principal: data.principal })
    await tx.update(expenses).set({ deletedAt: new Date(), revision }).where(eq(expenses.id, data.expenseId))
    // Deleting the newest occurrence of a series stops it.
    if (context.link && !context.link.actedOn) await stopRecurrence(tx, { expenseId: data.expenseId })
    await recordExpenseEvent(tx, { type: 'delete_expense', expense: current, revision, principal: data.principal, snapshot: null })
    return { revision }
  })
}
