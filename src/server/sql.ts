// SQL fragments shared by the server's reads and the MCP tools. A separate module, because the
// ledger and the feed import each other indirectly (ledger → ungrouped → feed).
import { sql, type SQL } from 'drizzle-orm'
import { computeBalances } from '../shared/balances'
import type { CurrencyCode } from '../shared/currencies'
import { formatMinor, minor } from '../shared/minor'

/** The name to show for the author of an activity row `a`. */
export const actorName = sql.raw(`CASE WHEN a.source = 'system' AND a.actor_name IS NULL THEN 'Automatic recurrence' ELSE a.actor_name END`)

/**
 * The source of activity row `alias` as it is shown and exported. Agent writes
 * are `agent`, as in the current app and the imported history. Rows that v2
 * wrote before this rule have `mcp`, and activities are permanent, so the
 * readers rename them (DECISIONS.md, parity audit, P-DB-79).
 */
export const activitySource = (alias: SQL) => sql`CASE WHEN ${alias}.source = 'mcp' THEN 'agent' ELSE ${alias}.source END`

/**
 * Is activity row `alias` a real create or edit? A baseline is not: the
 * current app stores it with source `baseline`, v2 with revision 0 (P-HIST-09).
 */
export const notBaseline = (alias: SQL) => sql`${alias}.source <> 'baseline' AND (${alias}.expense_revision IS NULL OR ${alias}.expense_revision > 0)`

/** "<vendor> — <title>" of an expense snapshot, as titleWithVendor makes it. */
const snapshotTitle = (snapshot: SQL) => sql`CASE WHEN coalesce(${snapshot}->'expense'->>'vendor', '') <> ''
  THEN (${snapshot}->'expense'->>'vendor') || ' — ' || (${snapshot}->'expense'->>'title')
  ELSE ${snapshot}->'expense'->>'title' END`

/**
 * The text of activity row `alias`. An expense event stores "<vendor> — <title>"
 * (titleWithVendor). v2 rows from before this rule have none, so the text
 * comes from the last saved snapshot at that event (P-EXP-107). That is the
 * row's own snapshot when it has one, so only a row without one looks back.
 */
export const activityData = (alias: SQL) => sql`CASE WHEN ${alias}.data IS NOT NULL OR ${alias}.expense_id IS NULL THEN ${alias}.data
  WHEN ${alias}.snapshot IS NOT NULL THEN ${snapshotTitle(sql`${alias}.snapshot`)}
  ELSE (SELECT ${snapshotTitle(sql`s.snapshot`)}
    FROM activities s WHERE s.group_id = ${alias}.group_id AND s.expense_id = ${alias}.expense_id AND s.sequence <= ${alias}.sequence AND s.snapshot IS NOT NULL
    ORDER BY s.sequence DESC LIMIT 1) END`

/**
 * The receipts of expense row `expense` as a JSON array, in their saved order,
 * or NULL when it has none. Each caller decides what to show for none.
 */
export const documentsJson = (expense: SQL) => sql`(SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height) ORDER BY d.position)
  FROM expense_documents d WHERE d.expense_id = ${expense}.id)`

/** A timestamp as ISO 8601 text in UTC, with milliseconds. */
export const iso = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/** The named groups that `userId` created, from their create_group activities (LIMITS.groupsCreated). Groups are never deleted. */
export const groupsCreated = (userId: string) => sql`(SELECT count(*)::int FROM activities a JOIN groups g ON g.id = a.group_id AND g.kind = 'named'
  WHERE a.type = 'create_group' AND a.actor_user_id = ${userId})`

/** Who deleted a receipt and when, as readers show it in place of the image. */
export type Tombstone = { by: string; at: string }

/**
 * The deleted receipts of group `group` as one JSON object, receipt URL →
 * Tombstone, or NULL when none is deleted. History snapshots name receipts by
 * URL, so readers look each one up here.
 */
export const tombstonesJson = (group: SQL) => sql`(SELECT json_object_agg(r.url, json_build_object('by', u.name, 'at', ${iso(sql`d.deleted_at`)}))
  FROM deleted_receipts d JOIN receipts r ON r.id = d.receipt_id JOIN "user" u ON u.id = d.deleted_by
  WHERE r.group_id = ${group})`

/**
 * The receipts of expense row `expense` as documentsJson gives them, each with
 * its receipt ID (null for a legacy pointer without a receipt row) and its
 * tombstone (null unless deleted), or NULL when it has none.
 */
export const documentStatesJson = (expense: SQL) => sql`(SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height,
    'receiptId', r.id, 'deleted', CASE WHEN dr.receipt_id IS NULL THEN NULL ELSE json_build_object('by', du.name, 'at', ${iso(sql`dr.deleted_at`)}) END) ORDER BY d.position)
  FROM expense_documents d
  LEFT JOIN receipts r ON r.group_id = ${expense}.group_id AND r.url = d.url
  LEFT JOIN deleted_receipts dr ON dr.receipt_id = r.id
  LEFT JOIN "user" du ON du.id = dr.deleted_by
  WHERE d.expense_id = ${expense}.id)`

/** A LIKE pattern that matches `text` anywhere, with its \, % and _ taken literally. */
export const escapeLike = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Is expense `e` paid for or shared by participant `who`? */
export const involves = (who: SQL) => sql`(EXISTS (SELECT 1 FROM expense_payers ip WHERE ip.expense_id = e.id AND ip.participant_id = ${who})
  OR EXISTS (SELECT 1 FROM expense_shares iss WHERE iss.expense_id = e.id AND iss.participant_id = ${who}))`

/**
 * The name to show for a participant: the bound, verified account's current
 * name, else `name`, the participant's own name, as in the current app
 * (P-GROUP-55). The group filter lets the (group_id, participant_id) unique
 * index find the membership.
 */
export const displayName = (data: { group: SQL; participant: SQL; name: SQL }) => sql`coalesce(
  (SELECT bu.name FROM memberships bm JOIN "user" bu ON bu.id = bm.user_id AND bu.email_verified
    WHERE bm.group_id = ${data.group} AND bm.participant_id = ${data.participant}),
  ${data.name})`

export type BalanceSum = { currency: string; participantId: string; paid: string; owed: string }

/**
 * Each participant's paid and owed sums per currency over the live expenses
 * of group `group`, as a JSON array of BalanceSum. Minor units travel as text.
 * `where` adds a condition on the expense row `x`.
 */
export const balanceSums = (data: { group: SQL; where?: SQL }) => sql`coalesce((SELECT json_agg(json_build_object('currency', s.currency, 'participantId', s.participant_id, 'paid', s.paid::text, 'owed', s.owed::text))
  FROM (
    SELECT x.currency, parts.participant_id, sum(parts.paid) AS paid, sum(parts.owed) AS owed
    FROM expenses x
    JOIN (
      SELECT expense_id, participant_id, amount AS paid, 0::bigint AS owed FROM expense_payers WHERE group_id = ${data.group}
      UNION ALL
      SELECT expense_id, participant_id, 0::bigint, amount FROM expense_shares WHERE group_id = ${data.group}
    ) parts ON parts.expense_id = x.id
    WHERE x.group_id = ${data.group} AND x.deleted_at IS NULL ${data.where ? sql`AND ${data.where}` : sql``}
    GROUP BY x.currency, parts.participant_id
  ) s), '[]')`

/** Balances per currency and person from balanceSums, with the zero-sum check of computeBalances. */
export const balancesOf = (sums: readonly BalanceSum[]) =>
  computeBalances(
    sums.map((s) => ({
      currency: s.currency as CurrencyCode,
      payers: new Map([[s.participantId, minor(BigInt(s.paid))]]),
      shares: new Map([[s.participantId, minor(BigInt(s.owed))]]),
    })),
  )

/**
 * An expense row `e` with its payers, shares, document count and authors, for
 * the group lists (ledger.ts) and the feed (feed.ts), so both have one shape.
 * PostgreSQL builds each row's parts as JSON, so the server parses one value
 * per row instead of several result sets. Minor units travel as text.
 */
export const expenseColumns = sql`e.id, e.group_id, e.revision, e.kind, e.title, e.vendor, e.notes, e.category_id,
  e.expense_date::text AS expense_date, e.currency, e.amount::text AS amount, e.split_mode, e.recurrence,
  ${iso(sql`e.created_at`)} AS created_at, ${iso(sql`e.updated_at`)} AS updated_at,
  coalesce((SELECT json_agg(json_build_object('participantId', p.participant_id, 'amount', p.amount::text) ORDER BY p.participant_id)
    FROM expense_payers p WHERE p.expense_id = e.id), '[]') AS payers,
  coalesce((SELECT json_agg(json_build_object('participantId', s.participant_id, 'amount', s.amount::text, 'weight', s.weight) ORDER BY s.participant_id)
    FROM expense_shares s WHERE s.expense_id = e.id), '[]') AS shares,
  (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id) AS document_count,
  (SELECT ${actorName} FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = 1) AS added_by,
  (SELECT ${actorName} FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = e.revision AND e.revision > 1 AND a.type = 'update_expense') AS edited_by`

export type ExpenseRow = {
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
  payers: { participantId: string; amount: string }[]
  shares: { participantId: string; amount: string; weight: string }[]
  document_count: number
  added_by: string | null
  edited_by: string | null
}

export function toExpense(e: ExpenseRow) {
  const currency = e.currency as CurrencyCode
  const money = (amount: string) => formatMinor({ amount: minor(BigInt(amount)), currency })
  return {
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
    addedBy: e.added_by,
    editedBy: e.edited_by,
  }
}
