import { SplitMode } from '@/generated/prisma/browser'
import { getCurrency } from './currency'
import { Decimal } from './money'

export type ShareInput = {
  id?: string | null
  amount: string
  currencyCode: string
  paidById: string
  splitMode: SplitMode
  paidFor: { participantId: string; shares: string }[]
}

/** The payer gets the first leftover unit; other units follow largest remainder. */
function apportion(
  amount: string,
  weights: string[],
  digits: number,
  preferredIndex: number,
): string[] {
  if (weights.length === 0) return []
  const quantum = new Decimal(10).pow(digits)
  const signedAmount = new Decimal(amount)
  const units = signedAmount.abs().mul(quantum)
  if (!units.isInteger()) throw new Error('Amount exceeds currency precision')
  const total = Decimal.sum(...weights)
  if (total.isZero()) return weights.map(() => '0')
  const allocations = weights.map((weight) =>
    units.mul(weight).div(total).floor(),
  )
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: units.mul(weight).minus(allocations[index].mul(total)),
  }))
  const remaining = units.minus(Decimal.sum(...allocations)).toNumber()
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    remaining >= weights.length
  )
    throw new Error('Invalid expense split')
  remainders.sort(
    (a, b) =>
      Number(b.index === preferredIndex) - Number(a.index === preferredIndex) ||
      b.remainder.comparedTo(a.remainder) ||
      a.index - b.index,
  )
  for (let i = 0; i < remaining; i++) {
    const index = remainders[i].index
    allocations[index] = allocations[index].plus(1)
  }
  return allocations.map((value) =>
    value
      .div(quantum)
      .mul(signedAmount.isNegative() ? -1 : 1)
      .toFixed(),
  )
}

/** One backend definition used by balances, statistics, exports and previews. */
export function getExpenseShares(expense: ShareInput): Map<string, string> {
  const people = [...expense.paidFor].sort((a, b) =>
    a.participantId < b.participantId ? -1 : 1,
  )
  if (
    expense.splitMode === 'BY_AMOUNT' &&
    Decimal.sum(...people.map((p) => p.shares)).eq(expense.amount)
  )
    return new Map(
      people.map((person) => [person.participantId, person.shares]),
    )
  const weights = people.map((person) =>
    expense.splitMode === 'EVENLY'
      ? '1'
      : new Decimal(person.shares).abs().toFixed(),
  )
  const preferredIndex = people.findIndex(
    (person) => person.participantId === expense.paidById,
  )
  const amounts = apportion(
    expense.amount,
    weights,
    getCurrency(expense.currencyCode).decimal_digits,
    preferredIndex,
  )
  return new Map(
    people.map((person, index) => [person.participantId, amounts[index]]),
  )
}

export function getParticipantShare(
  participantId: string | null,
  expense: ShareInput,
): string {
  return participantId === null
    ? '0'
    : (getExpenseShares(expense).get(participantId) ?? '0')
}

export function distributeAmount(
  amount: string,
  count: number,
  currencyCode: string,
  preferredIndex = 0,
): string[] {
  return apportion(
    amount,
    Array.from({ length: count }, () => '1'),
    getCurrency(currencyCode).decimal_digits,
    preferredIndex,
  )
}
