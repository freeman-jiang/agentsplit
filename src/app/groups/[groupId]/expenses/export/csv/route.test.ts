/** @jest-environment node */

import { GET } from './route'

var mockFindUnique = jest.fn()

jest.mock('../../../../../../lib/prisma', () => ({
  prisma: {
    group: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}))

const participants = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
]

async function exportedBalances({
  amount = 6000,
  paidById = 'alice',
  paidFor = ['alice', 'bob', 'carol'],
  isReimbursement = false,
} = {}) {
  mockFindUnique.mockResolvedValue({
    id: 'group',
    name: 'CSV regression test',
    currency: '$',
    currencyCode: 'USD',
    participants,
    expenses: [
      {
        id: 'expense',
        title: 'Dinner',
        expenseDate: new Date('2026-09-30T00:00:00Z'),
        category: null,
        amount,
        originalAmount: null,
        originalCurrency: null,
        conversionRate: null,
        paidById,
        paidFor: paidFor.map((participantId) => ({ participantId, shares: 1 })),
        isReimbursement,
        splitMode: 'EVENLY',
      },
    ],
  })

  const response = await GET(new Request('http://localhost/export'), {
    params: Promise.resolve({ groupId: 'group' }),
  })
  expect(response.status).toBe(200)
  const csv = await response.text()
  expect(csv).toContain('2026-09-30')
  return csv.split(/\r?\n/)[1].split(',').slice(-3).map(Number)
}

describe('CSV participant balances', () => {
  it('credits the payer for the amount paid minus their own share', async () => {
    expect(await exportedBalances()).toEqual([40, -20, -20])
  })

  it('credits the whole payment when the payer is not a beneficiary', async () => {
    expect(await exportedBalances({ paidFor: ['bob', 'carol'] })).toEqual([
      60, -30, -30,
    ])
  })

  it('keeps the exported balance changes at zero after minor-unit rounding', async () => {
    const balances = await exportedBalances({ amount: 6001 })
    expect(
      balances.reduce((sum, value) => sum + Math.round(value * 100), 0),
    ).toBe(0)
  })

  it('exports both sides of a reimbursement', async () => {
    expect(
      await exportedBalances({
        paidById: 'bob',
        paidFor: ['alice'],
        isReimbursement: true,
      }),
    ).toEqual([-60, 60, 0])
  })
})
