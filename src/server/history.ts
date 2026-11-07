// History reads: the group Log, saved expense revisions, and the ledger and
// balances "as of" a recorded change. Every function is a read: it never
// writes a row, never creates recurring expenses, and never attaches live
// expense state to a historical answer. Stored snapshots are read as stored,
// in either format (src/shared/snapshots.ts).
import { sql, type SQL } from 'drizzle-orm'
import { Invalid, NotFound, type ActivityQuery as ActivityQuerySchema, type Boundary as BoundarySchema } from '../shared/api'
import type { Category, SavedExpense, SavedState } from '../shared/history'
import { compareIds } from '../shared/ids'
import { readSnapshot } from '../shared/snapshots'
import type { ActivityType, ExpenseKind } from '../shared/vocabulary'
import { memberCte, requireActive, type Principal } from './core/access'
import { activitySource, activityText, attributionEvents, notBaseline, savedTitle, type AttributionEvent } from './activity'
import type { Db } from './core/db'
import { passesFilter, tombstonesJson, type ExpenseFilter, type Tombstone } from './expense-read'
import { iso } from './sql'

export type Boundary = typeof BoundarySchema.Type

/**
 * Recording times as the API shows them, in whole milliseconds. Times are
 * stored in microseconds, so an event's own returned time, given back as
 * `asOf`, must still include that event.
 */
const ms = (column: SQL) => sql`date_trunc('milliseconds', ${column})`

/** All categories as one JSON object, `{ "<id>": [grouping, name] }`; 44 fixed rows. */
const categoriesColumn = sql`(SELECT json_object_agg(c.id, json_build_array(c.grouping, c.name)) FROM categories c) AS categories`
const categoryMap = (json: Record<string, [string, string]> | null): ReadonlyMap<number, Category> =>
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

type Head = { active: boolean | null; group_id: string; boundary_id: string | null; boundary_time: string | null; categories: Record<string, [string, string]> | null }

function requireBoundaryFound(data: { selection: Boundary; head: Head }) {
  if (data.selection.atActivityId !== undefined && data.head.boundary_id === null)
    throw new NotFound({ entity: 'boundary', id: data.selection.atActivityId })
}

const boundaryTime = (data: { selection: Boundary; head: Head }) =>
  data.selection.asOf !== undefined ? new Date(data.selection.asOf).toISOString() : (data.head.boundary_time ?? new Date().toISOString())

const read = (raw: unknown, categories: ReadonlyMap<number, Category>): SavedState | null => (raw === null ? null : readSnapshot({ raw, categories }))

type Tombstones = Record<string, Tombstone> | null

/** The saved expense with each receipt that was deleted for good since marked by its tombstone. */
const withTombstones = (expense: SavedExpense, tombstones: Tombstones): SavedExpense =>
  tombstones === null ? expense : { ...expense, documents: expense.documents.map((d) => ({ ...d, deleted: tombstones[d.url] ?? null })) }

const marked = (state: SavedState | null, tombstones: Tombstones): SavedState | null =>
  state?._tag === 'expense' ? { _tag: 'expense', expense: withTombstones(state.expense, tombstones) } : state

// ---------- the Log ----------

type ActivityRow = {
  id: string
  time: string
  type: ActivityType
  participantId: string | null
  expenseId: string | null
  expenseRevision: number | null
  data: string | null
  saved: { title: string; vendor: string | null } | null
  source: string
  actorName: string | null
  actorUserId: string | null
  agentKeyId: string | null
  verified: boolean
  agent: boolean
  snapshot: unknown
  previous: unknown
  live: { kind: ExpenseKind } | null
}

export type ActivityQuery = typeof ActivityQuerySchema.Type

/**
 * One page of a group's history, pinned to a boundary (the latest event when
 * none is given), with each event's saved state and the state before it, in
 * one statement.
 */
export async function listActivities(db: Db, data: { principal: Principal; groupId: string; withActors?: boolean } & ActivityQuery) {
  checkBoundary(data)
  if (data.recordedFrom && data.recordedTo && Date.parse(data.recordedFrom) > Date.parse(data.recordedTo))
    throw new Invalid({ message: 'recordedFrom must be on or before recordedTo', field: 'recordedFrom' })
  if (data.from && data.to && data.from > data.to) throw new Invalid({ message: 'from must be on or before to', field: 'to' })
  const cursor = data.cursor ?? 0
  const { limit } = data
  const historical = data.asOf !== undefined || data.atActivityId !== undefined
  const order = data.order === 'asc' ? sql`ASC` : sql`DESC`
  const where: SQL[] = [sql`a.group_id = g.id`, withinBoundary(data, sql`a`)]
  if (data.expenseId !== undefined) where.push(sql`a.expense_id = ${data.expenseId}`)
  if (data.type !== undefined) where.push(sql`a.type = ${data.type}`)
  if (data.from) where.push(sql`a.time >= (${data.from}::date)::timestamp AT TIME ZONE 'UTC'`)
  if (data.to) where.push(sql`a.time < ((${data.to}::date + 1)::timestamp AT TIME ZONE 'UTC')`)
  if (data.recordedFrom) where.push(sql`${ms(sql`a.time`)} >= ${data.recordedFrom}::timestamptz`)
  if (data.recordedTo) where.push(sql`${ms(sql`a.time`)} <= ${data.recordedTo}::timestamptz`)
  const result = await db.execute<Head & { activities: ActivityRow[]; tombstones: Tombstones }>(sql`
    WITH ${memberCte(data)}, ${boundaryCte(data)},
    page AS (
      SELECT a.* FROM activities a, g WHERE ${sql.join(where, sql` AND `)}
      ORDER BY a.sequence ${order} OFFSET ${cursor} LIMIT ${limit + 1}
    )
    SELECT g.active, g.id AS group_id,
      (SELECT id FROM b) AS boundary_id, (SELECT ${iso(sql`time`)} FROM b) AS boundary_time,
      coalesce((
        SELECT json_agg(json_build_object(
          'id', p.id, 'time', ${iso(sql`p.time`)}, 'type', p.type, 'participantId', p.participant_id,
          'expenseId', p.expense_id, 'expenseRevision', p.expense_revision, 'data', p.data, 'saved', ${savedTitle(sql`p`)}, 'source', ${activitySource(sql`p`)},
          'actorName', coalesce(p.actor_name, who.name), 'actorUserId', p.actor_user_id, 'agentKeyId', p.agent_key_id, 'verified', p.actor_user_id IS NOT NULL,
          'agent', p.agent_key_id IS NOT NULL OR ${activitySource(sql`p`)} = 'agent',
          'snapshot', p.snapshot, 'previous', prev.snapshot,
          'live', ${historical ? sql`NULL` : sql`(SELECT json_build_object('kind', e.kind) FROM expenses e WHERE e.id = p.expense_id AND e.group_id = p.group_id AND e.deleted_at IS NULL)`}
        ) ORDER BY p.sequence ${order})
        FROM page p
        LEFT JOIN activities prev ON prev.group_id = p.group_id AND prev.expense_id = p.expense_id AND prev.expense_revision = p.expense_revision - 1
        LEFT JOIN participants who ON who.id = p.participant_id AND who.group_id = p.group_id
      ), '[]') AS activities,
      ${tombstonesJson(sql`g.id`)} AS tombstones,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireActive(result.rows[0])
  requireBoundaryFound({ selection: data, head })
  const categories = categoryMap(head.categories)
  const rows = head.activities
  return {
    groupId: head.group_id,
    atActivityId: head.boundary_id,
    asOf: boundaryTime({ selection: data, head }),
    activities: rows.slice(0, limit).map((a) => ({
      id: a.id,
      time: a.time,
      type: a.type,
      participantId: a.participantId,
      expenseId: a.expenseId,
      expenseRevision: a.expenseRevision,
      data: activityText(a),
      source: a.source,
      actorName: a.actorName,
      verified: a.verified,
      agent: a.agent,
      snapshot: marked(read(a.snapshot, categories), head.tombstones),
      previousSnapshot: marked(read(a.previous, categories), head.tombstones),
      expense: a.live,
      // Only on request (MCP list_activity): the Log never shows user or key IDs (P-ACCESS-30, P-EXPORT-14).
      ...(data.withActors ? { actor: { userId: a.actorUserId, agentKeyId: a.agentKeyId } } : {}),
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
 * time. Never reads the live expense row. `attribution` adds the create and
 * update events up to that revision, with the names recorded then (P-FEED-40).
 */
export async function getSavedExpense(
  db: Db,
  data: { principal: Principal; groupId: string; expenseId: string; revision?: number; attribution?: boolean } & Boundary,
) {
  checkBoundary(data)
  const byRevision = data.revision !== undefined
  const events = data.attribution
    ? attributionEvents({ groupId: sql`g.id`, expenseId: sql`${data.expenseId}`, through: sql`(SELECT id FROM ev)` })
    : sql`NULL::json`
  const result = await db.execute<Head & { event: EventRow | null; tombstones: Tombstones; events: AttributionEvent[] | null }>(sql`
    WITH ${memberCte(data)}, ${boundaryCte(data)},
    ev AS (
      SELECT a.* FROM activities a, g
      WHERE a.group_id = g.id AND a.expense_id = ${data.expenseId}
        AND ${byRevision ? sql`a.expense_revision = ${data.revision ?? 0}` : sql`a.expense_revision IS NOT NULL AND ${withinBoundary(data, sql`a`)}`}
      ORDER BY a.sequence DESC LIMIT 1
    )
    SELECT g.active, g.id AS group_id,
      (SELECT id FROM b) AS boundary_id, (SELECT ${iso(sql`time`)} FROM b) AS boundary_time,
      (SELECT json_build_object('id', ev.id, 'time', ${iso(sql`ev.time`)}, 'type', ev.type, 'revision', ev.expense_revision, 'snapshot', ev.snapshot,
        'saved', (SELECT s.snapshot FROM activities s WHERE s.group_id = ev.group_id AND s.expense_id = ev.expense_id
          AND s.expense_revision IS NOT NULL AND s.sequence < ev.sequence AND s.snapshot IS NOT NULL ORDER BY s.sequence DESC LIMIT 1))
        FROM ev) AS event,
      ${events} AS events,
      ${tombstonesJson(sql`g.id`)} AS tombstones,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireActive(result.rows[0])
  if (!byRevision) requireBoundaryFound({ selection: data, head })
  const event = head.event
  if (!event) throw new NotFound({ entity: 'revision', id: data.expenseId })
  const raw = event.snapshot ?? event.saved
  if (raw === null) throw new Invalid({ message: 'This older revision has no complete saved snapshot' })
  const state = readSnapshot({ raw, categories: categoryMap(head.categories) })
  if (state._tag !== 'expense') throw new Invalid({ message: 'This event saved a group, not an expense' })
  const deleted = event.type === 'delete_expense'
  return {
    groupId: head.group_id,
    expense: withTombstones(state.expense, head.tombstones),
    deletedAt: deleted ? event.time : null,
    history: { activityId: event.id, recordedAt: event.time, revision: event.revision, deleted },
    /** null unless asked for. */
    attributionEvents: head.events,
  }
}

// ---------- the ledger at a boundary ----------

type LedgerHead = Head & { before_group: boolean; saved: { id: string; expenseId: string; type: ActivityType; snapshot: unknown }[]; missing: string[] }

/**
 * The ledger as recorded at a boundary: the last saved state of every expense,
 * without the ones deleted by then. An expense is present only from its first
 * recorded event, never inferred from its expense date. Expenses that existed
 * but have no saved state yet (imported rows before their baseline) make the
 * view incomplete, and are listed.
 */
export async function historicalLedger(db: Db, data: { principal: Principal; groupId: string } & Boundary) {
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
    SELECT g.active, g.id AS group_id, ${ms(sql`g.created_at`)} > (SELECT t FROM at_time) AS before_group,
      (SELECT id FROM b) AS boundary_id, (SELECT ${iso(sql`time`)} FROM b) AS boundary_time,
      coalesce((SELECT json_agg(json_build_object('id', l.id, 'expenseId', l.expense_id, 'type', l.type, 'snapshot', l.snapshot) ORDER BY l.expense_id)
        FROM latest l WHERE l.type <> 'delete_expense'), '[]') AS saved,
      coalesce((SELECT json_agg(e.id ORDER BY e.id) FROM expenses e
        WHERE e.group_id = g.id AND ${ms(sql`e.created_at`)} <= (SELECT t FROM at_time)
          AND NOT EXISTS (SELECT 1 FROM latest l WHERE l.expense_id = e.id)
          -- An expense whose real creation is recorded was created after the boundary.
          AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.group_id = g.id AND a.expense_id = e.id AND a.type = 'create_expense' AND a.expense_revision = 1 AND ${notBaseline(sql`a`)})
      ), '[]') AS missing,
      ${categoriesColumn}
    FROM g
  `)
  const head = requireActive(result.rows[0])
  requireBoundaryFound({ selection: data, head })
  if (head.before_group) throw new NotFound({ entity: 'groupAtTime', id: data.groupId })
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
  const unavailable = [...head.missing, ...unreadable].sort(compareIds)
  return {
    history: { asOf: boundaryTime({ selection: data, head }), atActivityId: head.boundary_id, complete: unavailable.length === 0, unavailableExpenseIds: unavailable },
    expenses,
  }
}

/**
 * Filters saved values (never live ones) with the same filter as the live list
 * (ledger.ts listExpenses), then sorts by saved expense date, creation time and
 * ID, newest first. The filter's sort does not apply.
 */
function filterSaved(expenses: readonly SavedExpense[], f: ExpenseFilter): SavedExpense[] {
  return expenses
    .filter((e) => passesFilter(e, f))
    .sort((a, b) => compareIds(b.expenseDate, a.expenseDate) || compareIds(b.createdAt, a.createdAt) || compareIds(b.id, a.id))
}

export async function listSavedExpenses(
  db: Db,
  data: { principal: Principal; groupId: string; filter: ExpenseFilter; cursor?: number; limit: number } & Boundary,
) {
  const ledger = await historicalLedger(db, data)
  const cursor = data.cursor ?? 0
  const { limit } = data
  const list = filterSaved(ledger.expenses, data.filter)
  return { history: ledger.history, expenses: list.slice(cursor, cursor + limit), hasMore: list.length > cursor + limit, nextCursor: cursor + limit }
}
