import { Participant } from '@/generated/prisma/browser'
import { getGroupExpenses } from '@/lib/api'
import { getExpenseShares } from '@/lib/shares'
import { add, Decimal, subtract } from './money'

export type Balances = Record<
  Participant['id'],
  { paid: string; paidFor: string; total: string }
>
export type Reimbursement = {
  from: Participant['id']
  to: Participant['id']
  amount: string
}
const zero = () => ({ paid: '0', paidFor: '0', total: '0' })

export function groupExpensesByCurrency<T extends { currencyCode: string }>(
  expenses: readonly T[],
) {
  const grouped = new Map<string, T[]>()
  for (const expense of expenses) {
    const rows = grouped.get(expense.currencyCode) ?? []
    rows.push(expense)
    grouped.set(expense.currencyCode, rows)
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, expenses]) => ({ currencyCode, expenses }))
}

export function getBalances(
  expenses: Awaited<ReturnType<typeof getGroupExpenses>>,
): Balances {
  if (new Set(expenses.map((expense) => expense.currencyCode)).size > 1)
    throw new Error('Balances must be calculated separately per currency')
  const balances: Balances = {}
  for (const expense of expenses) {
    const paidBy = expense.paidBy.id
    balances[paidBy] ??= zero()
    balances[paidBy].paid = add(balances[paidBy].paid, expense.amount)
    const shares = getExpenseShares({
      id: expense.id,
      paidById: expense.paidBy.id,
      amount: expense.amount,
      currencyCode: expense.currencyCode,
      splitMode: expense.splitMode,
      paidFor: expense.paidFor.map(({ participant, shares }) => ({
        participantId: participant.id,
        shares,
      })),
    })
    for (const [person, amount] of shares) {
      balances[person] ??= zero()
      balances[person].paidFor = add(balances[person].paidFor, amount)
    }
  }
  for (const balance of Object.values(balances))
    balance.total = subtract(balance.paid, balance.paidFor)
  return balances
}

export function getPublicBalances(reimbursements: Reimbursement[]): Balances {
  const balances: Balances = {}
  for (const { from, to, amount } of reimbursements) {
    balances[from] ??= zero()
    balances[to] ??= zero()
    balances[from].paidFor = add(balances[from].paidFor, amount)
    balances[from].total = subtract(balances[from].total, amount)
    balances[to].paid = add(balances[to].paid, amount)
    balances[to].total = add(balances[to].total, amount)
  }
  return balances
}

/** Keep repayment suggestions stable across settlements. */
export function getSuggestedReimbursements(
  balances: Balances,
): Reimbursement[] {
  const rows = Object.entries(balances)
    .map(([participantId, { total }]) => ({
      participantId,
      total: new Decimal(total),
    }))
    .filter((row) => !row.total.isZero())
  rows.sort((a, b) =>
    a.total.isPositive() !== b.total.isPositive()
      ? a.total.isPositive()
        ? -1
        : 1
      : a.participantId.localeCompare(b.participantId),
  )
  const result: Reimbursement[] = []
  while (rows.length > 1) {
    const first = rows[0],
      last = rows[rows.length - 1]
    const amount = Decimal.min(first.total, last.total.negated())
    if (!amount.isPositive()) throw new Error('Balances do not net to zero')
    result.push({
      from: last.participantId,
      to: first.participantId,
      amount: amount.toFixed(),
    })
    first.total = first.total.minus(amount)
    last.total = last.total.plus(amount)
    if (first.total.isZero()) rows.shift()
    if (last.total.isZero()) rows.pop()
  }
  if (rows.length && !rows[0].total.isZero())
    throw new Error('Balances do not net to zero')
  return result
}
