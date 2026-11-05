// History reads: the group Log, saved expense revisions, and the ledger and
// balances "as of" a recorded change. Every function is a read: it never
// writes a row, never creates recurring expenses, and never attaches live
// expense state to a historical answer. Stored snapshots are read as stored,
// in either format (src/shared/history.ts).
import { sql, type SQL } from 'drizzle-orm'
import { Forbidden, Invalid, NotFound } from '../shared/api'
import { computeBalances } from '../shared/balances'
import type { CurrencyCode } from '../shared/currencies'
import { readSnapshot, savedEntry, type Category, type SavedExpense, type SavedState } from '../shared/history'
import { formatMinor } from '../shared/money'
import type { Db } from './db'
import type { Principal } from './ledger'

export type ActivityType = 'create_group' | 'join_group' | 'leave_group' | 'update_group' | 'create_expense' | 'update_expense' | 'delete_expense'
export type Boundary = { readonly asOf?: string; readonly atActivityId?: string }

const ISO = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
/**
 * Recording times as the API shows them, in whole milliseconds. Times are
 * stored in microseconds, so an event's own returned time, given back as
 * `asOf`, must still include that event.
 */
const ms = (column: SQL) => sql`date_trunc('milliseconds', ${column})`

/**
 * The caller's membership in the group, as the first CTE of a statement. Rows
 * then come only from a group the caller belongs to, in the same round trip.
 */
const memberCte = (data: { principal: Principal; group: string }) => sql`g AS (
  SELECT g.id, g.created_at, g.default_currency, m.active, m.participant_id
  FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
  WHERE g.id = ${data.group} OR g.slug = ${data.group}
  LIMIT 1
)`

/** All categories as one JSON object, `{ "<id>": [grouping, name] }`; 44 fixed rows. */
const categoriesColumn = sql`(SELECT json_object_agg(c.id, json_build_array(c.grouping, c.name)) FROM categories c) AS categories`
export const categoryMap = (json: Record<string, [string, string]> | null): ReadonlyMap<number, Category> =>
  new Map(Object.entries(json ?? {}).map(([id, [grouping, name]]) => [Number(id), { grouping, name }]))

/** Checks a boundary selection before it reaches SQL. */
function checkBoundary(selection: Boundary & { revision?: number | undefined }) {
  if ([selection.asOf, selection.atActivityId, selection.revision].filter((v) => v !== undefined).length > 1)
    throw new Invalid({ message: 'Choose asOf, atActivityId or revision, not more than one' })
  if (selection.asOf !== undefined) {
    const time = Date.parse(selection.asOf)
    if (!Number.isFinite(time)) throw new Invalid({ message: 'asOf must be an ISO timestamp with a time zone', field: 'asOf' })
    if (time > Date.now()) throw new Invalid({ message: 'asOf cannot be in the future', field: 'asOf' })
  }
}

/**
 * The boundary event, as a CTE after `g`: the given activity of this group,
 * else the latest activity recorded at or before `asOf`, else the latest one.
 */
const boundaryCte = (selection: Boundary) => sql`b AS (
  SELECT a.id, a.sequence, a.time FROM activities a, g
  WHERE a.group_id = g.id ${
    selection.atActivityId !== undefined
      ? sql`AND a.id = ${selection.atActivityId}`
      : selection.asOf !== undefined
        ? sql`AND ${ms(sql`a.time`)} <= ${selection.asOf}::timestamptz`
        : sql``
  }
  ORDER BY a.sequence DESC LIMIT 1
)`
/** Events inside the boundary: at or before its sequence, and at or before `asOf` when given. */
const withinBoundary = (selection: Boundary, alias: SQL) =>
  sql`${alias}.sequence <= coalesce((SELECT sequence FROM b), 0) ${selection.asOf !== undefined ? sql`AND ${ms(sql`${alias}.time`)} <= ${selection.asOf}::timestamptz` : sql``}`

type Head = { active: boolean | null; boundary_id: string | null; boundary_time: string | null; group_created: string; categories: Record<string, [string, string]> | null }

function requireAccess<T extends { active: boolean | null }>(row: T | undefined): T {
  if (!row?.active) throw new Forbidden({ message: 'Group access denied' })
  return row
}

function requireBoundaryFound(data: { selection: Boundary; head: Head }) {
  if (data.selection.atActivityId !== undefined && data.head.boundary_id === null)
    throw new NotFound({ entity: 'history boundary in this group', id: data.selection.atActivityId })
}

const boundaryTime = (data: { selection: Boundary; head: Head }) =>
  data.selection.asOf !== undefined ? new Date(data.selection.asOf).toISOString() : (data.head.boundary_time ?? new Date().toISOString())

/**
 * Access changes store "<action>: <target>", where the target can be a user
 * ID or an email address (P-ACCESS-30, P-EXPORT-14). Only the action is shown
 * or exported; expense titles and group names pass unchanged.
 */
export function publicData(data: { type: ActivityType; data: string | null }): string | null {
  if (data.data === null || !['join_group', 'leave_group', 'update_group'].includes(data.type)) return data.data
  const at = data.data.indexOf(': ')
  return at === -1 ? data.data : data.data.slice(0, at)
}

const read = (raw: unknown, categories: ReadonlyMap<number, Category>): SavedState | null => (raw === null ? null : readSnapshot({ raw, categories }))

// ---------- the Log ----------

type ActivityRow = {
  id: string
  time: string
  type: ActivityType
  participantId: string | null
  expenseId: string | null
  expenseRevision: number | null
  data: string | null
  source: string
  actorName: string | null
  verified: boolean
  agent: boolean
  snapshot: unknown
  previous: unknown
  live: { kind: 'expense' | 'payment' } | null
}

export type ActivityQuery = Boundary & {
  readonly cursor?: number
  readonly limit?: number
  readonly expenseId?: string
  readonly type?: ActivityType
  readonly from?: string
  readonly to?: string
  readonly recordedFrom?: string
  readonly recordedTo?: string
  readonly order?: 'asc' | 'desc'
}

/**
 * One page of a group's history, pinned to a boundary (the latest event when
 * none is given), with each event's saved state and the state before it, in
 * one statement.
 */
export async function listActivities(db: Db, data: { principal: Principal; group: string } & ActivityQuery) {
  checkBoundary(data)
  if (data.recordedFrom && data.recordedTo && Date.parse(data.recordedFrom) > Date.parse(data.recordedTo))
    throw new Invalid({ message: 'recordedFrom must be on or before recordedTo', field: 'recordedFrom' })
  if (data.from && data.to && data.from > data.to) throw new Invalid({ message: 'from must be on or before to', field: 'to' })
  const cursor = data.cursor ?? 0
  const limit = data.limit ?? 5
  const historical = data.asOf !== undefined || data.atActivityId !== undefined
  const order = data.order === 'asc' ? sql`ASC` : sql`DESC`
  const where: SQL[] = [sql`a.group_id = g.id`, withinBoundary(data, sql`a`)]
  if (data.expenseId !== undefined) where.push(sql`a.expense_id = ${data.expenseId}`)
  if (data.type !== undefined) where.push(sql`a.type = ${data.type}`)
  // Recording days are UTC calendar days.
  if (data.from) where.push(sql`a.time >= (${data.from}::date)::timestamp AT TIME ZONE 'UTC'`)
  if (data.to) where.push(sql`a.time < ((${data.to}::date + 1)::timestamp AT TIME ZONE 'UTC')`)
  if (data.recordedFrom) where.push(sql`${ms(sql`a.time`)} >= ${data.recordedFrom}::timestamptz`)
  if (data.recordedTo) where.push(sql`${ms(sql`a.time`)} <= ${data.recordedTo}::timestamptz`)
  const result = await db.execute<Head & { activities: ActivityRow[] }>(sql`
    WITH ${memberCte(data)}, ${boundaryCte(data)},
    page AS (
      SELECT a.* FROM activities a, g WHERE ${sql.join(where, sql` AND `)}
      ORDER BY a.sequence ${order} OFFSET ${cursor} LIMIT ${limit + 1}
    )
    SELECT g.active, g.created_at::text AS group_created,
      (SELECT id FROM b) AS boundary_id, (SELECT ${ISO(sql`time`)} FROM b) AS boundary_time,
      coalesce((
        SELECT json_agg(json_build_object(
          'id', p.id, 'time', ${ISO(sql`p.time`)}, 'type', p.type, 'participantId', p.participant_id,
          'expenseId', p.expense_id, 'expenseRevision', p.expense_revision, 'data', p.data, 'source', p.source,
          'actorName', coalesce(p.actor_name, who.name), 'verified', p.actor_user_id IS NOT NULL,
          'agent', p.agent_key_id IS NOT NULL OR p.source IN ('agent', 'mcp'),
          'snapshot', p.snapshot, 'previous', prev.snapshot,
          'live', ${historical ? sql`NULL` : sql`(SELECT json_build_object('kind', e.kind) FROM expenses e WHERE e.id = p.expense_id AND e.group_id = p.group_id AND e.deleted_at IS NULL)`}
        ) ORDER BY p.sequence ${order})
        FROM page p
        LEFT JOIN activities prev ON prev.group_id = p.group_id AND prev.expense_id = p.expense_id AND prev.expense_revision = p.expense_revision - 1
        LEFT JOIN participants who ON who.id = p.participant_id AND who.group_id = p.group_id
      ), '[]') AS activities,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireAccess(result.rows[0])
  requireBoundaryFound({ selection: data, head })
  const categories = categoryMap(head.categories)
  const rows = head.activities
  return {
    atActivityId: head.boundary_id,
    asOf: boundaryTime({ selection: data, head }),
    activities: rows.slice(0, limit).map((a) => ({
      id: a.id,
      time: a.time,
      type: a.type,
      participantId: a.participantId,
      expenseId: a.expenseId,
      expenseRevision: a.expenseRevision,
      data: publicData(a),
      source: a.source,
      actorName: a.actorName,
      verified: a.verified,
      agent: a.agent,
      snapshot: read(a.snapshot, categories),
      previousSnapshot: read(a.previous, categories),
      expense: a.live,
    })),
    hasMore: rows.length > limit,
    nextCursor: cursor + limit,
  }
}

// ---------- one saved revision ----------

type EventRow = { id: string; time: string; type: ActivityType; revision: number; snapshot: unknown; saved: unknown }

/**
 * One expense as saved: at a revision, or at the revision in effect at a
 * boundary. A deletion event returns the last saved state with its deletion
 * time. Never reads the live expense row.
 */
export async function getSavedExpense(db: Db, data: { principal: Principal; group: string; expenseId: string; revision?: number } & Boundary) {
  checkBoundary(data)
  const byRevision = data.revision !== undefined
  const result = await db.execute<Head & { event: EventRow | null }>(sql`
    WITH ${memberCte(data)}, ${boundaryCte(data)},
    ev AS (
      SELECT a.* FROM activities a, g
      WHERE a.group_id = g.id AND a.expense_id = ${data.expenseId}
        AND ${byRevision ? sql`a.expense_revision = ${data.revision ?? 0}` : sql`a.expense_revision IS NOT NULL AND ${withinBoundary(data, sql`a`)}`}
      ORDER BY a.sequence DESC LIMIT 1
    )
    SELECT g.active, g.created_at::text AS group_created,
      (SELECT id FROM b) AS boundary_id, (SELECT ${ISO(sql`time`)} FROM b) AS boundary_time,
      (SELECT json_build_object('id', ev.id, 'time', ${ISO(sql`ev.time`)}, 'type', ev.type, 'revision', ev.expense_revision, 'snapshot', ev.snapshot,
        'saved', (SELECT s.snapshot FROM activities s WHERE s.group_id = ev.group_id AND s.expense_id = ev.expense_id
          AND s.expense_revision IS NOT NULL AND s.sequence < ev.sequence AND s.snapshot IS NOT NULL ORDER BY s.sequence DESC LIMIT 1))
        FROM ev) AS event,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireAccess(result.rows[0])
  if (!byRevision) requireBoundaryFound({ selection: data, head })
  const event = head.event
  if (!event) throw new NotFound({ entity: 'saved expense revision at this point', id: data.expenseId })
  const raw = event.snapshot ?? event.saved
  if (raw === null) throw new Invalid({ message: 'This older revision has no complete saved snapshot' })
  const state = readSnapshot({ raw, categories: categoryMap(head.categories) })
  if (state._tag !== 'expense') throw new Invalid({ message: 'This event saved a group, not an expense' })
  const deleted = event.type === 'delete_expense'
  return {
    expense: state.expense,
    deletedAt: deleted ? event.time : null,
    history: { activityId: event.id, recordedAt: event.time, revision: event.revision, deleted },
  }
}

// ---------- the ledger at a boundary ----------

type LedgerHead = Head & { saved: { id: string; expenseId: string; type: ActivityType; snapshot: unknown }[]; missing: string[] }

/**
 * The ledger as recorded at a boundary: the last saved state of every expense,
 * without the ones deleted by then. An expense is present only from its first
 * recorded event, never inferred from its expense date. Expenses that existed
 * but have no saved state yet (imported rows before their baseline) make the
 * view incomplete, and are listed.
 */
export async function historicalLedger(db: Db, data: { principal: Principal; group: string } & Boundary) {
  checkBoundary(data)
  if (data.asOf === undefined && data.atActivityId === undefined) throw new Invalid({ message: 'Choose asOf or atActivityId for a historical read' })
  const result = await db.execute<LedgerHead>(sql`
    WITH ${memberCte(data)}, ${boundaryCte(data)},
    latest AS (
      SELECT DISTINCT ON (a.expense_id) a.id, a.expense_id, a.type, a.snapshot FROM activities a, g
      WHERE a.group_id = g.id AND a.expense_id IS NOT NULL AND a.expense_revision IS NOT NULL AND ${withinBoundary(data, sql`a`)}
      ORDER BY a.expense_id, a.sequence DESC
    ),
    at_time AS (SELECT coalesce(${data.asOf ?? null}::timestamptz, (SELECT time FROM b), now()) AS t)
    SELECT g.active, g.created_at::text AS group_created, ${ms(sql`g.created_at`)} > (SELECT t FROM at_time) AS before_group,
      (SELECT id FROM b) AS boundary_id, (SELECT ${ISO(sql`time`)} FROM b) AS boundary_time,
      coalesce((SELECT json_agg(json_build_object('id', l.id, 'expenseId', l.expense_id, 'type', l.type, 'snapshot', l.snapshot) ORDER BY l.expense_id)
        FROM latest l WHERE l.type <> 'delete_expense'), '[]') AS saved,
      coalesce((SELECT json_agg(e.id ORDER BY e.id) FROM expenses e
        WHERE e.group_id = g.id AND ${ms(sql`e.created_at`)} <= (SELECT t FROM at_time)
          AND NOT EXISTS (SELECT 1 FROM latest l WHERE l.expense_id = e.id)
          -- An expense whose real creation is recorded was created after the boundary.
          AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.group_id = g.id AND a.expense_id = e.id AND a.type = 'create_expense' AND a.expense_revision = 1 AND a.source <> 'baseline')
      ), '[]') AS missing,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireAccess(result.rows[0] as (LedgerHead & { before_group: boolean }) | undefined)
  requireBoundaryFound({ selection: data, head })
  if (head.before_group) throw new NotFound({ entity: 'group at this time', id: data.group })
  const categories = categoryMap(head.categories)
  const expenses: SavedExpense[] = []
  // A latest event without a snapshot (other than a deletion) predates snapshots: it is not evidence.
  const unreadable: string[] = []
  for (const row of head.saved) {
    if (row.snapshot === null) {
      unreadable.push(row.expenseId)
      continue
    }
    const state = readSnapshot({ raw: row.snapshot, categories })
    if (state._tag === 'expense') expenses.push(state.expense)
  }
  const unavailable = [...head.missing, ...unreadable].sort()
  return {
    history: { asOf: boundaryTime({ selection: data, head }), atActivityId: head.boundary_id, complete: unavailable.length === 0, unavailableExpenseIds: unavailable },
    expenses,
  }
}

export type HistoricalFilter = {
  readonly search?: string
  readonly vendor?: string
  readonly currency?: CurrencyCode
  readonly categoryId?: number
  readonly payerId?: string
  readonly participantId?: string
  readonly kind?: 'expense' | 'payment'
  readonly recurrence?: 'none' | 'daily' | 'weekly' | 'monthly'
  readonly from?: string
  readonly to?: string
}

/** Filters saved values (never live ones), then sorts by saved expense date, creation time and ID, newest first. */
export function filterSaved(expenses: readonly SavedExpense[], f: HistoricalFilter): SavedExpense[] {
  const text = f.search?.trim().toLocaleLowerCase()
  return expenses
    .filter(
      (e) =>
        (!text || [e.title, e.vendor ?? ''].some((v) => v.toLocaleLowerCase().includes(text))) &&
        (!f.vendor || e.vendor?.toLocaleLowerCase() === f.vendor.toLocaleLowerCase()) &&
        (!f.currency || e.currency === f.currency) &&
        (f.categoryId === undefined || e.categoryId === f.categoryId) &&
        (!f.payerId || e.payers.some((p) => p.participantId === f.payerId)) &&
        (!f.participantId || e.payers.some((p) => p.participantId === f.participantId) || e.shares.some((s) => s.participantId === f.participantId)) &&
        (!f.kind || e.kind === f.kind) &&
        (!f.recurrence || e.recurrence === f.recurrence) &&
        (!f.from || e.expenseDate >= f.from) &&
        (!f.to || e.expenseDate <= f.to),
    )
    .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export async function listSavedExpenses(
  db: Db,
  data: { principal: Principal; group: string; filter: HistoricalFilter; cursor?: number; limit?: number } & Boundary,
) {
  const ledger = await historicalLedger(db, data)
  const cursor = data.cursor ?? 0
  const limit = data.limit ?? 50
  const list = filterSaved(ledger.expenses, data.filter)
  return { history: ledger.history, expenses: list.slice(cursor, cursor + limit), hasMore: list.length > cursor + limit, nextCursor: cursor + limit }
}

/** Balances from the saved splits at a boundary. Refused when the boundary is incomplete, so a partial total is never shown as a balance. */
export async function savedBalances(db: Db, data: { principal: Principal; group: string } & Boundary) {
  const ledger = await historicalLedger(db, data)
  if (!ledger.history.complete)
    throw new Invalid({
      message:
        'Historical balances are unavailable because some expenses have no saved state at this point. Read list_expenses at the same boundary to inspect history coverage.',
    })
  const balances = computeBalances(ledger.expenses.map(savedEntry))
  return {
    history: ledger.history,
    balances: [...balances].flatMap(([currency, byPerson]) =>
      [...byPerson].map(([participantId, b]) => ({
        participantId,
        currency,
        paid: formatMinor({ amount: b.paid, currency }),
        owed: formatMinor({ amount: b.owed, currency }),
        net: formatMinor({ amount: b.net, currency }),
      })),
    ),
  }
}
