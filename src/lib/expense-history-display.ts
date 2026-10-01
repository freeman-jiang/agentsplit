import { getCurrency } from '@/lib/currency'
import type { ExpenseSnapshot } from '@/lib/expense-history'
import { getExpenseShares } from '@/lib/shares'

/** Presentation only: historical balances keep using the existing exact splitter. */
export function describeExpenseRevision(
  snapshot: ExpenseSnapshot,
  locale: string,
) {
  const { expense, group } = snapshot
  const money = (amount: number, code = group.currencyCode) => {
    const digits = getCurrency(code).decimal_digits
    return `${(amount / 10 ** digits).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${code ?? group.currency}`
  }
  const shares = getExpenseShares(expense)
  return {
    title: expense.title,
    amount: money(expense.amount),
    date: expense.expenseDate.slice(0, 10),
    payer: expense.paidBy.name,
    splits: expense.paidFor
      .map(
        (person) =>
          `${person.name}: ${money(shares.get(person.participantId) ?? 0)} (share ${person.shares})`,
      )
      .join('\n'),
    splitMode: {
      EVENLY: 'Evenly',
      BY_SHARES: 'By shares',
      BY_PERCENTAGE: 'By percentage',
      BY_AMOUNT: 'By amount',
    }[expense.splitMode],
    reimbursement: expense.isReimbursement ? 'Yes' : 'No',
    category: expense.category?.name ?? '',
    originalAmount:
      expense.originalAmount === null
        ? ''
        : money(expense.originalAmount, expense.originalCurrency),
    conversionRate: expense.conversionRate ?? '',
    recurrence: {
      NONE: 'None',
      DAILY: 'Daily',
      WEEKLY: 'Weekly',
      MONTHLY: 'Monthly',
    }[expense.recurrenceRule ?? 'NONE'],
    notes: expense.notes ?? '',
    attachments: expense.documents
      .map((document) => document.url)
      .sort()
      .join('\n'),
  }
}
