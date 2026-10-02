import { expenseFormSchema } from './schemas'

const expense = {
  expenseDate: '2026-09-30',
  title: 'Dinner',
  amount: '12.34',
  currencyCode: 'USD',
  originalCurrency: '',
  paidBy: 'alice',
  paidFor: [{ participant: 'alice', shares: '1' }],
  splitMode: 'EVENLY',
  saveDefaultSplittingOptions: false,
  isReimbursement: false,
}

describe('decimal-string expense contract', () => {
  it.each([
    12.34,
    '',
    ' ',
    ' 12.34',
    '12.34 ',
    '12\n',
    '1e2',
    '+12',
    '.5',
    '12.',
    '01.2',
    '1,234',
    '0x10',
    'NaN',
    'Infinity',
    '--1',
    '1.2.3',
    null,
    true,
    {},
  ])('rejects malformed or non-string money: %p', (amount) => {
    expect(expenseFormSchema.safeParse({ ...expense, amount }).success).toBe(
      false,
    )
  })

  it('keeps face-value decimal amounts as strings', () => {
    expect(expenseFormSchema.parse(expense).amount).toBe('12.34')
    for (const currencyCode of ['USD', 'JPY']) {
      expect(
        expenseFormSchema.parse({ ...expense, amount: '6000', currencyCode })
          .amount,
      ).toBe('6000')
    }
  })

  it('checks explicit monetary splits with exact arithmetic', () => {
    const result = expenseFormSchema.parse({
      ...expense,
      amount: '0.3',
      splitMode: 'BY_AMOUNT',
      paidFor: [
        { participant: 'alice', shares: '0.1' },
        { participant: 'bob', shares: '0.2' },
      ],
    })
    expect(result.paidFor.map((p) => p.shares)).toEqual(['0.1', '0.2'])
  })

  it('uses percentages at face value and remains idempotent', () => {
    const result = expenseFormSchema.parse({
      ...expense,
      splitMode: 'BY_PERCENTAGE',
      paidFor: [
        { participant: 'alice', shares: '33.33' },
        { participant: 'bob', shares: '66.67' },
      ],
    })
    expect(result.paidFor.map((p) => p.shares)).toEqual(['33.33', '66.67'])
    expect(expenseFormSchema.parse(result)).toEqual(result)
  })

  it('rejects duplicate beneficiaries', () => {
    expect(
      expenseFormSchema.safeParse({
        ...expense,
        paidFor: [
          { participant: 'alice', shares: '1' },
          { participant: 'alice', shares: '1' },
        ],
      }).success,
    ).toBe(false)
  })

  it.each([
    '',
    ' ',
    '1e2',
    'NaN',
    'Infinity',
    '20,00',
    '1\n',
    '0.1234567890123',
  ])('reports malformed split text without throwing: %p', (shares) => {
    for (const splitMode of ['BY_AMOUNT', 'BY_SHARES', 'BY_PERCENTAGE']) {
      expect(
        expenseFormSchema.safeParse({
          ...expense,
          splitMode,
          paidFor: [{ participant: 'alice', shares }],
        }).success,
      ).toBe(false)
    }
  })

  it.each(['0', '-0', '0.00', '10000000.01', '-10000000.01'])(
    'rejects zero or out-of-range expense amounts: %p',
    (amount) => {
      expect(expenseFormSchema.safeParse({ ...expense, amount }).success).toBe(
        false,
      )
    },
  )

  it('accepts exact signed amounts and rejects unknown currencies', () => {
    expect(
      expenseFormSchema.parse({ ...expense, amount: '-12.34' }).amount,
    ).toBe('-12.34')
    expect(
      expenseFormSchema.safeParse({ ...expense, currencyCode: 'XYZ' }).success,
    ).toBe(false)
  })
})
