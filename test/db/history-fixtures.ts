// Synthetic history rows in the current app's format (schemaVersion 1), as the
// importer copies them. The shape follows src/lib/expense-history.ts
// makeExpenseSnapshot: Prisma's expense with decimal strings, stripped to the
// snapshot schema's keys.
import { activities, expensePayers, expenses, expenseShares } from '../../db/schema/app'
import type { Db } from '~/server/db'
import { randomId } from '~/server/ids'
import { minor } from '~/shared/minor'
import type { StoredActivitySource } from '~/shared/vocabulary'

export type V1Expense = {
  id: string
  groupId: string
  revision: number
  title: string
  vendor?: string | null
  amount: string
  currencyCode: string
  expenseDate: string
  createdAt: string
  categoryId: number
  category: { id: number; grouping: string; name: string } | null
  paidBy: { id: string; name: string }
  paidFor: { participantId: string; name: string; shares: string }[]
  splitMode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE' | 'BY_AMOUNT'
  isReimbursement: boolean
  notes: string | null
  recurrenceRule: 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | null
  originalAmount?: string | null
  originalCurrency?: string | null
  conversionRate?: string | null
  documents?: { id: string; url: string; width: number; height: number }[]
}

export const v1Snapshot = (e: V1Expense) => ({
  schemaVersion: 1,
  kind: 'expense',
  group: { id: e.groupId, name: 'Imported', slug: null, currency: '$', currencyCode: 'USD' },
  expense: {
    id: e.id,
    groupId: e.groupId,
    revision: e.revision,
    title: e.title,
    vendor: e.vendor ?? null,
    amount: e.amount,
    currencyCode: e.currencyCode,
    expenseDate: `${e.expenseDate}T00:00:00.000Z`,
    createdAt: e.createdAt,
    categoryId: e.categoryId,
    category: e.category,
    originalAmount: e.originalAmount ?? null,
    originalCurrency: e.originalCurrency ?? null,
    conversionRate: e.conversionRate ?? null,
    paidBy: e.paidBy,
    paidFor: [...e.paidFor].sort((a, b) => a.participantId.localeCompare(b.participantId)),
    splitMode: e.splitMode,
    isReimbursement: e.isReimbursement,
    notes: e.notes,
    recurrenceRule: e.recurrenceRule,
    documents: e.documents ?? [],
  },
})

export const v1GroupSnapshot = (g: { id: string; name: string; slug: string | null; information: string | null; participants: { id: string; name: string }[] }) => ({
  schemaVersion: 1,
  kind: 'group',
  group: { id: g.id, name: g.name, slug: g.slug, currency: '$', currencyCode: 'USD', information: g.information, revision: 0, participants: g.participants },
})

/**
 * An imported expense: the current row, then its v1 history rows, as the
 * importer writes them. `current` holds the live parts in minor units.
 */
export async function insertImportedExpense(
  tx: Db,
  data: {
    revisions: { snapshot: V1Expense; type: 'create_expense' | 'update_expense'; time: string; actorName?: string; actorUserId?: string; source?: StoredActivitySource }[]
    current: {
      kind: 'expense' | 'payment'
      amount: bigint
      splitMode: 'evenly' | 'shares' | 'percentage' | 'amount'
      payers: { participantId: string; amount: bigint }[]
      shares: { participantId: string; amount: bigint; weight: string }[]
    }
  },
) {
  const last = data.revisions.at(-1)?.snapshot
  if (!last) throw new Error('At least one revision')
  await tx.insert(expenses).values({
    id: last.id,
    groupId: last.groupId,
    revision: last.revision,
    kind: data.current.kind,
    title: last.title,
    vendor: last.vendor ?? null,
    notes: last.notes ?? '',
    categoryId: last.categoryId,
    expenseDate: last.expenseDate,
    currency: last.currencyCode,
    amount: minor(data.current.amount),
    splitMode: data.current.splitMode,
    createdAt: new Date(last.createdAt),
  })
  for (const r of data.revisions)
    await tx.insert(activities).values({
      id: randomId(),
      groupId: last.groupId,
      time: new Date(r.time),
      type: r.type,
      expenseId: last.id,
      expenseRevision: r.snapshot.revision,
      data: r.snapshot.title,
      snapshot: v1Snapshot(r.snapshot),
      source: r.source ?? 'web',
      actorName: r.actorName ?? null,
      actorUserId: r.actorUserId ?? null,
    })
  await tx.insert(expensePayers).values(data.current.payers.map((p) => ({ expenseId: last.id, groupId: last.groupId, participantId: p.participantId, amount: minor(p.amount) })))
  await tx.insert(expenseShares).values(data.current.shares.map((s) => ({ expenseId: last.id, groupId: last.groupId, participantId: s.participantId, amount: minor(s.amount), weight: s.weight })))
}
