export function expenseTitle(expense: {
  title: string
  vendor?: string | null
}) {
  return expense.vendor ? `${expense.vendor} — ${expense.title}` : expense.title
}
