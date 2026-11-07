// Expense inputs in the two shapes the app takes: the web draft (ExpenseDraft)
// and the arguments of the MCP expense tools.
import type { ExpenseDraft } from '../../src/shared/expense-rules'

/** An even split of `amount` among `people`, paid by `payer`. Anything else may be overridden. */
export function draft(data: { payer: string; people: readonly string[] } & Partial<ExpenseDraft>): ExpenseDraft {
  const { payer, people, ...over } = data
  const amount = over.amount ?? '30.00'
  return {
    kind: 'expense',
    title: 'Groceries',
    vendor: null,
    notes: '',
    categoryId: 0,
    expenseDate: '2026-11-01',
    currency: 'USD',
    amount,
    payers: [{ participantId: payer, amount }],
    splitMode: 'evenly',
    shares: people.map((participantId) => ({ participantId, weight: '1' })),
    recurrence: 'none',
    ...over,
  }
}

/** The `expense` argument of create_expense: one share each for `people`, paid by `paidBy`. */
export function mcpExpense(data: { paidBy: string; people: readonly string[] } & Record<string, unknown>): Record<string, unknown> {
  const { paidBy, people, ...over } = data
  return {
    title: 'Dinner',
    expenseDate: '2026-11-01',
    amount: '30',
    currencyCode: 'USD',
    paidBy,
    paidFor: people.map((participant) => ({ participant, shares: '1' })),
    isReimbursement: false,
    ...over,
  }
}
