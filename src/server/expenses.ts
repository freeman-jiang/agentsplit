// Expense-area reads beyond the ledger core: categories, the detail of one
// expense for its edit screen, where an expense lives, and the reference data
// agents discover. Each function checks access itself.
import { asc, sql } from 'drizzle-orm'
import { categories } from '../../db/schema/app'
import { NotFound } from '../shared/api'
import { CURRENCIES, type CurrencyCode } from '../shared/currencies'
import { FAIR_USE, FAIR_USE_LIMITS, LIMITS } from '../shared/limits'
import { receiptDownloadPath } from '../shared/paths'
import { RECEIPT_CONTENT_TYPES, RECURRENCES, SPLIT_MODES, type ExpenseKind } from '../shared/vocabulary'
import { myMemberships, requireMember, type Principal } from './core/access'
import type { Db } from './core/db'
import { expenseColumns, toExpense, type ExpenseRow } from './expense-read'
import { iso } from './sql'

/** Every category, ordered by ID (P-EXP-102: the current app has no order). */
export async function listCategories(db: Db) {
  return db.select().from(categories).orderBy(asc(categories.id))
}

/**
 * One live expense with its receipts, its attribution lines and its open
 * recurrence, for the edit screen (P-EXP-45, P-EXP-46).
 */
export async function getExpenseDetail(db: Db, data: { principal: Principal; groupId: string; expenseId: string }) {
  const { groupId } = await requireMember(db, data)
  const result = await db.execute<ExpenseRow & { my_last_edit: string | null }>(sql`
    SELECT ${expenseColumns({ documents: true })},
      (SELECT ${iso(sql`max(a.time)`)} FROM activities a WHERE a.expense_id = e.id AND a.actor_user_id = ${data.principal.userId}) AS my_last_edit
    FROM expenses e WHERE e.id = ${data.expenseId} AND e.group_id = ${groupId}
  `)
  const [row] = result.rows
  if (!row || row.deleted) throw new NotFound({ entity: 'expense', id: data.expenseId })
  const expense = toExpense(row)
  const open = expense.link && expense.link.nextExpenseCreatedAt === null ? expense.link : null
  return {
    expense,
    documents: (expense.documents ?? []).map((d) => ({
      id: d.id,
      url: d.url,
      width: d.width,
      height: d.height,
      downloadUrl: receiptDownloadPath({ groupId, url: d.url }),
      deleted: d.deleted,
    })),
    added: expense.addedAt ? { at: expense.addedAt, by: expense.addedBy } : null,
    edited: expense.editedAt ? { at: expense.editedAt, by: expense.editedBy } : null,
    myLastEdit: row.my_last_edit,
    nextOccurrence: open?.nextExpenseDate ?? null,
  }
}

/** Where an expense lives, for any group the caller can access (P-EXP-142). */
export async function getExpenseContext(db: Db, data: { principal: Principal; expenseId: string }) {
  const result = await db.execute<{ group_id: string; slug: string | null; kind: ExpenseKind; title: string }>(sql`
    SELECT e.group_id, g.slug, e.kind, e.title FROM expenses e
    JOIN groups g ON g.id = e.group_id
    JOIN ${myMemberships(data.principal.userId)} m ON m.group_id = g.id
    WHERE e.id = ${data.expenseId} AND e.deleted_at IS NULL
  `)
  const [row] = result.rows
  if (!row) throw new NotFound({ entity: 'expense', id: data.expenseId })
  return { groupId: row.group_id, slug: row.slug, kind: row.kind, title: row.title }
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
