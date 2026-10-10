/** @jest-environment node */

import { getActiveRecurringExpenses, getExpense, getGroupExpenses } from './api'

var mockExpenses = jest.fn()
var mockRecurringLinks = jest.fn()
const storedExpense = {
  id: 'expense-a',
  groupId: 'group-a',
  deletedAt: null,
  paidBy: { id: 'alice', name: 'Alice' },
}

jest.mock('./prisma', () => ({
  prisma: {
    userGroupAccess: { findMany: async () => [] },
    expense: {
      findMany: (...args: unknown[]) => mockExpenses(...args),
      findUnique: ({ where }: { where: Record<string, string> }) =>
        Object.entries(where).every(
          ([key, value]) =>
            storedExpense[key as keyof typeof storedExpense] === value,
        )
          ? storedExpense
          : null,
    },
    recurringExpenseLink: {
      findMany: (...args: unknown[]) => mockRecurringLinks(...args),
    },
  },
}))
jest.mock('../generated/prisma/client', () =>
  jest.requireActual('../generated/prisma/browser'),
)
jest.mock('./random', () => ({
  randomId: () => {
    throw new Error('Read-only tests must not create record IDs')
  },
}))

beforeEach(() => {
  mockExpenses.mockReset().mockResolvedValue([])
  mockRecurringLinks.mockReset().mockResolvedValue([])
})

it('does not process recurrence while serving a read-only expense list', async () => {
  expect(await getGroupExpenses('group-a', { readOnly: true })).toEqual([])
  expect(mockRecurringLinks).not.toHaveBeenCalled()
})

it('keeps the existing web recurrence behavior outside read-only access', async () => {
  await getGroupExpenses('group-a')
  expect(mockRecurringLinks).toHaveBeenCalledTimes(1)
})

it('skips recurrence for read-only recurring stats but preserves the web behavior', async () => {
  await getActiveRecurringExpenses('group-a', { readOnly: true })
  expect(mockRecurringLinks).not.toHaveBeenCalled()
  await getActiveRecurringExpenses('group-a')
  expect(mockRecurringLinks).toHaveBeenCalledTimes(1)
})

it('cannot retrieve an expense through another group ID', async () => {
  expect(await getExpense('group-b', 'expense-a')).toBeNull()
  expect(await getExpense('group-a', 'expense-a')).toEqual(storedExpense)
})

it('applies inclusive UTC expense-date bounds together with title filtering before pagination', async () => {
  await getGroupExpenses('group-a', {
    readOnly: true,
    from: '2024-02-01',
    to: '2024-02-29',
    filter: 'dinner',
    offset: 10,
    length: 11,
  })
  expect(mockExpenses).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        groupId: 'group-a',
        deletedAt: null,
        AND: [
          {
            OR: [
              { title: { contains: 'dinner', mode: 'insensitive' } },
              { vendor: { contains: 'dinner', mode: 'insensitive' } },
            ],
          },
        ],
        expenseDate: {
          gte: new Date('2024-02-01T00:00:00.000Z'),
          lte: new Date('2024-02-29T00:00:00.000Z'),
        },
      },
      skip: 10,
      take: 11,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    }),
  )
  expect(mockRecurringLinks).not.toHaveBeenCalled()
})
