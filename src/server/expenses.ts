// Expense-area reads beyond the ledger core: categories, the detail of one
// expense for its edit screen, balances with suggested settlements, and the
// reference data agents discover. Each function checks access itself.
import { asc, sql } from 'drizzle-orm'
import { categories } from '../../db/schema/app'
import { NotFound } from '../shared/api'
import { suggestSettlements } from '../shared/balances'
import { CURRENCIES, type CurrencyCode } from '../shared/currencies'
import { FAIR_USE, FAIR_USE_LIMITS, LIMITS } from '../shared/limits'
import { formatMinor, minor } from '../shared/minor'
import { RECEIPT_CONTENT_TYPES, RECURRENCES, SPLIT_MODES, type ExpenseKind } from '../shared/vocabulary'
import type { Db } from './db'
import { memberCte, requireMember, type Principal } from './access'
import { loadExpenses, type StoredDocument } from './ledger'
import { receiptDownloadPath } from './receipts'
import { balancesOf, balanceSums, documentStatesJson, iso, type BalanceSum, type Tombstone } from './sql'

/** Every category, ordered by ID (P-EXP-102: the current app has no order). */
export async function listCategories(db: Db) {
  return db.select().from(categories).orderBy(asc(categories.id))
}

type DetailRow = {
  documents: (StoredDocument & { receiptId: string | null; deleted: Tombstone | null })[] | null
  added_at: string | null
  added_by: string | null
  edited_at: string | null
  edited_by: string | null
  my_last_edit: string | null
  next_date: string | null
}

/**
 * One live expense with its receipts, its attribution lines and its open
 * recurrence, for the edit screen (P-EXP-45, P-EXP-46).
 */
export async function getExpenseDetail(db: Db, data: { principal: Principal; group: string; expenseId: string }) {
  const { groupId } = await requireMember(db, data)
  const [expense] = await loadExpenses(db, [data.expenseId])
  if (!expense || expense.groupId !== groupId) throw new NotFound({ entity: 'expense', id: data.expenseId })
  const result = await db.execute<DetailRow & { deleted: boolean }>(sql`
    SELECT e.deleted_at IS NOT NULL AS deleted, ${documentStatesJson(sql`e`)} AS documents,
      (SELECT ${iso(sql`a.time`)} FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = 1) AS added_at,
      ${sql.raw('(SELECT CASE WHEN a.source = \'system\' AND a.actor_name IS NULL THEN \'Automatic recurrence\' ELSE a.actor_name END FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = 1)')} AS added_by,
      (SELECT ${iso(sql`a.time`)} FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = e.revision AND e.revision > 1 AND a.type = 'update_expense') AS edited_at,
      (SELECT a.actor_name FROM activities a WHERE a.expense_id = e.id AND a.expense_revision = e.revision AND e.revision > 1 AND a.type = 'update_expense') AS edited_by,
      (SELECT ${iso(sql`max(a.time)`)} FROM activities a WHERE a.expense_id = e.id AND a.actor_user_id = ${data.principal.userId}) AS my_last_edit,
      (SELECT l.next_expense_date::text FROM recurring_links l WHERE l.current_frame_expense_id = e.id AND l.next_expense_created_at IS NULL) AS next_date
    FROM expenses e WHERE e.id = ${data.expenseId}
  `)
  const [row] = result.rows
  if (!row || row.deleted) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return {
    expense,
    documents: (row.documents ?? []).map((d) => ({
      id: d.id,
      url: d.url,
      width: d.width,
      height: d.height,
      downloadUrl: receiptDownloadPath({ groupId, url: d.url }),
      deleted: d.deleted,
    })),
    added: row.added_at ? { at: row.added_at, by: row.added_by } : null,
    edited: row.edited_at ? { at: row.edited_at, by: row.edited_by } : null,
    myLastEdit: row.my_last_edit,
    nextOccurrence: row.next_date,
  }
}

/** Where an expense lives, for any group the caller can access (P-EXP-142). */
export async function getExpenseContext(db: Db, data: { principal: Principal; expenseId: string }) {
  const result = await db.execute<{ group_id: string; slug: string | null; kind: ExpenseKind; title: string }>(sql`
    SELECT e.group_id, g.slug, e.kind, e.title FROM expenses e
    JOIN groups g ON g.id = e.group_id
    JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId} AND m.active
    WHERE e.id = ${data.expenseId} AND e.deleted_at IS NULL
  `)
  const [row] = result.rows
  if (!row) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return { groupId: row.group_id, slug: row.slug, kind: row.kind, title: row.title }
}

/**
 * Balances and suggested settlements per currency, from live expenses only,
 * in one statement that also checks membership (P-BAL-01..22, P-BAL-24, P-BAL-26).
 * Every participant of the group is listed in each currency, at zero when
 * they have no part in it (P-BAL-44).
 */
export async function listBalances(db: Db, data: { principal: Principal; group: string; currency?: CurrencyCode }) {
  const result = await db.execute<{ active: boolean; participants: string[]; sums: BalanceSum[] }>(sql`
    WITH ${memberCte(data)}
    SELECT g.active,
      coalesce((SELECT json_agg(p.id ORDER BY p.name, p.id) FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
      ${balanceSums({ group: sql`g.id`, ...(data.currency ? { where: sql`x.currency = ${data.currency}` } : {}) })} AS sums
    FROM g
  `)
  const [row] = result.rows
  if (!row?.active) await requireMember(db, data)
  const balances = balancesOf(row?.sums ?? [])
  const zero = { paid: minor(0n), owed: minor(0n), net: minor(0n) }
  return {
    currencies: [...balances].map(([currency, byPerson]) => {
      const text = (amount: bigint) => formatMinor({ amount: minor(amount), currency })
      return {
        currency,
        balances: (row?.participants ?? []).map((participantId) => {
          const b = byPerson.get(participantId) ?? zero
          return { participantId, paid: text(b.paid), owed: text(b.owed), net: text(b.net) }
        }),
        settlements: suggestSettlements(byPerson).map((s) => ({ from: s.from, to: s.to, amount: text(s.amount) })),
      }
    }),
  }
}

/** What an agent or the form needs to know to write an expense (P-EXP-143). Receipts are always on. */
export async function getReference(db: Db) {
  return {
    categories: await listCategories(db),
    currencies: (Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => ({ code, ...CURRENCIES[code] })),
    splitModes: SPLIT_MODES,
    recurrence: RECURRENCES,
    attachments: { enabled: true, contentTypes: RECEIPT_CONTENT_TYPES, maxBytes: LIMITS.receiptBytes },
    limits: { ...FAIR_USE_LIMITS, fairUse: FAIR_USE },
  }
}
