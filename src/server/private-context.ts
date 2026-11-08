// The write rules of a private context, the hidden group of one ungrouped
// expense (src/server/ungrouped.ts). Every expense write (ledger.ts) checks
// them before it changes anything; the triggers of
// db/migrations/0005_private_contexts.sql enforce the same rules.
import { sql, type SQL } from 'drizzle-orm'
import { Invalid } from '../shared/api'
import { privatePeopleIssue, type ExpenseDraft } from '../shared/expense-rules'

type PrivateWrite = { readonly op: 'create' | 'update'; readonly draft: ExpenseDraft } | { readonly op: 'delete' }

/** The facts of a private context that its write rules need. */
export type PrivateContext = { expense_id: string; people: string[]; original_live: boolean; live_payments: number }

/**
 * The private context of group `groupId` as one JSON value, or null for a
 * named group. The expense write context (ledger.ts) reads it in the same
 * statement as the membership and the expense.
 */
export const privateContextOf = (groupId: SQL) => sql`(
  SELECT json_build_object('expense_id', pc.expense_id,
    'people', coalesce((SELECT json_agg(pp.participant_id) FROM private_people pp WHERE pp.group_id = pc.group_id), '[]'),
    'original_live', EXISTS (SELECT 1 FROM expenses o WHERE o.id = pc.expense_id AND o.deleted_at IS NULL),
    'live_payments', (SELECT count(*)::int FROM expenses x WHERE x.group_id = pc.group_id AND x.id <> pc.expense_id AND x.deleted_at IS NULL))
  FROM private_contexts pc WHERE pc.group_id = ${groupId})`

/**
 * The write rules inside a private context, checked by every expense write
 * (ledger.ts) before it changes anything. A named group passes unchanged.
 */
export function assertPrivateWrite(context: PrivateContext | null, data: { expenseId: string } & PrivateWrite) {
  if (!context) return
  const original = data.expenseId === context.expense_id
  if (data.op === 'delete') {
    if (original && context.live_payments > 0)
      throw new Invalid({ message: 'Remove this expense’s recorded repayments before deleting the expense.', reason: 'state' })
    return
  }
  const { draft } = data
  if (draft.recurrence !== 'none') throw new Invalid({ message: 'Ungrouped expenses do not recur.', field: 'recurrence' })
  if (original && draft.kind === 'payment') throw new Invalid({ message: 'Record repayments separately from the original expense.', field: 'kind' })
  if (!original && draft.kind !== 'payment') throw new Invalid({ message: 'Create a separate ungrouped expense for a new purchase.', field: 'kind' })
  if (draft.kind === 'expense') {
    const message = privatePeopleIssue({ op: data.op, draft, people: context.people })
    if (message) throw new Invalid({ message, field: data.op === 'create' ? 'people' : 'shares' })
  } else if (data.op === 'create' && !context.original_live) {
    throw new Invalid({ message: 'Cannot record a repayment for a deleted expense.' })
  }
}
