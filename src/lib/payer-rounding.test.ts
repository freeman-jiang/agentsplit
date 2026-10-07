import { expenseFormSchema } from './schemas'
import { getExpenseShares } from './shares'

const split = {
  amount: '10',
  currencyCode: 'USD',
  paidById: 'bob',
  splitMode: 'EVENLY' as const,
  paidFor: ['alice', 'bob', 'carol'].map((participantId) => ({
    participantId,
    shares: '1',
  })),
}

describe('payer-first rounding', () => {
  it('gives the payer the larger share regardless of expense ID or participant order', () => {
    for (const id of ['e1', 'e2', 'different-expense']) {
      const shares = getExpenseShares({ ...split, id })
      expect(Object.fromEntries(shares)).toEqual({
        alice: '3.33',
        bob: '3.34',
        carol: '3.33',
      })
      expect(
        getExpenseShares({
          ...split,
          id,
          paidFor: [...split.paidFor].reverse(),
        }),
      ).toEqual(shares)
    }
  })
  it('distributes more than one leftover cent without overcharging the payer', () => {
    expect(
      Object.fromEntries(getExpenseShares({ ...split, amount: '10.01' })),
    ).toEqual({ alice: '3.34', bob: '3.34', carol: '3.33' })
  })
  it('uses stable beneficiary order when the payer is not a beneficiary', () => {
    expect(
      Object.fromEntries(
        getExpenseShares({ ...split, paidById: 'someone-else' }),
      ),
    ).toEqual({ alice: '3.34', bob: '3.33', carol: '3.33' })
  })
  it('gives the payer the larger magnitude when splitting income', () => {
    expect(
      Object.fromEntries(getExpenseShares({ ...split, amount: '-10' })),
    ).toEqual({ alice: '-3.33', bob: '-3.34', carol: '-3.33' })
  })
  it('preserves explicit monetary splits', () => {
    expect(
      Object.fromEntries(
        getExpenseShares({
          ...split,
          splitMode: 'BY_AMOUNT',
          paidFor: [
            { participantId: 'alice', shares: '3.34' },
            { participantId: 'bob', shares: '3.33' },
            { participantId: 'carol', shares: '3.33' },
          ],
        }),
      ),
    ).toEqual({ alice: '3.34', bob: '3.33', carol: '3.33' })
  })
  it('also prioritizes the payer for weighted split rounding', () => {
    expect(
      Object.fromEntries(
        getExpenseShares({
          ...split,
          amount: '0.01',
          splitMode: 'BY_PERCENTAGE',
          paidFor: [
            { participantId: 'alice', shares: '99' },
            { participantId: 'bob', shares: '1' },
          ],
        }),
      ),
    ).toEqual({ alice: '0', bob: '0.01' })
  })
})

const expense = {
  title: 'Precision test',
  expenseDate: '2026-09-30',
  amount: '10',
  currencyCode: 'USD',
  paidBy: 'bob',
  paidFor: [{ participant: 'bob', shares: '1' }],
  saveDefaultSplittingOptions: false,
  isReimbursement: false,
}

describe('currency-specific write precision', () => {
  it.each([
    ['USD', '12.345'],
    ['JPY', '6000.5'],
    ['KRW', '100.01'],
  ])('rejects finer amounts for %s', (currencyCode, amount) => {
    expect(
      expenseFormSchema.safeParse({ ...expense, currencyCode, amount }).success,
    ).toBe(false)
  })
  it('rejects finer explicit split amounts even when their sum is valid', () => {
    expect(
      expenseFormSchema.safeParse({
        ...expense,
        amount: '0.3',
        splitMode: 'BY_AMOUNT',
        paidFor: [
          { participant: 'alice', shares: '0.105' },
          { participant: 'bob', shares: '0.195' },
        ],
      }).success,
    ).toBe(false)
  })
  it('accepts exact amounts and insignificant trailing zeroes', () => {
    expect(
      expenseFormSchema.parse({ ...expense, amount: '12.3400' }).amount,
    ).toBe('12.34')
    expect(
      expenseFormSchema.parse({
        ...expense,
        amount: '6000',
        currencyCode: 'JPY',
      }).amount,
    ).toBe('6000')
  })
})
