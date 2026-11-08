// The dashboard: the feed across every group and private context the caller can
// see, its filter options, and the expense page. Each read is one statement
// with the membership check inside it, so a request makes one round trip and
// a row the caller cannot see is never read. The account-wide balance is in
// balances.ts.
import { sql, type SQL } from 'drizzle-orm'
import { Invalid, NotFound, type FeedCursor as FeedCursorSchema, type FeedFilter as FeedFilterSchema } from '../shared/api'
import type { GroupKind, Role } from '../shared/vocabulary'
import { groupIdOfInput, myMemberships, type Principal } from './core/access'
import { attributionOf } from './activity'
import { balanceSums, settlementsOf, type BalanceSum } from './balances'
import type { Db } from './core/db'
import { EXPENSE_ORDERS, expenseColumns, involves, toExpense, type ExpenseRow, type OrderedRow } from './expense-read'
import { listedInvitation } from './invitations'
import { contactsSql, participantName, participantsJson } from './people'
import { escapeLike, iso } from './sql'

export type FeedFilter = typeof FeedFilterSchema.Type
export type FeedCursor = typeof FeedCursorSchema.Type

// ---------- feed ----------

type FeedRow = ExpenseRow & OrderedRow & {
  group_kind: GroupKind
  group_name: string
  group_slug: string | null
  context_expense_id: string | null
  context_expense_title: string | null
  viewer_participant_id: string | null
  people: { id: string; name: string }[]
}

/**
 * Newest expense date first, then creation time, then ID. Filters run in SQL
 * before the limit, and the cursor is the last row's exact key, so a new
 * expense at the head never shifts later pages.
 */
export async function listFeed(db: Db, data: { principal: Principal; filter: FeedFilter; cursor: FeedCursor | null; limit: number }) {
  const f = data.filter
  if (f.from && f.to && f.from > f.to) throw new Invalid({ message: 'The start date must be on or before the end date.', field: 'to' })
  const { limit } = data
  const where: SQL[] = [sql`e.deleted_at IS NULL`]
  if (f.scope === 'grouped') where.push(sql`g.kind = 'named'`)
  if (f.scope === 'ungrouped') where.push(sql`g.kind = 'private'`)
  // Any group or context the caller belongs to, private ones included (DECISIONS.md, P-FEED-18).
  if (f.groupId) where.push(sql`g.id = ${groupIdOfInput(f.groupId)}`)
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
  const order = EXPENSE_ORDERS.date
  if (data.cursor) where.push(order.after({ a: data.cursor.date, b: data.cursor.createdAt, id: data.cursor.id }))

  const result = await db.execute<FeedRow>(sql`
    SELECT ${expenseColumns({ attribution: true })},
      g.kind AS group_kind, g.name AS group_name, g.slug AS group_slug,
      pc.expense_id AS context_expense_id, ce.title AS context_expense_title,
      m.participant_id AS viewer_participant_id,
      ${order.keys},
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${participantName}) ORDER BY p.id) FROM participants p
        WHERE p.id IN (SELECT participant_id FROM expense_payers WHERE expense_id = e.id
          UNION SELECT participant_id FROM expense_shares WHERE expense_id = e.id)), '[]') AS people
    FROM expenses e
    JOIN ${myMemberships(data.principal.userId)} m ON m.group_id = e.group_id
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN private_contexts pc ON pc.group_id = g.id
    LEFT JOIN expenses ce ON ce.id = pc.expense_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${order.by}
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
      attribution: attributionOf({ events: r.events ?? [], viewer: data.principal.userId }),
    })),
    nextCursor: result.rows.length > limit && last ? { date: last.key_a, createdAt: last.key_b, id: last.id } : null,
  }
}

// ---------- options ----------

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
        FROM groups g JOIN ${myMemberships(me)} m ON m.group_id = g.id WHERE g.kind = 'named'), '[]'),
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
  role: Role
  viewer_participant_id: string | null
  g_name: string
  g_slug: string | null
  g_kind: GroupKind
  participants: { id: string; name: string }[]
  context_expense_id: string | null
  context_expense_title: string | null
  sums: BalanceSum[] | null
  invitations: { id: string; email: string; participantId: string; participantName: string; expiresAt: string }[] | null
}

/**
 * The expense page for any live expense the caller can see: the expense, its
 * group or private context with current names and, for a private context,
 * the repayments that settle it and (for its creator) its pending invitations.
 * Missing, deleted and inaccessible expenses look the same.
 */
export async function expenseContext(db: Db, data: { principal: Principal; expenseId: string }) {
  const result = await db.execute<ContextRow>(sql`
    SELECT ${expenseColumns({ attribution: true })},
      m.role, m.participant_id AS viewer_participant_id, g.name AS g_name, g.slug AS g_slug, g.kind AS g_kind,
      ${participantsJson(sql`g.id`)} AS participants,
      pc.expense_id AS context_expense_id, ce.title AS context_expense_title,
      CASE WHEN pc.group_id IS NOT NULL THEN ${balanceSums({ group: sql`g.id` })} END AS sums,
      CASE WHEN pc.group_id IS NOT NULL AND m.role = 'admin' THEN coalesce((
        SELECT json_agg(json_build_object('id', i.id, 'email', i.email, 'participantId', i.participant_id,
          'participantName', coalesce(i.participant_name, ip.name), 'expiresAt', ${iso(sql`i.expires_at`)}) ORDER BY i.created_at, i.id)
        FROM invitations i JOIN participants ip ON ip.id = i.participant_id
        WHERE i.group_id = g.id AND ${listedInvitation({ i: sql`i`, kind: sql`g.kind` })}), '[]') END AS invitations
    FROM expenses e
    JOIN ${myMemberships(data.principal.userId)} m ON m.group_id = e.group_id
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN private_contexts pc ON pc.group_id = g.id
    LEFT JOIN expenses ce ON ce.id = pc.expense_id
    WHERE e.id = ${data.expenseId} AND e.deleted_at IS NULL
  `)
  const r = result.rows[0]
  if (!r) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return {
    expense: toExpense(r),
    attribution: attributionOf({ events: r.events ?? [], viewer: data.principal.userId }),
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
            settlements: settlementsOf(r.sums ?? []),
            invitations: r.invitations ?? [],
          },
  }
}
