// The activity log: the one writer of activity rows, their snapshots and texts,
// and the SQL that reads who did what. Activities are append-only, so the
// readers also understand every format the current app and earlier v2 wrote.
import { sql, type SQL } from 'drizzle-orm'
import { activities } from '../../db/schema/app'
import type { CurrencyCode } from '../shared/currencies'
import { titleWithVendor } from '../shared/history'
import type { V2ExpenseSnapshot, V2GroupSnapshot } from '../shared/snapshots'
import type { ActivityType, ExpenseKind, Recurrence, Role, SplitMode } from '../shared/vocabulary'
import { randomId } from '../shared/ids'
import type { Principal } from './core/access'
import type { Db } from './core/db'
import { iso } from './sql'

// ---------- actors ----------

/** The author the readers show for an activity without a user: the hourly recurring job (P-RECUR-17). */
export const SYSTEM_ACTOR = 'Automatic recurrence'
/** The author the attribution shows for a user whose name was not recorded. */
const UNKNOWN_ACTOR = 'Member'

/** The actor columns of an activity row; null is the system (the hourly job). */
const actorColumns = (principal: Principal | null) =>
  principal
    ? { source: principal.source, actorName: principal.name, actorUserId: principal.userId, agentKeyId: principal.agentKeyId }
    : { source: 'system' as const, actorName: null, actorUserId: null, agentKeyId: null }

/** The name to show for the author of activity row `a`, as recorded. */
export const actorName = sql`CASE WHEN a.source = 'system' AND a.actor_name IS NULL THEN ${SYSTEM_ACTOR} ELSE a.actor_name END`

/**
 * The source of activity row `alias` as it is shown and exported. Agent writes
 * are `agent`, as in the current app and the imported history. Rows that v2
 * wrote before this rule have `mcp`, and activities are permanent, so the
 * readers rename them (DECISIONS.md, parity audit, P-DB-79).
 */
export const activitySource = (alias: SQL) => sql`CASE WHEN ${alias}.source = 'mcp' THEN 'agent' ELSE ${alias}.source END`

/**
 * Is activity row `alias` a real create or edit? A baseline is not
 * (isBaseline in src/shared/history.ts, P-HIST-09).
 */
export const notBaseline = (alias: SQL) => sql`${alias}.source <> 'baseline' AND (${alias}.expense_revision IS NULL OR ${alias}.expense_revision > 0)`

// ---------- attribution ----------

/** One create or update of an expense, for attribution. `currentName` is the verified account's name now, when asked for. */
export type AttributionEvent = {
  type: 'create_expense' | 'update_expense'
  time: string
  userId: string | null
  actorName: string | null
  source: string
  currentName: string | null
}

/**
 * The create and update events of expense `expenseId`, oldest first, without
 * baselines, as a JSON array of AttributionEvent. `through` keeps the events
 * up to one recorded event; the names are then the ones recorded at the time,
 * not the accounts' current names, as in the current app (P-FEED-40).
 */
export const attributionEvents = (data: { groupId: SQL; expenseId: SQL; through?: SQL }) => sql`
  coalesce((SELECT json_agg(json_build_object('type', a.type, 'time', ${iso(sql`a.time`)}, 'userId', a.actor_user_id, 'actorName', a.actor_name, 'source', ${activitySource(sql`a`)},
      'currentName', ${data.through === undefined ? sql`(SELECT u.name FROM "user" u WHERE u.id = a.actor_user_id AND u.email_verified)` : sql`NULL`}) ORDER BY a.sequence)
    FROM activities a WHERE a.expense_id = ${data.expenseId} AND a.group_id = ${data.groupId} AND a.type IN ('create_expense', 'update_expense') AND ${notBaseline(sql`a`)}
      ${data.through === undefined ? sql`` : sql`AND a.sequence <= (SELECT b.sequence FROM activities b WHERE b.id = ${data.through})`}), '[]')`

type Actor = { userId: string | null; name: string; source: string }

/**
 * The current app's expenseAttributions: who added and last edited an expense,
 * from its events, never from the payer. An event without a user is shown only
 * for the system. `viewer` gets the time of their own last edit.
 */
export function attributionOf(data: { events: readonly AttributionEvent[]; viewer: string }) {
  const row: { createdAt: string | null; updatedAt: string | null; lastEditedByYouAt: string | null; createdBy: Actor | null; updatedBy: Actor | null } = {
    createdAt: null,
    updatedAt: null,
    lastEditedByYouAt: null,
    createdBy: null,
    updatedBy: null,
  }
  for (const event of data.events) {
    const actor =
      event.userId || event.source === 'system'
        ? { userId: event.userId, name: event.currentName ?? event.actorName ?? (event.source === 'system' ? SYSTEM_ACTOR : UNKNOWN_ACTOR), source: event.source }
        : null
    if (event.type === 'create_expense') {
      if (row.createdAt === null) {
        row.createdBy = actor
        row.createdAt = event.time
      }
    } else {
      row.updatedBy = actor
      row.updatedAt = event.time
      if (event.userId === data.viewer) row.lastEditedByYouAt = event.time
    }
  }
  return row
}

// ---------- texts ----------

/**
 * The texts of access changes. Each names people by name, never by email or
 * user ID, so readers show it in full (P-ACCESS-30). The Log reads an
 * update_group text as "<text> by <actor>.".
 */
export const accessText = {
  joined: (name: string) => `${name} joined`,
  left: (name: string) => `${name} left`,
  removed: (name: string) => `${name} removed`,
  role: (data: { name: string; role: Role }) => `${data.name} made ${data.role === 'admin' ? 'an admin' : 'a member'}`,
  bound: (data: { member: string; participant: string }) => `Member identity of ${data.member} bound to ${data.participant}`,
  invitation: (data: { action: 'created' | 'revoked'; participantName: string | null }) =>
    `Invitation ${data.action}${data.participantName ? ` for ${data.participantName}` : ''}`,
}

/**
 * The actions of the current app's access texts, "<action>: <target>" (its
 * group-access.ts log calls: each access request, and two phrases). Its
 * targets are user IDs and emails, so readers show only the action
 * (P-ACCESS-30, P-EXPORT-14). v2 wrote names in this form before its
 * sentences, and those rows read the same way.
 */
const V1_ACCESS_ACTIONS: ReadonlySet<string> = new Set([
  'join',
  'leave',
  'invite',
  'revoke_invitation',
  'remove_member',
  'set_role',
  'bind_member',
  'Member identity bound',
  'Invitation created',
])

/** The create_group text of a private context, and the text of its renewed invitation. */
export const PRIVATE_CONTEXT_TEXT = 'Private expense'
export const PRIVATE_INVITATION_RENEWED = 'Private expense invitation renewed'

const ACCESS_TYPES: ReadonlySet<ActivityType> = new Set(['join_group', 'leave_group', 'update_group'])

/**
 * The saved title of activity row `alias` as JSON `{ title, vendor }`, for an
 * expense event without stored text: v2 rows from before the text rule have
 * none, so it comes from the last saved snapshot at that event (P-EXP-107).
 * That is the row's own snapshot when it has one, so only a row without one
 * looks back. NULL for any other row.
 */
export const savedTitle = (alias: SQL) => {
  const titleOf = (snapshot: SQL) =>
    sql`CASE WHEN ${snapshot}->'expense'->>'title' IS NOT NULL THEN json_build_object('title', ${snapshot}->'expense'->>'title', 'vendor', ${snapshot}->'expense'->>'vendor') END`
  return sql`CASE WHEN ${alias}.data IS NOT NULL OR ${alias}.expense_id IS NULL THEN NULL
  WHEN ${alias}.snapshot IS NOT NULL THEN ${titleOf(sql`${alias}.snapshot`)}
  ELSE (SELECT ${titleOf(sql`s.snapshot`)}
    FROM activities s WHERE s.group_id = ${alias}.group_id AND s.expense_id = ${alias}.expense_id AND s.sequence <= ${alias}.sequence AND s.snapshot IS NOT NULL
    ORDER BY s.sequence DESC LIMIT 1) END`
}

/**
 * The text of an activity as it is shown and exported: an expense event's
 * "<vendor> — <title>" (stored, or from savedTitle), the current app's access
 * change without its target, and any other text unchanged.
 */
export function activityText(data: { type: ActivityType; data: string | null; saved: { title: string; vendor: string | null } | null }): string | null {
  if (data.data === null) return data.saved ? titleWithVendor(data.saved) : null
  if (!ACCESS_TYPES.has(data.type)) return data.data
  const at = data.data.indexOf(': ')
  const action = at === -1 ? null : data.data.slice(0, at)
  return action !== null && V1_ACCESS_ACTIONS.has(action) ? action : data.data
}

// ---------- snapshots ----------

/** The group as an expense snapshot names it. */
export type SnapshotGroup = { readonly id: string; readonly name: string; readonly slug: string | null; readonly defaultCurrency: string }

/** What a revision's snapshot stores of an expense, as the read model (expense-read.ts) gives it. */
export type RevisionExpense = {
  readonly id: string
  readonly groupId: string
  readonly revision: number
  readonly kind: ExpenseKind
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly expenseDate: string
  readonly currency: CurrencyCode
  readonly amount: string
  readonly splitMode: SplitMode
  readonly payers: readonly { readonly participantId: string; readonly amount: string }[]
  readonly shares: readonly { readonly participantId: string; readonly amount: string; readonly weight: string }[]
  readonly recurrence: Recurrence
  readonly createdAt: string
  readonly updatedAt: string
  readonly documentCount: number
  /** null when the read did not include them. */
  readonly documents: readonly { readonly id: string; readonly url: string; readonly width: number; readonly height: number }[] | null
}

/**
 * The v2 history snapshot of one expense revision, with its receipt pointers,
 * so that a receipt removed later stays in the earlier revision. Attribution
 * is not part of a revision: it comes from the activities themselves.
 */
export function expenseSnapshot(data: { group: SnapshotGroup; expense: RevisionExpense; names: ReadonlyMap<string, string> }) {
  const e = data.expense
  const name = (participantId: string) => data.names.get(participantId) ?? ''
  return {
    schemaVersion: 2,
    kind: e.kind,
    group: { id: data.group.id, name: data.group.name, slug: data.group.slug, currency: data.group.defaultCurrency },
    expense: {
      id: e.id,
      groupId: e.groupId,
      revision: e.revision,
      kind: e.kind,
      title: e.title,
      vendor: e.vendor,
      notes: e.notes,
      categoryId: e.categoryId,
      expenseDate: e.expenseDate,
      currency: e.currency,
      amount: e.amount,
      splitMode: e.splitMode,
      payers: e.payers.map((p) => ({ participantId: p.participantId, amount: p.amount, name: name(p.participantId) })),
      shares: e.shares.map((s) => ({ participantId: s.participantId, amount: s.amount, weight: s.weight, name: name(s.participantId) })),
      recurrence: e.recurrence,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      documentCount: e.documentCount,
      documents: (e.documents ?? []).map((d) => ({ id: d.id, url: d.url, width: d.width, height: d.height })),
    },
  } satisfies typeof V2ExpenseSnapshot.Encoded
}

/** The v2 history snapshot of a group and its participants, in the given order. */
export function groupSnapshot(data: {
  group: { id: string; name: string; slug: string | null; information: string; defaultCurrency: CurrencyCode; revision: number }
  participants: readonly { id: string; name: string }[]
}) {
  const { group } = data
  return {
    schemaVersion: 2,
    kind: 'group',
    group: {
      id: group.id,
      name: group.name,
      slug: group.slug,
      information: group.information,
      currency: group.defaultCurrency,
      revision: group.revision,
      participants: data.participants.map((p) => ({ id: p.id, name: p.name })),
    },
  } satisfies typeof V2GroupSnapshot.Encoded
}

// ---------- writers ----------

/**
 * Records one expense event in the write's transaction: its text, and for a
 * create or update the snapshot of the revision. `principal` null is the
 * system. A baseline (revision 0) is written once; a second one is skipped.
 */
export async function recordExpenseEvent(
  tx: Db,
  data: {
    type: 'create_expense' | 'update_expense' | 'delete_expense'
    expense: RevisionExpense
    revision: number
    principal: Principal | null
    /** The group and the people's names, for the snapshot. A deletion stores none. */
    snapshot: { group: SnapshotGroup; names: ReadonlyMap<string, string> } | null
  },
) {
  const insert = tx.insert(activities).values({
    id: randomId(),
    groupId: data.expense.groupId,
    type: data.type,
    expenseId: data.expense.id,
    expenseRevision: data.revision,
    // "<vendor> — <title>", as the current app stores it; a deletion keeps the deleted expense's text.
    data: titleWithVendor(data.expense),
    snapshot: data.snapshot ? expenseSnapshot({ group: data.snapshot.group, expense: data.expense, names: data.snapshot.names }) : null,
    ...actorColumns(data.principal),
  })
  await (data.revision === 0 ? insert.onConflictDoNothing() : insert)
}

/** Records one group event: a create, a settings change with its snapshot, or an access change with its text. */
export async function recordGroupEvent(
  tx: Db,
  data: {
    groupId: string
    type: 'create_group' | 'update_group' | 'join_group' | 'leave_group'
    principal: Principal
    data?: string | null
    participantId?: string | null
    groupRevision?: number
    snapshot?: ReturnType<typeof groupSnapshot>
  },
) {
  await tx.insert(activities).values({
    id: randomId(),
    groupId: data.groupId,
    type: data.type,
    data: data.data ?? null,
    participantId: data.participantId ?? null,
    groupRevision: data.groupRevision ?? null,
    snapshot: data.snapshot ?? null,
    ...actorColumns(data.principal),
  })
}
