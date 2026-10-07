import { getGroupExpenses } from '@/lib/api'
import { getBalances, getSuggestedReimbursements } from './balances'
import { add, Decimal } from './money'

type Expenses = NonNullable<Awaited<ReturnType<typeof getGroupExpenses>>>
type Expense = Expenses[number]

function expense(
  paidBy: string,
  amount: number | string,
  paidFor: string[],
  isReimbursement = false,
): Expense {
  return {
    amount:
      typeof amount === 'string'
        ? amount
        : new Decimal(amount).div(100).toFixed(),
    currencyCode: 'USD',
    isReimbursement,
    splitMode: 'EVENLY',
    paidBy: { id: paidBy, name: paidBy },
    paidFor: paidFor.map((id) => ({
      participant: { id, name: id },
      shares: '100',
    })),
  } as Expense
}

describe('getBalances', () => {
  it('splits an expense evenly between the participants', () => {
    const balances = getBalances([expense('alice', 3000, ['alice', 'bob'])])

    expect(balances.alice).toEqual({ paid: '30', paidFor: '15', total: '15' })
    expect(balances.bob).toEqual({ paid: '0', paidFor: '15', total: '-15' })
  })

  it('counts a reimbursement like any other expense', () => {
    const balances = getBalances([
      expense('alice', 3000, ['alice', 'bob']),
      expense('bob', 1500, ['alice'], true),
    ])

    expect(balances.alice.total).toBe('0')
    expect(balances.bob.total).toBe('0')
  })
})

describe('settling up', () => {
  /**
   * Repayments are recorded in the group currency, so booking a suggested reimbursement
   * must bring every balance to exactly zero — including when the expense was originally
   * entered in another currency and converted.
   */
  it('brings every balance to zero once the suggestions are booked', () => {
    const expenses = [
      expense('alice', 500000, ['alice', 'bob', 'carol']),
      expense('bob', 12345, ['alice', 'bob', 'carol']),
      expense('carol', 999, ['alice', 'bob']),
    ]

    const reimbursements = getSuggestedReimbursements(getBalances(expenses))
    expect(reimbursements.length).toBeGreaterThan(0)

    const settled = [
      ...expenses,
      ...reimbursements.map(({ from, to, amount }) =>
        expense(from, amount, [to], true),
      ),
    ]

    for (const balance of Object.values(getBalances(settled))) {
      expect(balance.total).toBe('0')
    }
  })

  it('leaves no further reimbursement to suggest', () => {
    const expenses = [expense('alice', 7777, ['alice', 'bob'])]
    const reimbursements = getSuggestedReimbursements(getBalances(expenses))

    const settled = [
      ...expenses,
      ...reimbursements.map(({ from, to, amount }) =>
        expense(from, amount, [to], true),
      ),
    ]

    expect(getSuggestedReimbursements(getBalances(settled))).toEqual([])
  })
})

type SplitMode = Expense['splitMode']

const SPLIT_MODES: SplitMode[] = [
  'EVENLY',
  'BY_SHARES',
  'BY_PERCENTAGE',
  'BY_AMOUNT',
]

/**
 * Like `expense` above, but carries an id and a split mode. The id decides
 * which participant is offered the remaining minor unit of an uneven split.
 */
function splitExpense(
  id: string,
  paidBy: string,
  amount: number | string,
  paidFor: { id: string; shares: number | string }[],
  splitMode: SplitMode = 'EVENLY',
): Expense {
  return {
    id,
    amount:
      typeof amount === 'string'
        ? amount
        : new Decimal(amount).div(100).toFixed(),
    currencyCode: 'USD',
    isReimbursement: false,
    splitMode,
    paidBy: { id: paidBy, name: paidBy },
    paidFor: paidFor.map(({ id, shares }) => ({
      participant: { id, name: id },
      shares: new Decimal(shares)
        .div(
          splitMode === 'BY_PERCENTAGE' || splitMode === 'BY_AMOUNT' ? 100 : 1,
        )
        .toFixed(),
    })),
  } as Expense
}

function evenly(
  id: string,
  paidBy: string,
  amount: number | string,
  paidFor: string[],
) {
  return splitExpense(
    id,
    paidBy,
    amount,
    paidFor.map((id) => ({ id, shares: '1' })),
  )
}

function sumOfTotals(balances: ReturnType<typeof getBalances>) {
  return Object.values(balances).reduce(
    (sum, { total }) => add(sum, total),
    '0',
  )
}

/** Splits `total` into `count` positive integers that add up to exactly `total`. */
function distribute(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const shares = Array.from({ length: count }, () => base)
  for (let i = 0; i < total - base * count; i++) shares[i] += 1
  return shares
}

/** A seeded LCG, so a failing case is reproducible from the seed alone. */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return (bound: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % bound
  }
}

function randomExpense(
  id: string,
  participants: string[],
  random: (bound: number) => number,
): Expense {
  const splitMode = SPLIT_MODES[random(SPLIT_MODES.length)]
  const paidFor = participants.filter(() => random(2) === 0)
  if (paidFor.length === 0)
    paidFor.push(participants[random(participants.length)])
  // BY_AMOUNT shares are validated to add up to the amount, and no share may be
  // zero, so the amount has to be at least the number of participants.
  const amount = paidFor.length + random(100000)
  const paidBy = participants[random(participants.length)]

  switch (splitMode) {
    case 'BY_SHARES':
      return splitExpense(
        id,
        paidBy,
        amount,
        paidFor.map((id) => ({ id, shares: 1 + random(10) })),
        splitMode,
      )
    case 'BY_PERCENTAGE':
    case 'BY_AMOUNT': {
      // Percentages are stored times 100, so a full split adds up to 10000.
      const shares = distribute(
        splitMode === 'BY_PERCENTAGE' ? 10000 : amount,
        paidFor.length,
      )
      return splitExpense(
        id,
        paidBy,
        amount,
        paidFor.map((id, index) => ({ id, shares: shares[index] })),
        splitMode,
      )
    }
    default:
      return splitExpense(
        id,
        paidBy,
        amount,
        paidFor.map((id) => ({ id, shares: '1' })),
        splitMode,
      )
  }
}

describe('balances sum to zero', () => {
  it('holds for an expense that does not divide evenly', () => {
    // 100 split three ways used to leave a stranded minor unit that no
    // reimbursement would ever offer back.
    const balances = getBalances([
      evenly('e1', 'alice', 100, ['alice', 'bob', 'carol']),
    ])

    expect(sumOfTotals(balances)).toBe('0')
    expect(
      Decimal.sum(
        balances.alice.paidFor,
        balances.bob.paidFor,
        balances.carol.paidFor,
      ).toFixed(),
    ).toBe('1')
  })

  it('holds for an expense split seven ways', () => {
    const participants = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const balances = getBalances([evenly('e1', 'a', 1000, participants)])

    expect(sumOfTotals(balances)).toBe('0')
    expect(
      participants.reduce((sum, id) => add(sum, balances[id].paidFor), '0'),
    ).toBe('10')
  })

  it('holds across randomised amounts, participants and split modes', () => {
    const random = makeRandom(20260804)

    for (let run = 0; run < 500; run++) {
      const participants = Array.from(
        { length: 2 + random(7) },
        (_, index) => `participant-${index}`,
      )
      const expenses = Array.from({ length: 1 + random(6) }, (_, index) =>
        randomExpense(`run-${run}-expense-${index}`, participants, random),
      )

      expect(sumOfTotals(getBalances(expenses))).toBe('0')
    }
  })

  it('offers the whole credit back through the suggested reimbursements', () => {
    const expenses = [evenly('e1', 'alice', 100, ['alice', 'bob', 'carol'])]
    const balances = getBalances(expenses)
    const reimbursements = getSuggestedReimbursements(balances)

    const offeredToAlice = reimbursements
      .filter(({ to }) => to === 'alice')
      .reduce((sum, { amount }) => add(sum, amount), '0')

    expect(offeredToAlice).toBe(balances.alice.total)
  })

  it('settles completely once every suggestion is booked', () => {
    const random = makeRandom(1312)

    for (let run = 0; run < 100; run++) {
      const participants = Array.from(
        { length: 2 + random(5) },
        (_, index) => `participant-${index}`,
      )
      const expenses = Array.from({ length: 1 + random(4) }, (_, index) =>
        randomExpense(`run-${run}-expense-${index}`, participants, random),
      )

      const reimbursements = getSuggestedReimbursements(getBalances(expenses))
      const settled = [
        ...expenses,
        ...reimbursements.map(({ from, to, amount }, index) =>
          evenly(`run-${run}-settle-${index}`, from, amount, [to]),
        ),
      ]

      for (const balance of Object.values(getBalances(settled))) {
        expect(balance.total).toBe('0')
      }
    }
  })
})

describe('remainder distribution', () => {
  it('always gives the payer the extra unit', () => {
    const participants = ['alice', 'bob', 'carol']
    for (let index = 0; index < 50; index++) {
      const balances = getBalances([
        evenly(`expense-${index}`, 'alice', 100, participants),
      ])
      expect(balances.alice.paidFor).toBe('0.34')
      expect(balances.bob.paidFor).toBe('0.33')
      expect(balances.carol.paidFor).toBe('0.33')
    }
  })

  it('gives the same expense the same split every time', () => {
    const split = () =>
      getBalances([
        evenly('expense-1', 'alice', 100, ['alice', 'bob', 'carol']),
      ])

    expect(split()).toEqual(split())
  })

  it('does not depend on the order the participants come back from the database', () => {
    const paidFor = [
      { id: 'alice', shares: '1' },
      { id: 'bob', shares: '1' },
      { id: 'carol', shares: '1' },
    ]
    const inOrder = getBalances([splitExpense('e1', 'alice', 100, paidFor)])
    const reversed = getBalances([
      splitExpense('e1', 'alice', 100, [...paidFor].reverse()),
    ])

    expect(reversed).toEqual(inOrder)
  })

  it('splits an expense entered without an id', () => {
    const balances = getBalances([
      expense('alice', 100, ['alice', 'bob', 'carol']),
    ])

    expect(sumOfTotals(balances)).toBe('0')
  })
})

describe('split modes', () => {
  it('leaves exact BY_AMOUNT shares untouched', () => {
    const balances = getBalances([
      splitExpense(
        'e1',
        'alice',
        1000,
        [
          { id: 'alice', shares: '333' },
          { id: 'bob', shares: '333' },
          { id: 'carol', shares: '334' },
        ],
        'BY_AMOUNT',
      ),
    ])

    expect(balances.alice.paidFor).toBe('3.33')
    expect(balances.bob.paidFor).toBe('3.33')
    expect(balances.carol.paidFor).toBe('3.34')
    expect(sumOfTotals(balances)).toBe('0')
  })

  it('rounds BY_PERCENTAGE shares without losing a minor unit', () => {
    const balances = getBalances([
      splitExpense(
        'e1',
        'alice',
        100,
        [
          { id: 'alice', shares: '3333' },
          { id: 'bob', shares: '3333' },
          { id: 'carol', shares: '3334' },
        ],
        'BY_PERCENTAGE',
      ),
    ])

    expect(sumOfTotals(balances)).toBe('0')
    expect(
      Decimal.sum(
        balances.alice.paidFor,
        balances.bob.paidFor,
        balances.carol.paidFor,
      ).toFixed(),
    ).toBe('1')
  })

  it('splits BY_SHARES proportionally and to the last minor unit', () => {
    const balances = getBalances([
      splitExpense(
        'e1',
        'alice',
        100,
        [
          { id: 'alice', shares: '1' },
          { id: 'bob', shares: '2' },
        ],
        'BY_SHARES',
      ),
    ])

    expect(balances.alice.paidFor).toBe('0.34')
    expect(balances.bob.paidFor).toBe('0.66')
    expect(sumOfTotals(balances)).toBe('0')
  })

  it('splits an income (negative amount) without losing a minor unit', () => {
    const balances = getBalances([
      evenly('e1', 'alice', -100, ['alice', 'bob', 'carol']),
    ])

    expect(sumOfTotals(balances)).toBe('0')
    expect(
      Decimal.sum(
        balances.alice.paidFor,
        balances.bob.paidFor,
        balances.carol.paidFor,
      ).toFixed(),
    ).toBe('-1')
  })
})
