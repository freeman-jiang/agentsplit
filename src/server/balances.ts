// Balances: a group's balances and suggested repayments, the caller's own net
// across every group (the dashboard and the groups directory), and balances
// as of a recorded change. Only live expenses count; reads never create due
// recurring expenses (P-BAL-30).
import { sql, type SQL } from 'drizzle-orm'
import { groupAccessDenied, Invalid } from '../shared/api'
import { computeBalances, suggestSettlements, type Balance } from '../shared/balances'
import type { CurrencyCode } from '../shared/currencies'
import { compareIds } from '../shared/ids'
import { formatMinor, minor } from '../shared/minor'
import { savedEntry } from '../shared/snapshots'
import type { GroupKind } from '../shared/vocabulary'
import { groupIdOf, groupRef, memberCte, myMemberships, requireActive, type Principal } from './core/access'
import type { Db } from './core/db'
import { historicalLedger, type Boundary } from './history'
import { displayNames, participantName } from './people'

export type BalanceSum = { currency: CurrencyCode; participantId: string; paid: string; owed: string }

/**
 * What a balance counts: the payers and shares of live expenses, summed per
 * group, participant and currency. Triggers keep these sums in balance_totals
 * with every write of a payer or share row (db/migrations/0020), and a row
 * exists there while it counts at least one payer or share; balances read
 * that table. This is the same sum over the rows themselves, as balances read
 * it before, from each expense's own currency and deleted_at: the invariant
 * check (balanceDrift) compares the two.
 */
const ledgerRecompute = (group?: SQL) => {
  const where = group ? sql`WHERE group_id = ${group}` : sql``
  return sql`(
    SELECT parts.group_id, parts.participant_id, x.currency, sum(parts.paid)::bigint AS paid, sum(parts.owed)::bigint AS owed, count(*)::integer AS parts FROM (
      SELECT expense_id, group_id, participant_id, amount AS paid, 0::bigint AS owed FROM expense_payers ${where}
      UNION ALL
      SELECT expense_id, group_id, participant_id, 0::bigint, amount FROM expense_shares ${where}
    ) parts JOIN expenses x ON x.id = parts.expense_id AND x.deleted_at IS NULL
    GROUP BY parts.group_id, parts.participant_id, x.currency)`
}

/** A sum per group, participant and currency where balance_totals and the payer and share rows disagree. Sums are minor units as text; null means no row. */
export type BalanceDrift = {
  groupId: string
  participantId: string
  currency: string
  stored: { paid: string; owed: string; parts: number } | null
  counted: { paid: string; owed: string; parts: number } | null
}

/**
 * Every sum where balance_totals differs from the payer and share rows, in
 * `groupId` or in every group. Empty when the running balances are right.
 * It reads every payer and share row it checks, so it is for tests and the
 * maintainer's check (scripts/check-balances.ts), never a request.
 */
export async function balanceDrift(db: Db, data: { groupId?: string } = {}): Promise<BalanceDrift[]> {
  const group = data.groupId === undefined ? undefined : sql`${data.groupId}`
  const result = await db.execute<BalanceDrift>(sql`
    SELECT coalesce(t.group_id, r.group_id) AS "groupId", coalesce(t.participant_id, r.participant_id) AS "participantId", coalesce(t.currency, r.currency) AS currency,
      CASE WHEN t.group_id IS NULL THEN NULL ELSE json_build_object('paid', t.paid::text, 'owed', t.owed::text, 'parts', t.parts) END AS stored,
      CASE WHEN r.group_id IS NULL THEN NULL ELSE json_build_object('paid', r.paid::text, 'owed', r.owed::text, 'parts', r.parts) END AS counted
    FROM (SELECT * FROM balance_totals ${group ? sql`WHERE group_id = ${group}` : sql``}) t
    FULL JOIN ${ledgerRecompute(group)} r ON r.group_id = t.group_id AND r.participant_id = t.participant_id AND r.currency = t.currency
    WHERE (t.paid, t.owed, t.parts) IS DISTINCT FROM (r.paid, r.owed, r.parts)
    ORDER BY 1, 2, 3
  `)
  return result.rows
}

/**
 * Each participant's paid and owed sums per currency in group `group`, as a
 * JSON array of BalanceSum. Minor units travel as text. `currency` keeps one currency.
 */
export const balanceSums = (data: { group: SQL; currency?: CurrencyCode | undefined }) => sql`coalesce((SELECT json_agg(json_build_object('currency', t.currency, 'participantId', t.participant_id, 'paid', t.paid::text, 'owed', t.owed::text))
  FROM balance_totals t
  WHERE t.group_id = ${data.group} ${data.currency ? sql`AND t.currency = ${data.currency}` : sql``}), '[]')`

/** Balances per currency and person from balanceSums, with the zero-sum check of computeBalances. */
const balancesOf = (sums: readonly BalanceSum[]) =>
  computeBalances(
    sums.map((s) => ({
      currency: s.currency,
      payers: new Map([[s.participantId, minor(BigInt(s.paid))]]),
      shares: new Map([[s.participantId, minor(BigInt(s.owed))]]),
    })),
  )

const transfersOf = (data: { currency: CurrencyCode; byPerson: ReadonlyMap<string, Balance> }) =>
  suggestSettlements(data.byPerson).map((t) => ({ from: t.from, to: t.to, amount: formatMinor({ amount: t.amount, currency: data.currency }) }))

/** Suggested repayments per currency, from balanceSums. */
export const settlementsOf = (sums: readonly BalanceSum[]) =>
  [...balancesOf(sums)].map(([currency, byPerson]) => ({ currency, transfers: transfersOf({ currency, byPerson }) }))

/**
 * The caller's net per group, currency and participant, as the CTE
 * `nets(group_id, currency, participant_id, net)`: what the caller's
 * participant paid minus their share; and their sum per currency, as the CTE
 * `totals(currency, net)`. It reads the CTE `mine` of (group_id,
 * participant_id) rows; a row without a participant counts nothing.
 */
export const netsCte = sql`nets AS (
  SELECT t.group_id, t.currency, t.participant_id, t.paid - t.owed AS net
  FROM mine JOIN balance_totals t ON t.group_id = mine.group_id AND t.participant_id = mine.participant_id
),
totals AS (SELECT currency, sum(net) AS net FROM nets GROUP BY currency)`

/** The CTE `totals` as a JSON array of `{currency, net}`, by currency code. */
export const totalsJson = sql`coalesce((SELECT json_agg(json_build_object('currency', currency, 'net', net::text) ORDER BY currency COLLATE "C") FROM totals), '[]')`

// ---------- one group ----------

/** Every participant of the group, by display name, and the balances per currency, in one statement that also checks membership. */
export async function groupBalances(db: Db, data: { principal: Principal; groupId: string; currency?: CurrencyCode | undefined }) {
  const result = await db.execute<{ active: boolean; participants: string[]; sums: BalanceSum[] }>(sql`
    WITH ${memberCte(data)}
    SELECT g.active,
      coalesce((SELECT json_agg(p.id ORDER BY p.name, p.id) FROM (${displayNames(sql`g.id`)}) p), '[]') AS participants,
      ${balanceSums({ group: sql`g.id`, currency: data.currency })} AS sums
    FROM g
  `)
  const row = requireActive(result.rows[0])
  return { participants: row.participants, balances: balancesOf(row.sums) }
}

/**
 * Balances and suggested settlements per currency (P-BAL-01..22, P-BAL-24,
 * P-BAL-26). Every participant of the group is listed in each currency, at
 * zero when they have no part in it (P-BAL-44).
 */
export async function listBalances(db: Db, data: { principal: Principal; groupId: string; currency?: CurrencyCode }) {
  const { participants, balances } = await groupBalances(db, data)
  const zero = { paid: minor(0n), owed: minor(0n), net: minor(0n) }
  return {
    currencies: [...balances].map(([currency, byPerson]) => {
      const text = (amount: bigint) => formatMinor({ amount: minor(amount), currency })
      return {
        currency,
        balances: participants.map((participantId) => {
          const b = byPerson.get(participantId) ?? zero
          return { participantId, paid: text(b.paid), owed: text(b.owed), net: text(b.net) }
        }),
        settlements: transfersOf({ currency, byPerson }),
      }
    }),
  }
}

// ---------- the caller across groups ----------

type NetTotal = { currency: CurrencyCode; net: string }

/** The rows of totalsJson, each net formatted in its currency. */
export const formatTotals = (totals: readonly NetTotal[]) => totals.map((t) => ({ currency: t.currency, net: formatMinor({ amount: minor(BigInt(t.net)), currency: t.currency }) }))

type AccountRow = {
  rows: { groupId: string; groupName: string; kind: GroupKind; currency: CurrencyCode; participantId: string; participantName: string; amount: string }[]
  totals: NetTotal[]
  unbound: string[]
  denied: string[]
  foreign: string[]
}

/** Groups or contexts to include, each with an optional participant to inspect instead of the caller's own. */
export type BalanceScope = ReadonlyArray<{ readonly groupId: string; readonly participantId?: string | undefined }>

/**
 * The caller's own balance in every named group and private context with
 * active access, per currency, and the totals per currency. Groups without a
 * linked participant are listed instead of counted.
 *
 * A scope (MCP get_participant_balances) limits the groups and may name
 * another participant of a group. A group outside the caller's access fails
 * the whole read, as does a participant from another group.
 */
export async function accountBalances(db: Db, data: { principal: Principal; scope?: BalanceScope }) {
  const scope = data.scope ? JSON.stringify(data.scope.map((s) => ({ ref: groupRef(s.groupId), participant_id: s.participantId ?? null }))) : null
  const result = await db.execute<{ result: AccountRow }>(sql`
    WITH s AS (SELECT DISTINCT ${groupIdOf(sql`s.ref`)} AS group_id, s.participant_id FROM json_to_recordset(${scope ?? '[]'}::json) AS s(ref text, participant_id text)),
    mine AS (
      SELECT m.group_id, ${scope ? sql`coalesce(s.participant_id, m.participant_id)` : sql`m.participant_id`} AS participant_id
      FROM ${myMemberships(data.principal.userId)} m ${scope ? sql`JOIN s ON s.group_id = m.group_id` : sql``}
    ),
    ${netsCte}
    SELECT json_build_object(
      'rows', coalesce((SELECT json_agg(json_build_object('groupId', g.id, 'groupName', g.name, 'kind', g.kind, 'currency', n.currency,
          'participantId', p.id, 'participantName', ${participantName}, 'amount', n.net::text) ORDER BY g.name, g.id, n.currency)
        FROM nets n JOIN groups g ON g.id = n.group_id JOIN participants p ON p.id = n.participant_id), '[]'),
      'totals', ${totalsJson},
      'unbound', coalesce((SELECT json_agg(group_id) FROM mine WHERE participant_id IS NULL), '[]'),
      'denied', coalesce((SELECT json_agg(s.group_id) FROM s WHERE NOT EXISTS (SELECT 1 FROM mine WHERE mine.group_id = s.group_id)), '[]'),
      'foreign', coalesce((SELECT json_agg(s.group_id) FROM s WHERE s.participant_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = s.participant_id AND p.group_id = s.group_id)), '[]')
    ) AS result
  `)
  const row = result.rows[0]?.result ?? { rows: [], totals: [], unbound: [], denied: [], foreign: [] }
  if (row.denied.length) throw groupAccessDenied()
  if (row.foreign.length) throw new Invalid({ message: 'Participant does not belong to this group.', field: 'participantId' })
  return {
    balances: row.rows.map((r) => ({ ...r, amount: formatMinor({ amount: minor(BigInt(r.amount)), currency: r.currency }) })),
    totals: formatTotals(row.totals),
    unboundGroupIds: [...row.unbound].sort(compareIds),
  }
}

// ---------- as of a recorded change ----------

/** The answer for a boundary with expenses that have no saved state there. MCP adds where an agent reads them. */
const INCOMPLETE_HISTORY = 'Historical balances are unavailable because some expenses have no saved state at this point.'

/**
 * Balances from the saved splits at a boundary, per currency and participant.
 * When some expenses have no saved state at the boundary, it refuses with a
 * precondition Invalid, so a partial total is never shown as a balance.
 */
export async function historicalBalances(db: Db, data: { principal: Principal; groupId: string; currency?: CurrencyCode | undefined } & Boundary) {
  const ledger = await historicalLedger(db, data)
  if (!ledger.history.complete) throw new Invalid({ message: INCOMPLETE_HISTORY, reason: 'precondition' })
  const saved = ledger.expenses.filter((e) => data.currency === undefined || e.currency === data.currency)
  return { history: ledger.history, balances: computeBalances(saved.map(savedEntry)) }
}

/** historicalBalances for the web: one row per participant and currency. */
export async function savedBalances(db: Db, data: { principal: Principal; groupId: string } & Boundary) {
  const { history, balances } = await historicalBalances(db, data)
  return {
    history,
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
