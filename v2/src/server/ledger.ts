// Ledger reads and writes. Every function checks group access itself, so the
// RPC handlers and the MCP tools cannot skip it. Writes take a transaction.
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { Result } from 'effect'
import {
  activities,
  expenseDocuments,
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

/** Balances over every live expense of one group, per currency. */
export async function groupBalances(db: Db, groupId: string) {
  const live = and(eq(expenses.groupId, groupId), isNull(expenses.deletedAt))
  const [rows, payers, shares] = await Promise.all([
    db.select({ id: expenses.id, currency: expenses.currency }).from(expenses).where(live),
    db
      .select({ expenseId: expensePayers.expenseId, participantId: expensePayers.participantId, amount: expensePayers.amount })
      .from(expensePayers)
      .innerJoin(expenses, eq(expenses.id, expensePayers.expenseId))
      .where(live),
    db
      .select({ expenseId: expenseShares.expenseId, participantId: expenseShares.participantId, amount: expenseShares.amount })
      .from(expenseShares)
      .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
      .where(live),
  ])
  const byExpense = <T extends { expenseId: string }>(list: T[]) => Map.groupBy(list, (r) => r.expenseId)
  const p = byExpense(payers)
  const s = byExpense(shares)
  const parts = (list: { participantId: string; amount: bigint }[] | undefined) =>
    new Map((list ?? []).map((r) => [r.participantId, minor(r.amount)] as const))
  const balances = computeBalances(rows.map((e) => ({ currency: e.currency as CurrencyCode, payers: parts(p.get(e.id)), shares: parts(s.get(e.id)) })))
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

/** Expense rows with their parts, in API form. */
async function loadExpenses(db: Db, ids: string[]) {
  if (ids.length === 0) return []
  const [rows, payers, shares, documents] = await Promise.all([
    db.select().from(expenses).where(inArray(expenses.id, ids)),
    db.select().from(expensePayers).where(inArray(expensePayers.expenseId, ids)).orderBy(asc(expensePayers.participantId)),
    db.select().from(expenseShares).where(inArray(expenseShares.expenseId, ids)).orderBy(asc(expenseShares.participantId)),
    db.select({ expenseId: expenseDocuments.expenseId, n: sql<number>`count(*)::int` }).from(expenseDocuments).where(inArray(expenseDocuments.expenseId, ids)).groupBy(expenseDocuments.expenseId),
  ])
  const p = Map.groupBy(payers, (r) => r.expenseId)
  const s = Map.groupBy(shares, (r) => r.expenseId)
  const d = new Map(documents.map((r) => [r.expenseId, r.n]))
  const byId = new Map(rows.map((e) => [e.id, e]))
  return ids.flatMap((id) => {
    const e = byId.get(id)
    if (!e) return []
    const currency = e.currency as CurrencyCode
    const money = (amount: bigint) => formatMinor({ amount: minor(amount), currency })
    return [
      {
        id: e.id,
        groupId: e.groupId,
        revision: e.revision,
        kind: e.kind,
        title: e.title,
        vendor: e.vendor,
        notes: e.notes,
        categoryId: e.categoryId,
        expenseDate: e.expenseDate,
        currency,
        amount: money(e.amount),
        splitMode: e.splitMode,
        payers: (p.get(id) ?? []).map((r) => ({ participantId: r.participantId, amount: money(r.amount) })),
        shares: (s.get(id) ?? []).map((r) => ({ participantId: r.participantId, amount: money(r.amount), weight: r.weight })),
        recurrence: e.recurrence,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
        documentCount: d.get(id) ?? 0,
      },
    ]
  })
}

export type ApiExpense = Awaited<ReturnType<typeof loadExpenses>>[number]

export async function listExpenses(
  db: Db,
  data: { principal: Principal; group: string; filter: ExpenseFilter; cursor: string | null; limit: number },
) {
  const { groupId } = await requireMember(db, data)
  const f = data.filter
  const limit = Math.min(Math.max(Math.trunc(data.limit) || 50, 1), 200)
  const where: SQL[] = [eq(expenses.groupId, groupId), isNull(expenses.deletedAt)]
  if (f.search?.trim()) {
    const term = `%${f.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(or(ilike(expenses.title, term), ilike(expenses.vendor, term), ilike(expenses.notes, term)) as SQL)
  }
  if (f.currency) where.push(eq(expenses.currency, f.currency))
  if (f.categoryId !== undefined) where.push(eq(expenses.categoryId, f.categoryId))
  if (f.kind) where.push(eq(expenses.kind, f.kind))
  if (f.from) where.push(gte(expenses.expenseDate, f.from))
  if (f.to) where.push(lte(expenses.expenseDate, f.to))
  if (f.payerId)
    where.push(exists(db.select({ x: sql`1` }).from(expensePayers).where(and(eq(expensePayers.expenseId, expenses.id), eq(expensePayers.participantId, f.payerId)))))
  if (f.participantId)
    where.push(
      or(
        exists(db.select({ x: sql`1` }).from(expenseShares).where(and(eq(expenseShares.expenseId, expenses.id), eq(expenseShares.participantId, f.participantId)))),
        exists(db.select({ x: sql`1` }).from(expensePayers).where(and(eq(expensePayers.expenseId, expenses.id), eq(expensePayers.participantId, f.participantId)))),
      ) as SQL,
    )
  const byUpdated = f.sort === 'updated'
  if (data.cursor) {
    const c = decodeCursor(data.cursor)
    where.push(
      byUpdated
        ? sql`(${expenses.updatedAt}, ${expenses.id}) < (${c.k}::timestamptz, ${c.i})`
        : sql`(${expenses.expenseDate}, ${expenses.createdAt}, ${expenses.id}) < (${c.k}::date, ${c.c}::timestamptz, ${c.i})`,
    )
  }
  const rows = await db
    .select({ id: expenses.id, date: expenses.expenseDate, createdAt: expenses.createdAt, updatedAt: expenses.updatedAt })
    .from(expenses)
    .where(and(...where))
    .orderBy(...(byUpdated ? [desc(expenses.updatedAt), desc(expenses.id)] : [desc(expenses.expenseDate), desc(expenses.createdAt), desc(expenses.id)]))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    expenses: await loadExpenses(db, page.map((r) => r.id)),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(byUpdated ? { k: last.updatedAt.toISOString(), c: '', i: last.id } : { k: last.date, c: last.createdAt.toISOString(), i: last.id })
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

