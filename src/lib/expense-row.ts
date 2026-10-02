import type { getGroupExpenses } from './api'
import { getBalances } from './balances'
import { Decimal } from './money'

type Expense = Awaited<ReturnType<typeof getGroupExpenses>>[number]
type Figure = {
  label: string
  amount: string | null
  tone: 'neutral' | 'positive' | 'negative'
}
/** Presentation only: the existing exact ledger calculation owns splitting and rounding. */
export function expenseRowFigures(
  expense: Expense,
  participantId: string | null,
): { paid: Figure; personal: Figure } {
  const amount = new Decimal(expense.amount)
  const payer = expense.paidBy.id === participantId
  const income = amount.lt(0)
  const balance = participantId
    ? getBalances([expense])[participantId]
    : undefined
  const paid: Figure = {
    label: `${payer ? 'you' : expense.paidBy.name} ${income ? 'received' : 'paid'}`,
    amount: amount.abs().toFixed(),
    tone: 'neutral',
  }
  if (!participantId)
    return {
      paid,
      personal: { label: 'identity not linked', amount: null, tone: 'neutral' },
    }
  if (!balance)
    return {
      paid,
      personal: { label: 'not involved', amount: null, tone: 'neutral' },
    }
  const net = new Decimal(balance.total)
  const share = new Decimal(balance.paidFor).abs()
  if (expense.isReimbursement)
    return {
      paid,
      personal: {
        label:
          (payer && !income) || (!payer && income)
            ? 'you repaid'
            : 'you received',
        amount: payer ? net.abs().toFixed() : share.toFixed(),
        tone: 'neutral',
      },
    }
  if (income)
    return {
      paid,
      personal: {
        label: 'your share',
        amount: share.toFixed(),
        tone: 'positive',
      },
    }
  return {
    paid,
    personal: {
      label: net.gt(0) ? 'you lent' : net.lt(0) ? 'you borrowed' : 'your share',
      amount: net.isZero() ? share.toFixed() : net.abs().toFixed(),
      tone: net.gt(0) ? 'positive' : net.lt(0) ? 'negative' : 'neutral',
    },
  }
}
