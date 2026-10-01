import { getCurrency } from '@/lib/currency'
import type { ExpenseSnapshot } from '@/lib/expense-history'
import { getExpenseShares } from '@/lib/shares'
import { formatDecimal } from '@/lib/utils'

/** Presentation only: historical balances keep using the existing exact splitter. */
export function describeExpenseRevision(
  snapshot: ExpenseSnapshot,
  locale: string,
) {
  const { expense } = snapshot
  const money = (amount: string, code: string = expense.currencyCode) =>
    `${formatDecimal(new Intl.NumberFormat(locale, { minimumFractionDigits: getCurrency(code).decimal_digits, maximumFractionDigits: getCurrency(code).decimal_digits }), amount)} ${code}`
  const shares = getExpenseShares({ ...expense, paidById: expense.paidBy.id })
  return {
    title: expense.title,
    amount: money(expense.amount),
    date: expense.expenseDate.slice(0, 10),
    payer: expense.paidBy.name,
    splits: expense.paidFor
      .map(
        (person) =>
          `${person.name}: ${money(shares.get(person.participantId) ?? '0')} (share ${person.shares})`,
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
        : money(
            expense.originalAmount,
            expense.originalCurrency ?? expense.currencyCode,
          ),
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
