// Ledger reads and writes. Every function checks group access itself, so the
// RPC handlers and the MCP tools cannot skip it. Writes take a transaction.
import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { Result } from 'effect'
import {
  activities,
  expensePayers,
  expenses,
  expenseShares,
  groups,
  idempotencyKeys,
  memberships,
  participants,
} from '../../db/schema/app'
import { Conflict, Forbidden, Invalid, NotFound } from '../shared/api'
import { computeBalances } from '../shared/balances'
import type { CurrencyCode } from '../shared/currencies'
import { validateExpense, type ExpenseDraft, type ResolvedExpense } from '../shared/expense-rules'
import { formatMinor, minor, type Minor } from '../shared/money'
import type { Db } from './db'
import { randomId } from './ids'

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
    .where(or(eq(groups.id, data.group), eq(groups.slug, data.group)))
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

/**
 * Balances over every live expense of one group, per currency. PostgreSQL sums
 * the payments and shares per person; computeBalances then checks that each
 * currency nets to zero, so a corrupt ledger still fails loudly.
 */
export async function groupBalances(db: Db, groupId: string) {
  const result = await db.execute<{ currency: string; participant_id: string; paid: string; owed: string }>(sql`
    SELECT e.currency, parts.participant_id, sum(parts.paid)::text AS paid, sum(parts.owed)::text AS owed
    FROM expenses e
    JOIN (
      SELECT expense_id, participant_id, amount AS paid, 0::bigint AS owed FROM expense_payers WHERE group_id = ${groupId}
      UNION ALL
      SELECT expense_id, participant_id, 0::bigint, amount FROM expense_shares WHERE group_id = ${groupId}
    ) parts ON parts.expense_id = e.id
    WHERE e.group_id = ${groupId} AND e.deleted_at IS NULL
    GROUP BY e.currency, parts.participant_id
  `)
  const entries = result.rows.map((r) => ({
    currency: r.currency as CurrencyCode,
    payers: new Map([[r.participant_id, minor(BigInt(r.paid))]]),
    shares: new Map([[r.participant_id, minor(BigInt(r.owed))]]),
  }))
  const balances = computeBalances(entries)
  return [...balances].flatMap(([currency, byPerson]) =>
    [...byPerson].map(([participantId, b]) => ({
      participantId,
      currency,
      paid: formatMinor({ amount: b.paid, currency }),
      owed: formatMinor({ amount: b.owed, currency }),
      net: formatMinor({ amount: b.net, currency }),
    })),
  )
}

export async function getGroup(db: Db, data: { principal: Principal; group: string }) {
  const membership = await requireMember(db, data)
  const [group] = await db.select().from(groups).where(eq(groups.id, membership.groupId))
  if (!group) throw new NotFound({ entity: 'group', id: data.group })
  const [people, balances] = await Promise.all([
    db.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.groupId, group.id)).orderBy(asc(participants.name), asc(participants.id)),
    groupBalances(db, group.id),
  ])
  return {
    id: group.id,
    slug: group.slug,
    name: group.name,
    defaultCurrency: group.defaultCurrency as CurrencyCode,
    role: membership.role,
    participantId: membership.participantId,
    information: group.information,
    revision: group.revision,
    participants: people,
    balances,
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

type ExpenseRow = {
  id: string
  group_id: string
  revision: number
  kind: 'expense' | 'payment'
  title: string
  vendor: string | null
  notes: string
  category_id: number
  expense_date: string
  currency: string
  amount: string
  split_mode: 'evenly' | 'shares' | 'percentage' | 'amount'
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
  created_at: string
  updated_at: string
  created_key: string
  updated_key: string
  payers: { participantId: string; amount: string }[]
  shares: { participantId: string; amount: string; weight: string }[]
  document_count: number
}

/**
 * Expenses with their payers, shares and document count, in one statement.
 * PostgreSQL builds each row's parts as JSON, so the Worker parses one value
 * per row instead of several result sets: this keeps a list request within the
 * Workers CPU budget. Minor units travel as text, never as JSON numbers.
 */
async function selectExpenses(db: Db, data: { where: SQL; orderBy: SQL; limit?: number }) {
  const result = await db.execute<ExpenseRow>(sql`
    SELECT e.id, e.group_id, e.revision, e.kind, e.title, e.vendor, e.notes, e.category_id,
      e.expense_date::text AS expense_date, e.currency, e.amount::text AS amount, e.split_mode, e.recurrence,
      to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
      e.created_at::text AS created_key, e.updated_at::text AS updated_key,
      coalesce((SELECT json_agg(json_build_object('participantId', p.participant_id, 'amount', p.amount::text) ORDER BY p.participant_id)
        FROM expense_payers p WHERE p.expense_id = e.id), '[]') AS payers,
      coalesce((SELECT json_agg(json_build_object('participantId', s.participant_id, 'amount', s.amount::text, 'weight', s.weight) ORDER BY s.participant_id)
        FROM expense_shares s WHERE s.expense_id = e.id), '[]') AS shares,
      (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id) AS document_count
    FROM expenses e
    WHERE ${data.where}
    ORDER BY ${data.orderBy}
    ${data.limit === undefined ? sql`` : sql`LIMIT ${data.limit}`}
  `)
  return result.rows.map((e) => {
    const currency = e.currency as CurrencyCode
    const money = (amount: string) => formatMinor({ amount: minor(BigInt(amount)), currency })
    return {
      expense: {
        id: e.id,
        groupId: e.group_id,
        revision: e.revision,
        kind: e.kind,
        title: e.title,
        vendor: e.vendor,
        notes: e.notes,
        categoryId: e.category_id,
        expenseDate: e.expense_date,
        currency,
        amount: money(e.amount),
        splitMode: e.split_mode,
        payers: e.payers.map((p) => ({ participantId: p.participantId, amount: money(p.amount) })),
        shares: e.shares.map((s) => ({ participantId: s.participantId, amount: money(s.amount), weight: s.weight })),
        recurrence: e.recurrence,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        documentCount: e.document_count,
      },
      /** Exact PostgreSQL timestamps (microseconds) for cursors. */
      keys: { created: e.created_key, updated: e.updated_key },
    }
  })
}

async function loadExpenses(db: Db, ids: string[]) {
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
  const { groupId } = await requireMember(db, data)
  const f = data.filter
  const limit = Math.min(Math.max(Math.trunc(data.limit) || 50, 1), 200)
  const where: SQL[] = [sql`e.group_id = ${groupId}`, sql`e.deleted_at IS NULL`]
  if (f.search?.trim()) {
    const term = `%${f.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(sql`(e.title ILIKE ${term} OR e.vendor ILIKE ${term} OR e.notes ILIKE ${term})`)
  }
  if (f.currency) where.push(sql`e.currency = ${f.currency}`)
  if (f.categoryId !== undefined) where.push(sql`e.category_id = ${f.categoryId}`)
  if (f.kind) where.push(sql`e.kind = ${f.kind}`)
  if (f.from) where.push(sql`e.expense_date >= ${f.from}::date`)
  if (f.to) where.push(sql`e.expense_date <= ${f.to}::date`)
  if (f.payerId) where.push(sql`EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${f.payerId})`)
  if (f.participantId)
    where.push(sql`(EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.participant_id = ${f.participantId})
      OR EXISTS (SELECT 1 FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = ${f.participantId}))`)
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
  })
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

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Runs a write once per (principal, key). A retry with the same request gets
 * the stored result; the same key with a different request is refused.
 */
async function idempotent<A>(tx: Db, data: { principal: Principal; key: string; request: unknown }, write: () => Promise<A>): Promise<A> {
  const principal = `${data.principal.userId}:${data.principal.agentKeyId ?? 'web'}`
  const requestHash = await sha256(JSON.stringify(data.request))
  const [previous] = await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, data.key)))
  if (previous) {
    if (previous.requestHash !== requestHash) throw new Invalid({ message: 'This idempotency key was used for a different request', field: 'idempotencyKey' })
    return previous.response as A
  }
  const result = await write()
  await tx.insert(idempotencyKeys).values({ principal, key: data.key, requestHash, response: result as object })
  return result
}

async function groupParticipants(tx: Db, groupId: string) {
  return tx.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.groupId, groupId))
}

function resolve(draft: ExpenseDraft, people: { id: string }[]): ResolvedExpense {
  const result = validateExpense({ draft, participantIds: new Set(people.map((p) => p.id)) })
  if (Result.isFailure(result)) {
    const [first] = result.failure
    throw new Invalid({ message: result.failure.map((i) => `${i.field}: ${i.message}`).join('; '), ...(first ? { field: first.field } : {}) })
  }
  return result.success
}

/** The v2 history snapshot of one expense revision. Legacy snapshots keep schemaVersion 1. */
function snapshot(data: { group: { id: string; name: string; slug: string | null; defaultCurrency: string }; expense: ApiExpense; names: Map<string, string> }) {
  const named = <T extends { participantId: string }>(list: readonly T[]) => list.map((p) => ({ ...p, name: data.names.get(p.participantId) ?? '' }))
  return {
    schemaVersion: 2,
    kind: data.expense.kind,
    group: { id: data.group.id, name: data.group.name, slug: data.group.slug, currency: data.group.defaultCurrency },
    expense: { ...data.expense, payers: named(data.expense.payers), shares: named(data.expense.shares) },
  }
}

async function writeParts(tx: Db, data: { expenseId: string; groupId: string; expense: ResolvedExpense }) {
  await tx.delete(expensePayers).where(eq(expensePayers.expenseId, data.expenseId))
  await tx.delete(expenseShares).where(eq(expenseShares.expenseId, data.expenseId))
  await tx.insert(expensePayers).values(data.expense.payers.map((p) => ({ expenseId: data.expenseId, groupId: data.groupId, participantId: p.participantId, amount: p.amount, weight: '1' })))
  await tx.insert(expenseShares).values(data.expense.shares.map((s) => ({ expenseId: data.expenseId, groupId: data.groupId, participantId: s.participantId, amount: s.amount, weight: s.weight })))
}

const actor = (principal: Principal) => ({
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

export async function createExpense(
  tx: Db,
  data: { principal: Principal; group: string; expenseId: string; idempotencyKey: string; expense: ExpenseDraft },
): Promise<ApiExpense> {
  const { groupId } = await requireMember(tx, data)
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request: { op: 'create', groupId, expenseId: data.expenseId, expense: data.expense } }, async () => {
    const [existing] = await tx.select({ groupId: expenses.groupId }).from(expenses).where(eq(expenses.id, data.expenseId))
    if (existing) throw new Invalid({ message: 'An expense with this ID already exists; choose another ID', field: 'expenseId' })
    const people = await groupParticipants(tx, groupId)
    const expense = resolve(data.expense, people)
    await tx.insert(expenses).values({ id: data.expenseId, groupId, revision: 1, ...columns(expense) })
    await writeParts(tx, { expenseId: data.expenseId, groupId, expense })
    const [stored] = await loadExpenses(tx, [data.expenseId])
    const [group] = await tx.select().from(groups).where(eq(groups.id, groupId))
    if (!stored || !group) throw new NotFound({ entity: 'expense', id: data.expenseId })
    await tx.insert(activities).values({
      id: randomId(),
      groupId,
      type: 'create_expense',
      expenseId: data.expenseId,
      expenseRevision: 1,
      snapshot: snapshot({ group, expense: stored, names: new Map(people.map((p) => [p.id, p.name])) }),
      ...actor(data.principal),
    })
    return stored
  })
}

async function currentRevision(tx: Db, data: { groupId: string; expenseId: string; expectedRevision: number }) {
  const [row] = await tx
    .select({ revision: expenses.revision, deletedAt: expenses.deletedAt })
    .from(expenses)
    .where(and(eq(expenses.id, data.expenseId), eq(expenses.groupId, data.groupId)))
    .for('update')
  if (!row || row.deletedAt) throw new NotFound({ entity: 'expense', id: data.expenseId })
  if (row.revision !== data.expectedRevision) throw new Conflict({ entity: 'expense', id: data.expenseId, currentRevision: row.revision })
  return row.revision
}

async function ensureBaseline(tx: Db, data: { groupId: string; expenseId: string; revision: number; principal: Principal }) {
  if (data.revision !== 0) return
  // Expenses that predate history get a baseline snapshot before their first edit.
  const [stored] = await loadExpenses(tx, [data.expenseId])
  const [group] = await tx.select().from(groups).where(eq(groups.id, data.groupId))
  if (!stored || !group) return
  const people = await groupParticipants(tx, data.groupId)
  await tx
    .insert(activities)
    .values({ id: randomId(), groupId: data.groupId, type: 'update_expense', expenseId: data.expenseId, expenseRevision: 0, snapshot: snapshot({ group, expense: stored, names: new Map(people.map((p) => [p.id, p.name])) }), ...actor(data.principal) })
    .onConflictDoNothing()
}

export async function updateExpense(
  tx: Db,
  data: { principal: Principal; group: string; expenseId: string; expectedRevision: number; idempotencyKey: string; expense: ExpenseDraft },
): Promise<ApiExpense> {
  const { groupId } = await requireMember(tx, data)
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request: { op: 'update', groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision, expense: data.expense } }, async () => {
    const revision = await currentRevision(tx, { groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision })
    const people = await groupParticipants(tx, groupId)
    const expense = resolve(data.expense, people)
    await ensureBaseline(tx, { groupId, expenseId: data.expenseId, revision, principal: data.principal })
    await tx.update(expenses).set({ ...columns(expense), revision: revision + 1 }).where(eq(expenses.id, data.expenseId))
    await writeParts(tx, { expenseId: data.expenseId, groupId, expense })
    const [stored] = await loadExpenses(tx, [data.expenseId])
    const [group] = await tx.select().from(groups).where(eq(groups.id, groupId))
    if (!stored || !group) throw new NotFound({ entity: 'expense', id: data.expenseId })
    await tx.insert(activities).values({
      id: randomId(),
      groupId,
      type: 'update_expense',
      expenseId: data.expenseId,
      expenseRevision: revision + 1,
      snapshot: snapshot({ group, expense: stored, names: new Map(people.map((p) => [p.id, p.name])) }),
      ...actor(data.principal),
    })
    return stored
  })
}

export async function deleteExpense(
  tx: Db,
  data: { principal: Principal; group: string; expenseId: string; expectedRevision: number; idempotencyKey: string },
): Promise<{ revision: number }> {
  const { groupId } = await requireMember(tx, data)
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request: { op: 'delete', groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision } }, async () => {
    const revision = await currentRevision(tx, { groupId, expenseId: data.expenseId, expectedRevision: data.expectedRevision })
    await ensureBaseline(tx, { groupId, expenseId: data.expenseId, revision, principal: data.principal })
    await tx.update(expenses).set({ deletedAt: new Date(), revision: revision + 1 }).where(eq(expenses.id, data.expenseId))
    await tx.insert(activities).values({ id: randomId(), groupId, type: 'delete_expense', expenseId: data.expenseId, expenseRevision: revision + 1, ...actor(data.principal) })
    return { revision: revision + 1 }
  })
}

