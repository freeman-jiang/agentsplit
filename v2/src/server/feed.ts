// The dashboard: the feed across every group and private context the caller can
// see, the account-wide balance, and the expense page. Each read is one
// statement with the membership check inside it, so a request makes one round
// trip and a row the caller cannot see is never read.
import { sql, type SQL } from 'drizzle-orm'
import { Forbidden, Invalid, NotFound } from '../shared/api'
import { suggestSettlements } from '../shared/balances'
import type { CurrencyCode } from '../shared/currencies'
import { formatMinor, minor } from '../shared/money'
import type { Db } from './db'
import type { Principal } from './ledger'
import { balancesOf, balanceSums, displayName as displayNameOf, escapeLike, expenseColumns, involves, iso, toExpense, type BalanceSum, type ExpenseRow } from './sql'

export type FeedFilter = {
  readonly scope?: 'all' | 'grouped' | 'ungrouped'
  readonly groupId?: string
  readonly search?: string
  readonly involvingMe?: boolean
  readonly personUserId?: string
  readonly payerUserId?: string
  readonly currency?: CurrencyCode
  readonly categoryId?: number
  readonly kind?: 'expense' | 'payment'
  readonly from?: string
  readonly to?: string
}

export type FeedCursor = { readonly date: string; readonly createdAt: string; readonly id: string }

type Actor = { userId: string | null; name: string; source: string }
type AttributionRow = {
  created: { time: string; actor: Actor | null } | null
  updated: { time: string; actor: Actor | null } | null
  mine: string | null
}


/**
 * Who added and last edited expense `e`, from its create and update events.
 * Baselines (revision 0, or the legacy 'baseline' source) are not edits, and
 * the payer is never used. Live names are the accounts' current names.
 */
const attributionSql = (viewer: string) => {
  const actor = sql`CASE WHEN a.actor_user_id IS NOT NULL OR a.source = 'system' THEN json_build_object(
      'userId', a.actor_user_id,
      'name', coalesce(u.name, a.actor_name, CASE WHEN a.source = 'system' THEN 'Automatic recurrence' ELSE 'Member' END),
      'source', a.source) END`
  const event = (type: 'create_expense' | 'update_expense', order: SQL) => sql`(
    SELECT json_build_object('time', ${iso(sql`a.time`)}, 'actor', ${actor})
    FROM activities a LEFT JOIN "user" u ON u.id = a.actor_user_id AND u.email_verified
    WHERE a.expense_id = e.id AND a.type = ${type} AND a.source <> 'baseline' AND (a.expense_revision IS NULL OR a.expense_revision > 0)
    ORDER BY a.sequence ${order} LIMIT 1)`
  return sql`json_build_object(
    'created', ${event('create_expense', sql`ASC`)},
    'updated', ${event('update_expense', sql`DESC`)},
    'mine', (SELECT ${iso(sql`max(a.time)`)} FROM activities a
      WHERE a.expense_id = e.id AND a.type = 'update_expense' AND a.source <> 'baseline'
        AND (a.expense_revision IS NULL OR a.expense_revision > 0) AND a.actor_user_id = ${viewer}))`
}

const toAttribution = (a: AttributionRow) => ({
  createdAt: a.created?.time ?? null,
  updatedAt: a.updated?.time ?? null,
  lastEditedByYouAt: a.mine,
  createdBy: a.created?.actor ?? null,
  updatedBy: a.updated?.actor ?? null,
})

/** The display name of participant row `p`. */
const displayName = displayNameOf({ group: sql`p.group_id`, participant: sql`p.id`, name: sql`p.name` })

// ---------- feed ----------

type FeedRow = ExpenseRow & {
  group_kind: 'named' | 'private'
  group_name: string
  group_slug: string | null
  context_expense_id: string | null
  context_expense_title: string | null
  viewer_participant_id: string | null
  cursor_created: string
  people: { id: string; name: string }[]
  attribution: AttributionRow
}

/**
 * Newest expense date first, then creation time, then ID. Filters run in SQL
 * before the limit, and the cursor is the last row's exact key, so a new
 * expense at the head never shifts later pages.
 */
export async function listFeed(db: Db, data: { principal: Principal; filter: FeedFilter; cursor: FeedCursor | null; limit: number }) {
  const f = data.filter
  if (f.from && f.to && f.from > f.to) throw new Invalid({ message: 'The start date must be on or before the end date.', field: 'to' })
  const limit = Math.min(Math.max(Math.trunc(data.limit) || 30, 1), 100)
  const where: SQL[] = [sql`e.deleted_at IS NULL`]
  if (f.scope === 'grouped') where.push(sql`g.kind = 'named'`)
  if (f.scope === 'ungrouped') where.push(sql`g.kind = 'private'`)
  // Any group or context the caller belongs to, private ones included (DECISIONS.md, P-FEED-18).
  if (f.groupId) where.push(sql`(g.id = ${f.groupId} OR g.slug = ${f.groupId})`)
  const search = f.search?.trim()
  if (search) {
    const term = escapeLike(search)
    where.push(sql`(e.title ILIKE ${term} OR e.vendor ILIKE ${term})`)
  }
  if (f.currency) where.push(sql`e.currency = ${f.currency}`)
  if (f.categoryId !== undefined) where.push(sql`e.category_id = ${f.categoryId}`)
  if (f.kind) where.push(sql`e.kind = ${f.kind}`)
  if (f.from) where.push(sql`e.expense_date >= ${f.from}::date`)
  if (f.to) where.push(sql`e.expense_date <= ${f.to}::date`)
  // One default for the UI and for agents (DECISIONS.md, P-FEED-19).
  if (f.involvingMe ?? true) where.push(sql`m.participant_id IS NOT NULL AND ${involves(sql`m.participant_id`)}`)
  if (f.personUserId)
    where.push(sql`EXISTS (SELECT 1 FROM memberships pm WHERE pm.user_id = ${f.personUserId} AND pm.group_id = e.group_id
      AND pm.participant_id IS NOT NULL AND ${involves(sql`pm.participant_id`)})`)
  if (f.payerUserId)
    where.push(sql`EXISTS (SELECT 1 FROM expense_payers pp JOIN memberships pm ON pm.group_id = pp.group_id AND pm.participant_id = pp.participant_id
      WHERE pp.expense_id = e.id AND pm.user_id = ${f.payerUserId})`)
  if (data.cursor)
    where.push(sql`(e.expense_date, e.created_at, e.id) < (${data.cursor.date}::date, ${data.cursor.createdAt}::timestamptz, ${data.cursor.id})`)

  const result = await db.execute<FeedRow>(sql`
    SELECT ${expenseColumns},
      g.kind AS group_kind, g.name AS group_name, g.slug AS group_slug,
      pc.expense_id AS context_expense_id, ce.title AS context_expense_title,
      m.participant_id AS viewer_participant_id,
      to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${displayName}) ORDER BY p.id) FROM participants p
        WHERE p.id IN (SELECT participant_id FROM expense_payers WHERE expense_id = e.id
          UNION SELECT participant_id FROM expense_shares WHERE expense_id = e.id)), '[]') AS people,
      ${attributionSql(data.principal.userId)} AS attribution
    FROM expenses e
    JOIN memberships m ON m.group_id = e.group_id AND m.user_id = ${data.principal.userId} AND m.active
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN private_contexts pc ON pc.group_id = g.id
    LEFT JOIN expenses ce ON ce.id = pc.expense_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
    LIMIT ${limit + 1}
  `)
  const page = result.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    expenses: page.map((r) => ({
      ...toExpense(r),
      people: r.people,
      group: r.group_kind === 'named' ? { id: r.group_id, name: r.group_name, slug: r.group_slug } : null,
      contextExpenseId: r.context_expense_id,
      contextExpenseTitle: r.context_expense_title,
      participantId: r.viewer_participant_id,
      attribution: toAttribution(r.attribution),
    })),
    nextCursor: result.rows.length > limit && last ? { date: last.expense_date, createdAt: last.cursor_created, id: last.id } : null,
  }
}

// ---------- account balance ----------

type BalancesRow = {
  rows: { groupId: string; groupName: string; kind: 'named' | 'private'; currency: string; participantId: string; participantName: string; amount: string }[]
  unbound: string[]
  denied: string[]
  foreign: string[]
}

/** Groups or contexts to include, each with an optional participant to inspect instead of the caller's own. */
export type BalanceScope = ReadonlyArray<{ readonly groupId: string; readonly participantId?: string | undefined }>

/**
 * The caller's own balance in every named group and private context with
 * active access, per currency, and the totals per currency. Groups without a
 * linked participant are listed instead of counted. It only reads: due
 * recurring expenses are created by the scheduled job, never here.
 *
 * A scope (MCP get_participant_balances) limits the groups and may name
 * another participant of a group. A group outside the caller's access fails
 * the whole read, as does a participant from another group.
 */
export async function accountBalances(db: Db, data: { principal: Principal; scope?: BalanceScope }) {
  const scope = data.scope ? JSON.stringify(data.scope.map((s) => ({ group_id: s.groupId, participant_id: s.participantId ?? null }))) : null
  const result = await db.execute<{ result: BalancesRow }>(sql`
    WITH s AS (SELECT * FROM json_to_recordset(${scope ?? '[]'}::json) AS s(group_id text, participant_id text)),
    m AS (
      SELECT m.group_id, ${scope ? sql`coalesce(s.participant_id, m.participant_id)` : sql`m.participant_id`} AS participant_id
      FROM memberships m ${scope ? sql`JOIN s ON s.group_id = m.group_id` : sql``}
      WHERE m.user_id = ${data.principal.userId} AND m.active
    ),
    nets AS (
      SELECT e.group_id, e.currency, m.participant_id,
        sum(coalesce((SELECT sum(p.amount) FROM expense_payers p WHERE p.expense_id = e.id AND p.participant_id = m.participant_id), 0)
          - coalesce((SELECT sum(s.amount) FROM expense_shares s WHERE s.expense_id = e.id AND s.participant_id = m.participant_id), 0)) AS net
      FROM m JOIN expenses e ON e.group_id = m.group_id AND e.deleted_at IS NULL
      WHERE m.participant_id IS NOT NULL
      GROUP BY e.group_id, e.currency, m.participant_id
    )
    SELECT json_build_object(
      'rows', coalesce((SELECT json_agg(json_build_object('groupId', g.id, 'groupName', g.name, 'kind', g.kind, 'currency', n.currency,
          'participantId', p.id, 'participantName', ${displayName}, 'amount', n.net::text) ORDER BY g.name, g.id, n.currency)
        FROM nets n JOIN groups g ON g.id = n.group_id JOIN participants p ON p.id = n.participant_id), '[]'),
      'unbound', coalesce((SELECT json_agg(group_id) FROM m WHERE participant_id IS NULL), '[]'),
      'denied', coalesce((SELECT json_agg(s.group_id) FROM s WHERE NOT EXISTS (SELECT 1 FROM m WHERE m.group_id = s.group_id)), '[]'),
      'foreign', coalesce((SELECT json_agg(s.group_id) FROM s WHERE s.participant_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = s.participant_id AND p.group_id = s.group_id)), '[]')
    ) AS result
  `)
  const row = result.rows[0]?.result ?? { rows: [], unbound: [], denied: [], foreign: [] }
  if (row.denied.length) throw new Forbidden({ message: 'Group access denied' })
  if (row.foreign.length) throw new Invalid({ message: 'Participant does not belong to this group.', field: 'participantId' })
  const totals = new Map<CurrencyCode, bigint>()
  const balances = row.rows.map((r) => {
    const currency = r.currency as CurrencyCode
    const amount = BigInt(r.amount)
    totals.set(currency, (totals.get(currency) ?? 0n) + amount)
    return { ...r, currency, amount: formatMinor({ amount: minor(amount), currency }) }
  })
  return {
    balances,
    totals: [...totals]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, amount]) => ({ currency, amount: formatMinor({ amount: minor(amount), currency }) })),
    unboundGroupIds: [...row.unbound].sort(),
  }
}

// ---------- options ----------

/**
 * The caller and the verified accounts with a linked participant in any group
 * or context the caller can see. Nobody else is discoverable.
 */
const contactsSql = (userId: string) => sql`
  SELECT u.id, u.name, u.email FROM "user" u
  WHERE u.email_verified AND (u.id = ${userId} OR u.id IN (
    SELECT pm.user_id FROM memberships pm
    WHERE pm.active AND pm.participant_id IS NOT NULL
      AND pm.group_id IN (SELECT group_id FROM memberships WHERE user_id = ${userId} AND active)))`

export async function contacts(db: Db, data: { userId: string }) {
  const result = await db.execute<{ id: string; name: string; email: string }>(contactsSql(data.userId))
  return result.rows
}

type OptionsRow = {
  groups: { id: string; name: string; slug: string | null }[]
  people: { id: string; name: string; email: string }[]
  categories: { id: number; grouping: string; name: string }[]
}

export async function feedOptions(db: Db, data: { principal: Principal }) {
  const me = data.principal.userId
  const result = await db.execute<{ result: OptionsRow }>(sql`
    SELECT json_build_object(
      'groups', coalesce((SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'slug', g.slug) ORDER BY g.name, g.id)
        FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${me} AND m.active WHERE g.kind = 'named'), '[]'),
      'people', coalesce((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'email', c.email) ORDER BY c.name, c.id)
        FROM (${contactsSql(me)}) c), '[]'),
      'categories', coalesce((SELECT json_agg(json_build_object('id', c.id, 'grouping', c.grouping, 'name', c.name) ORDER BY c.id)
        FROM categories c), '[]')
    ) AS result
  `)
  const row = result.rows[0]?.result ?? { groups: [], people: [], categories: [] }
  return { userId: me, ...row }
}

// ---------- expense page ----------

type ContextRow = ExpenseRow & {
  role: 'admin' | 'member'
  viewer_participant_id: string | null
  g_name: string
  g_slug: string | null
  g_kind: 'named' | 'private'
  participants: { id: string; name: string }[]
  context_expense_id: string | null
  context_expense_title: string | null
  sums: BalanceSum[] | null
  invitations: { id: string; email: string; participantId: string; participantName: string; expiresAt: string }[] | null
  attribution: AttributionRow
}

/**
 * The expense page for any live expense the caller can see: the expense, its
 * group or private context with current names and, for a private context,
 * the repayments that settle it and (for its creator) its pending invitations.
 * Missing, deleted and inaccessible expenses look the same.
 */
export async function expenseContext(db: Db, data: { principal: Principal; expenseId: string }) {
  const result = await db.execute<ContextRow>(sql`
    SELECT ${expenseColumns},
      m.role, m.participant_id AS viewer_participant_id, g.name AS g_name, g.slug AS g_slug, g.kind AS g_kind,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${displayName}) ORDER BY p.name, p.id)
        FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
      pc.expense_id AS context_expense_id, ce.title AS context_expense_title,
      CASE WHEN pc.group_id IS NOT NULL THEN ${balanceSums({ group: sql`g.id` })} END AS sums,
      CASE WHEN pc.group_id IS NOT NULL AND m.role = 'admin' THEN coalesce((
        SELECT json_agg(json_build_object('id', i.id, 'email', i.email, 'participantId', i.participant_id,
          'participantName', coalesce(i.participant_name, ip.name), 'expiresAt', ${iso(sql`i.expires_at`)}) ORDER BY i.created_at, i.id)
        FROM invitations i JOIN participants ip ON ip.id = i.participant_id
        WHERE i.group_id = g.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL), '[]') END AS invitations,
      ${attributionSql(data.principal.userId)} AS attribution
    FROM expenses e
    JOIN memberships m ON m.group_id = e.group_id AND m.user_id = ${data.principal.userId} AND m.active
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN private_contexts pc ON pc.group_id = g.id
    LEFT JOIN expenses ce ON ce.id = pc.expense_id
    WHERE e.id = ${data.expenseId} AND e.deleted_at IS NULL
  `)
  const r = result.rows[0]
  if (!r) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return {
    expense: toExpense(r),
    attribution: toAttribution(r.attribution),
    group: { id: r.group_id, name: r.g_name, slug: r.g_slug, kind: r.g_kind },
    role: r.role,
    participantId: r.viewer_participant_id,
    participants: r.participants,
    context:
      r.context_expense_id === null
        ? null
        : {
            expenseId: r.context_expense_id,
            title: r.context_expense_title ?? '',
            settlements: settlements(r.sums ?? []),
            invitations: r.invitations ?? [],
          },
  }
}

/** Suggested repayments per currency, from per-person sums; the zero-sum check runs in computeBalances. */
function settlements(sums: NonNullable<ContextRow['sums']>) {
  return [...balancesOf(sums)].map(([currency, byPerson]) => ({
    currency,
    transfers: suggestSettlements(byPerson).map((t) => ({ from: t.from, to: t.to, amount: formatMinor({ amount: t.amount, currency }) })),
  }))
}
