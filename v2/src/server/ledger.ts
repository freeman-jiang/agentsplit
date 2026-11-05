// Ledger reads and writes. Every function checks group access itself, so the
// RPC handlers and the MCP tools cannot skip it. Writes take a transaction.
import { and, asc, eq, isNull, notInArray, sql, type SQL } from 'drizzle-orm'
import {
  activities,
  expenseDocuments,
  expensePayers,
  expenses,
  expenseShares,
  groups,
  idempotencyKeys,
  memberships,
} from '../../db/schema/app'
import { Conflict, Forbidden, Invalid, NotFound } from '../shared/api'
import type { CurrencyCode } from '../shared/currencies'
import { validateExpense, type ExpenseDraft, type ResolvedExpense } from '../shared/expense-rules'
import { formatMinor, type Minor } from '../shared/money'
import type { Db } from './db'
import { randomId, sha256Hex } from './ids'
import { balancesOf, balanceSums, displayName, escapeLike, expenseColumns, involves, toExpense, type BalanceSum, type ExpenseRow } from './sql'
import { stopRecurrence, syncRecurrence, type LinkState } from './recurring'
import { assertPrivateWrite, privateContextOf, type PrivateContext } from './ungrouped'

export type Principal = {
  readonly userId: string
  readonly name: string
  readonly email: string
  readonly source: 'web' | 'mcp'
  /** The API key or OAuth connection an agent used; null on the web. */
  readonly agentKeyId: string | null
}

// ---------- access ----------

export type Membership = { groupId: string; role: 'admin' | 'member'; participantId: string | null }

/** The one membership check. A group that does not exist and a group the caller cannot see look the same. */
export async function requireMember(db: Db, data: { principal: Principal; group: string; admin?: boolean }): Promise<Membership> {
  const [row] = await db
    .select({ groupId: groups.id, role: memberships.role, participantId: memberships.participantId, active: memberships.active })
    .from(groups)
    .innerJoin(memberships, and(eq(memberships.groupId, groups.id), eq(memberships.userId, data.principal.userId)))
    .where(eq(groups.id, sql`agentsplit_group_id(${data.group})`))
    .limit(1)
  if (!row?.active) throw new Forbidden({ message: 'Group access denied' })
  if (data.admin && row.role !== 'admin') throw new Forbidden({ message: 'Only admins can do this' })
  return { groupId: row.groupId, role: row.role, participantId: row.participantId }
}

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
  slug: string | null
  name: string
  default_currency: string
  information: string
  revision: number
  role: 'admin' | 'member'
  participant_id: string | null
  active: boolean
  participants: { id: string; name: string }[]
  sums: BalanceSum[]
}

/** Per-person sums to balances, with the zero-sum check of computeBalances. */
function toBalances(sums: GroupRow['sums']) {
  return [...balancesOf(sums)].flatMap(([currency, byPerson]) =>
    [...byPerson].map(([participantId, b]) => ({
      participantId,
      currency,
      paid: formatMinor({ amount: b.paid, currency }),
      owed: formatMinor({ amount: b.owed, currency }),
      net: formatMinor({ amount: b.net, currency }),
    })),
  )
}

/**
 * The group's participants with their display names: a bound, verified
 * account's name replaces the participant's placeholder name, as in the
 * current app (P-GROUP-55).
 */
export const displayNames = (groupId: SQL) => sql`
  SELECT p.id, ${displayName({ group: sql`p.group_id`, participant: sql`p.id`, name: sql`p.name` })} AS name
  FROM participants p WHERE p.group_id = ${groupId}`

/**
 * A group with its participants and balances, in one statement that also
 * checks the caller's membership, so the request makes one round trip.
 */
export async function getGroup(db: Db, data: { principal: Principal; group: string }) {
  const result = await db.execute<GroupRow>(sql`
    WITH g AS (
      SELECT g.id, g.slug, g.name, g.default_currency, g.information, g.revision, m.role, m.participant_id, m.active
      FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
      WHERE g.id = agentsplit_group_id(${data.group})
      LIMIT 1
    )
    SELECT g.*,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id)
        FROM (${displayNames(sql`g.id`)}) p), '[]') AS participants,
      ${balanceSums({ group: sql`g.id` })} AS sums
    FROM g
  `)
  const [g] = result.rows
  if (!g?.active) throw new Forbidden({ message: 'Group access denied' })
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    defaultCurrency: g.default_currency as CurrencyCode,
    role: g.role,
    participantId: g.participant_id,
    information: g.information,
    revision: g.revision,
    participants: g.participants,
    balances: toBalances(g.sums),
  }
}

export type ExpenseFilter = {
  readonly sort?: 'date' | 'updated'
  readonly search?: string
  readonly participantId?: string
  readonly payerId?: string
  readonly currency?: CurrencyCode
  readonly categoryId?: number
  readonly kind?: 'expense' | 'payment'
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

type ListRow = ExpenseRow & { created_key: string; updated_key: string }

/**
 * Expenses with their payers, shares and document count, in one statement.
 * PostgreSQL builds each row's parts as JSON, so the server parses one value
 * per row instead of several result sets. Minor units travel as text, never as
 * JSON numbers.
 */
async function selectExpenses(db: Db, data: { where: SQL; orderBy: SQL; limit?: number; with?: SQL }) {
  const result = await db.execute<ListRow>(sql`
    ${data.with ?? sql``}
    SELECT ${expenseColumns}, e.created_at::text AS created_key, e.updated_at::text AS updated_key
    FROM expenses e
    WHERE ${data.where}
    ORDER BY ${data.orderBy}
    ${data.limit === undefined ? sql`` : sql`LIMIT ${data.limit}`}
  `)
  return result.rows.map((e) => ({
    expense: toExpense(e),
    /** Exact PostgreSQL timestamps (microseconds) for cursors. */
    keys: { created: e.created_key, updated: e.updated_key },
  }))
}

export async function loadExpenses(db: Db, ids: string[]) {
  if (ids.length === 0) return []
  const rows = await selectExpenses(db, { where: sql`e.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, orderBy: sql`e.id` })
  const byId = new Map(rows.map((r) => [r.expense.id, r.expense]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

export type ApiExpense = Awaited<ReturnType<typeof loadExpenses>>[number]

export async function listExpenses(
  db: Db,
  data: { principal: Principal; group: string; filter: ExpenseFilter; cursor: string | null; limit: number },
) {
  const f = data.filter
  const limit = Math.min(Math.max(Math.trunc(data.limit) || 50, 1), 200)
  // The membership check is part of the statement: rows come only from a group the caller belongs to.
  const member = sql`WITH g AS (
    SELECT g.id FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId} AND m.active
    WHERE g.id = agentsplit_group_id(${data.group}) LIMIT 1
  )`
  const where: SQL[] = [sql`e.group_id = (SELECT id FROM g)`, sql`e.deleted_at IS NULL`]
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
  const rows = await selectExpenses(db, {
    where: sql.join(where, sql` AND `),
    orderBy: byUpdated ? sql`e.updated_at DESC, e.id DESC` : sql`e.expense_date DESC, e.created_at DESC, e.id DESC`,
    limit: limit + 1,
    with: member,
  })
  // No rows: an empty page, or not a member. Only then is the separate check needed.
  if (rows.length === 0) await requireMember(db, data)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    expenses: page.map((r) => r.expense),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(byUpdated ? { k: last.keys.updated, c: '', i: last.expense.id } : { k: last.expense.expenseDate, c: last.keys.created, i: last.expense.id })
        : null,
  }
}

export async function getExpense(db: Db, data: { principal: Principal; group: string; expenseId: string }) {
  const { groupId } = await requireMember(db, data)
  const [row] = await db.select({ id: expenses.id }).from(expenses).where(and(eq(expenses.id, data.expenseId), eq(expenses.groupId, groupId), isNull(expenses.deletedAt)))
  const [expense] = row ? await loadExpenses(db, [row.id]) : []
  if (!expense) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return expense
}

// ---------- writes ----------

const idempotencyPrincipal = (principal: Principal) => `${principal.userId}:${principal.agentKeyId ?? 'web'}`

/** A used idempotency key: the hash of its request, and the stored result (any JSON value). */
export type StoredRequest = { readonly requestHash: string; readonly response: unknown }

/**
 * Runs a write once per (principal, key). A retry with the same request gets
 * the stored result; the same key with a different request is refused. A
 * caller without a key (null) can never retry, so it skips the lookup and the
 * stored row. `previous` is the lookup, when the caller already read it.
 */
export async function idempotent<A>(
  tx: Db,
  data: { principal: Principal; key: string | null; request: unknown; previous?: StoredRequest | null },
  write: () => Promise<A>,
): Promise<A> {
  if (data.key === null) return write()
  const principal = idempotencyPrincipal(data.principal)
  const requestHash = sha256Hex(JSON.stringify(data.request))
  const [previous] =
    data.previous === undefined
      ? await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, data.key)))
      : data.previous
        ? [data.previous]
        : []
  if (previous) {
    if (previous.requestHash !== requestHash) throw new Invalid({ message: 'This idempotency key was used for a different request', field: 'idempotencyKey' })
    return previous.response as A
  }
  const result = await write()
  await tx.insert(idempotencyKeys).values({ principal, key: data.key, requestHash, response: result as object })
  return result
}

function resolve(draft: ExpenseDraft, people: readonly { id: string }[]): ResolvedExpense {
  const result = validateExpense({ draft, participantIds: new Set(people.map((p) => p.id)) })
  if (!result.ok) {
    const [first] = result.issues
    throw new Invalid({ message: result.issues.map((i) => `${i.field}: ${i.message}`).join('; '), ...(first ? { field: first.field } : {}) })
  }
  return result.value
}

export type StoredDocument = { id: string; url: string; width: number; height: number }

export async function expenseDocumentsOf(tx: Db, expenseId: string): Promise<StoredDocument[]> {
  return tx
    .select({ id: expenseDocuments.id, url: expenseDocuments.url, width: expenseDocuments.width, height: expenseDocuments.height })
    .from(expenseDocuments)
    .where(eq(expenseDocuments.expenseId, expenseId))
    .orderBy(asc(expenseDocuments.id))
}

/** The receipts of expense row `e` as JSON, in the order of expenseDocumentsOf. */
const documentsOf = sql`coalesce((SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height) ORDER BY d.id)
  FROM expense_documents d WHERE d.expense_id = e.id), '[]')`

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
  readonly group: { readonly id: string; readonly name: string; readonly slug: string | null; readonly defaultCurrency: string }
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly categories: ReadonlySet<number>
  readonly privateContext: PrivateContext | null
  readonly previous: StoredRequest | null
  /** create: the expense with this ID in any group. A create must not reuse it. */
  readonly existing: { readonly groupId: string; readonly revision: number } | null
  /** change: the expense in this group, locked for the write, with its receipts. */
  readonly expense: { readonly value: ApiExpense; readonly deleted: boolean; readonly documents: readonly StoredDocument[] } | null
  /** change: the expense's recurring link. */
  readonly link: LinkState | null
}

type ContextRow = {
  group_id: string
  slug: string | null
  name: string
  default_currency: string
  role: 'admin' | 'member'
  participant_id: string | null
  active: boolean
  people: { id: string; name: string }[]
  categories: number[]
  private_context: PrivateContext | null
  previous: StoredRequest | null
  existing: { groupId: string; revision: number } | null
  expense: (ExpenseRow & { deleted: boolean; documents: StoredDocument[] }) | null
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
    WITH g AS (
      SELECT g.id, g.slug, g.name, g.default_currency, m.role, m.participant_id, m.active
      FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
      WHERE g.id = agentsplit_group_id(${data.group})
      LIMIT 1
    )${change ? sql`, locked AS (SELECT e.id FROM expenses e WHERE e.id = ${data.expenseId} AND e.group_id = (SELECT id FROM g) FOR UPDATE)` : sql``}
    SELECT g.id AS group_id, g.slug, g.name, g.default_currency, g.role, g.participant_id, g.active,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name)) FROM participants p WHERE p.group_id = g.id), '[]') AS people,
      coalesce((SELECT json_agg(c.id) FROM categories c), '[]') AS categories,
      ${privateContextOf(sql`g.id`)} AS private_context,
      ${
        data.idempotencyKey === null
          ? none
          : sql`(SELECT json_build_object('requestHash', k.request_hash, 'response', k.response) FROM idempotency_keys k
              WHERE k.principal = ${idempotencyPrincipal(data.principal)} AND k.key = ${data.idempotencyKey})`
      } AS previous,
      ${change ? none : sql`(SELECT json_build_object('groupId', x.group_id, 'revision', x.revision) FROM expenses x WHERE x.id = ${data.expenseId})`} AS existing,
      ${
        change
          ? sql`(SELECT row_to_json(r) FROM (SELECT ${expenseColumns}, e.deleted_at IS NOT NULL AS deleted, ${documentsOf} AS documents
              FROM expenses e WHERE e.id = (SELECT id FROM locked)) r)`
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
  const [row] = result.rows
  if (!row?.active) throw new Forbidden({ message: 'Group access denied' })
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
    expense: row.expense ? { value: toExpense(row.expense), deleted: row.expense.deleted, documents: row.expense.documents } : null,
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
  const result = await tx.execute<ExpenseRow & { documents: StoredDocument[] }>(sql`SELECT ${expenseColumns}, ${documentsOf} AS documents FROM expenses e WHERE e.id = ${expenseId}`)
  const [row] = result.rows
  if (!row) throw new NotFound({ entity: 'expense', id: expenseId })
  return { expense: toExpense(row), documents: row.documents }
}

/**
 * The v2 history snapshot of one expense revision, with its receipt pointers,
 * so that a receipt removed later stays in the earlier revision. Legacy snapshots keep schemaVersion 1.
 */
export function snapshot(data: {
  group: { id: string; name: string; slug: string | null; defaultCurrency: string }
  expense: ApiExpense
  names: Map<string, string>
  documents: readonly StoredDocument[]
}) {
  const named = <T extends { participantId: string }>(list: readonly T[]) => list.map((p) => ({ ...p, name: data.names.get(p.participantId) ?? '' }))
  // Attribution comes from the activities themselves; it is not part of the revision.
  const { addedBy: _addedBy, editedBy: _editedBy, ...expense } = data.expense
  return {
    schemaVersion: 2,
    kind: data.expense.kind,
    group: { id: data.group.id, name: data.group.name, slug: data.group.slug, currency: data.group.defaultCurrency },
    expense: { ...expense, payers: named(data.expense.payers), shares: named(data.expense.shares), documents: data.documents },
  }
}

const namesOf = (context: WriteContext) => new Map(context.people.map((p) => [p.id, p.name]))

/**
 * Replaces an expense's receipts. Every URL must be a receipt uploaded to this
 * group, as in the current app; a document keeps its ID only if it already
 * belongs to this expense, so a client cannot collide with another expense's row.
 * `saved` is the expense's receipts before the write.
 */
async function writeDocuments(tx: Db, data: { groupId: string; expenseId: string; documents: readonly StoredDocument[]; saved: readonly StoredDocument[] }) {
  const urls = [...new Set(data.documents.map((d) => d.url))]
  if (urls.length) {
    const registered = await tx.execute<{ url: string }>(
      sql`SELECT url FROM receipts WHERE group_id = ${data.groupId} AND url IN (${sql.join(urls.map((u) => sql`${u}`), sql`, `)})`,
    )
    if (registered.rows.length !== urls.length) throw new Invalid({ message: 'Attach only receipts uploaded to this group', field: 'documents' })
  }
  const own = new Set(data.saved.map((d) => d.id))
  if (data.saved.length) await tx.delete(expenseDocuments).where(eq(expenseDocuments.expenseId, data.expenseId))
  if (data.documents.length)
    await tx.insert(expenseDocuments).values(
      data.documents.map((d) => ({ id: own.has(d.id) ? d.id : randomId(), expenseId: data.expenseId, url: d.url, width: d.width, height: d.height })),
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

export const actor = (principal: Principal) => ({
  source: principal.source,
  actorName: principal.name,
  actorUserId: principal.userId,
  agentKeyId: principal.agentKeyId,
})

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
function unchanged(data: { before: ApiExpense; after: ResolvedExpense; documentsBefore: readonly StoredDocument[]; documentsAfter: readonly StoredDocument[] | undefined }) {
  const { before, after } = data
  const money = (amount: Minor) => formatMinor({ amount, currency: after.currency })
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const byId = <T extends { participantId: string }>(list: readonly T[]) => [...list].sort((a, b) => (a.participantId < b.participantId ? -1 : 1))
  const docs = (list: readonly StoredDocument[]) => list.map((d) => [d.url, d.width, d.height]).sort()
  return (
    same(
      [before.kind, before.title, before.vendor, before.notes, before.categoryId, before.expenseDate, before.currency, before.amount, before.splitMode, before.recurrence],
      [after.kind, after.title, after.vendor, after.notes, after.categoryId, after.expenseDate, after.currency, money(after.amount), after.splitMode, after.recurrence],
    ) &&
    same(byId(before.payers), byId(after.payers.map((p) => ({ participantId: p.participantId, amount: money(p.amount) })))) &&
    same(byId(before.shares), byId(after.shares.map((s) => ({ participantId: s.participantId, amount: money(s.amount), weight: s.weight })))) &&
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
): Promise<ApiExpense> {
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
    await tx.insert(activities).values({
      id: randomId(),
      groupId,
      type: 'create_expense',
      expenseId: data.expenseId,
      expenseRevision: 1,
      snapshot: snapshot({ group: context.group, expense: stored.expense, names: namesOf(context), documents: stored.documents }),
      ...actor(data.principal),
    })
    return stored.expense
  })
}

/** The expense to change: NotFound when it is missing or deleted, Conflict on a stale revision. */
export function currentExpense(context: WriteContext, expectedRevision: number) {
  const { expense } = context
  if (!expense || expense.deleted) throw new NotFound({ entity: 'expense', id: context.expenseId })
  if (expense.value.revision !== expectedRevision) throw new Conflict({ entity: 'expense', id: context.expenseId, currentRevision: expense.value.revision })
  return expense
}

async function ensureBaseline(tx: Db, data: { context: WriteContext; principal: Principal }) {
  const { expense } = data.context
  if (!expense || expense.value.revision !== 0) return
  // Expenses that predate history get a baseline snapshot before their first edit.
  await tx
    .insert(activities)
    .values({
      id: randomId(),
      groupId: data.context.membership.groupId,
      type: 'update_expense',
      expenseId: data.context.expenseId,
      expenseRevision: 0,
      snapshot: snapshot({ group: data.context.group, expense: expense.value, names: namesOf(data.context), documents: expense.documents }),
      ...actor(data.principal),
    })
    .onConflictDoNothing()
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
): Promise<ApiExpense> {
  const context = await contextFor(tx, { ...data, op: 'change', context: data.context })
  const { groupId } = context.membership
  const request = { op: 'update', groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision, expense: data.expense, documents: data.documents ?? null }
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request, previous: context.previous }, async () => {
    const current = currentExpense(context, data.expectedRevision)
    const before = current.value
    const revision = before.revision
    assertPrivateWrite(context.privateContext, { expenseId: data.expenseId, op: 'update', draft: data.expense })
    const expense = resolve(data.expense, context.people)
    requireCategory(context, expense.categoryId)
    // An edit that changes nothing adds no revision, as in the current app.
    if (unchanged({ before, after: expense, documentsBefore: current.documents, documentsAfter: data.documents })) return before
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
    if (data.documents) await writeDocuments(tx, { groupId, expenseId: data.expenseId, documents: data.documents, saved: current.documents })
    await syncRecurrence(tx, {
      groupId,
      expenseId: data.expenseId,
      rule: expense.recurrence,
      expenseDate: expense.expenseDate,
      previous: { rule: before.recurrence, expenseDate: before.expenseDate },
      link: context.link,
    })
    const stored = await storedExpense(tx, data.expenseId)
    await tx.insert(activities).values({
      id: randomId(),
      groupId,
      type: 'update_expense',
      expenseId: data.expenseId,
      expenseRevision: revision + 1,
      snapshot: snapshot({ group: context.group, expense: stored.expense, names: namesOf(context), documents: stored.documents }),
      ...actor(data.principal),
    })
    return stored.expense
  })
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
    const revision = currentExpense(context, data.expectedRevision).value.revision
    assertPrivateWrite(context.privateContext, { expenseId: data.expenseId, op: 'delete' })
    await ensureBaseline(tx, { context, principal: data.principal })
    await tx.update(expenses).set({ deletedAt: new Date(), revision: revision + 1 }).where(eq(expenses.id, data.expenseId))
    // Deleting the newest occurrence of a series stops it.
    if (context.link && !context.link.actedOn) await stopRecurrence(tx, { expenseId: data.expenseId })
    await tx.insert(activities).values({ id: randomId(), groupId, type: 'delete_expense', expenseId: data.expenseId, expenseRevision: revision + 1, ...actor(data.principal) })
    return { revision: revision + 1 }
  })
}
