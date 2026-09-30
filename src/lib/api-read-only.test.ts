/** @jest-environment node */

import { getExpense, getGroupExpenses } from './api'

var mockExpenses = jest.fn()
var mockRecurringLinks = jest.fn()
const storedExpense = { id: 'expense-a', groupId: 'group-a' }

jest.mock('./prisma', () => ({
  prisma: {
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

it('cannot retrieve an expense through another group ID', async () => {
  expect(await getExpense('group-b', 'expense-a')).toBeNull()
  expect(await getExpense('group-a', 'expense-a')).toEqual(storedExpense)
})
