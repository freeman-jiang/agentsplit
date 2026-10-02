import type { getGroupExpenses } from './api'
import { expenseRowFigures } from './expense-row'

type Expense = Awaited<ReturnType<typeof getGroupExpenses>>[number]
const expense = (overrides: Partial<Expense> = {}): Expense => ({
  id: 'receipt',
  title: 'Dinner',
  amount: '20',
  currencyCode: 'USD',
  paidBy: { id: 'alice', name: 'Alice' },
  paidFor: ['alice', 'bob', 'carol'].map((id) => ({
    participant: { id, name: id },
    shares: '1',
  })),
  splitMode: 'EVENLY',
  isReimbursement: false,
  category: null,
  recurrenceRule: 'NONE',
  originalAmount: null,
  originalCurrency: null,
  createdAt: new Date('2026-10-01'),
  expenseDate: new Date('2026-10-01'),
  _count: { documents: 0 },
  ...overrides,
})

it('uses payer-first exact rounding for you paid / you lent', () => {
  const row = expenseRowFigures(expense(), 'alice')
  expect(row.paid).toMatchObject({ label: 'you paid', amount: '20' })
  expect(row.personal).toEqual({
    label: 'you lent',
    amount: '13.33',
    tone: 'positive',
  })
})
it('shows the other payer and only the viewer share as borrowed', () => {
  const row = expenseRowFigures(expense(), 'bob')
  expect(row.paid.label).toBe('Alice paid')
  expect(row.personal.label).toBe('you borrowed')
  expect(['6.66', '6.67']).toContain(row.personal.amount)
  expect(row.personal.tone).toBe('negative')
})
it('preserves explicit imported decimal splits', () => {
  const row = expenseRowFigures(
    expense({
      amount: '473.95',
      splitMode: 'BY_AMOUNT',
      paidFor: [
        { participant: { id: 'alice', name: 'Alice' }, shares: '149.49' },
        { participant: { id: 'bob', name: 'Bob' }, shares: '324.46' },
      ],
    }),
    'alice',
  )
  expect(row.personal.amount).toBe('324.46')
})
it('does not present a settlement as a loan', () => {
  const payment = expense({
    amount: '10',
    isReimbursement: true,
    paidFor: [{ participant: { id: 'bob', name: 'Bob' }, shares: '1' }],
  })
  expect(expenseRowFigures(payment, 'alice').personal).toEqual({
    label: 'you repaid',
    amount: '10',
    tone: 'neutral',
  })
  expect(expenseRowFigures(payment, 'bob').personal).toEqual({
    label: 'you received',
    amount: '10',
    tone: 'neutral',
  })
})
it('labels refunds as received with your share', () => {
  const row = expenseRowFigures(expense({ amount: '-30' }), 'alice')
  expect(row.paid).toMatchObject({ label: 'you received', amount: '30' })
  expect(row.personal).toMatchObject({ label: 'your share', amount: '10' })
})
it('distinguishes uninvolved participants from unbound accounts', () => {
  expect(expenseRowFigures(expense(), 'outsider').personal).toMatchObject({
    label: 'not involved',
    amount: null,
  })
  expect(expenseRowFigures(expense(), null).personal).toMatchObject({
    label: 'identity not linked',
    amount: null,
  })
})
it('does not call a personal-only expense a loan', () => {
  const row = expenseRowFigures(
    expense({
      paidFor: [{ participant: { id: 'alice', name: 'Alice' }, shares: '1' }],
    }),
    'alice',
  )
  expect(row.personal).toEqual({
    label: 'your share',
    amount: '20',
    tone: 'neutral',
  })
})
it('uses whole yen, never assumes two decimal places', () => {
  const row = expenseRowFigures(
    expense({ amount: '6000', currencyCode: 'JPY' }),
    'alice',
  )
  expect(row.paid.amount).toBe('6000')
  expect(row.personal.amount).toBe('4000')
})

it('reverses payment direction for a negative reimbursement', () => {
  const payment = expense({
    amount: '-10',
    isReimbursement: true,
    paidFor: [{ participant: { id: 'bob', name: 'Bob' }, shares: '1' }],
  })
  expect(expenseRowFigures(payment, 'alice').personal).toMatchObject({
    label: 'you received',
    amount: '10',
  })
  expect(expenseRowFigures(payment, 'bob').personal).toMatchObject({
    label: 'you repaid',
    amount: '10',
  })
})
