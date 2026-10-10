import type { Activity } from '@/generated/prisma/client'
import { expenseAttributions } from './expense-attribution'

type Event = Pick<
  Activity,
  'expenseId' | 'time' | 'activityType' | 'actorUserId' | 'actorName' | 'source'
>
const mockFindMany = jest.fn<Promise<Event[]>, [object]>()
jest.mock('./prisma', () => ({
  prisma: {
    user: { findMany: async () => [] },
    activity: { findMany: (...args: [object]) => mockFindMany(...args) },
  },
}))

const event = (values: Partial<Event>): Event => ({
  expenseId: 'expense',
  time: new Date('2026-10-01T12:00:00Z'),
  activityType: 'CREATE_EXPENSE',
  actorUserId: 'alice',
  actorName: 'Alice',
  source: 'web',
  ...values,
})

beforeEach(() => mockFindMany.mockReset())

it('keeps the viewer edit time after someone else edits and never substitutes the payer', async () => {
  mockFindMany.mockResolvedValue([
    event({}),
    event({
      activityType: 'UPDATE_EXPENSE',
      time: new Date('2026-10-02T12:00:00Z'),
    }),
    event({
      activityType: 'UPDATE_EXPENSE',
      actorUserId: 'bob',
      actorName: 'Bob',
      time: new Date('2026-10-03T12:00:00Z'),
    }),
  ])
  const result = (
    await expenseAttributions('group', ['expense'], undefined, 'alice')
  ).get('expense')!
  expect(result.createdAt).toBe('2026-10-01T12:00:00.000Z')
  expect(result.updatedAt).toBe('2026-10-03T12:00:00.000Z')
  expect(result.updatedBy?.name).toBe('Bob')
  expect(result.lastEditedByYouAt).toBe('2026-10-02T12:00:00.000Z')
})

it('does not call creation an edit and keeps historical reads bounded', async () => {
  mockFindMany.mockResolvedValue([event({})])
  const result = (
    await expenseAttributions('group', ['expense'], 4, 'alice')
  ).get('expense')!
  expect(result.updatedAt).toBeUndefined()
  expect(result.lastEditedByYouAt).toBeUndefined()
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        groupId: 'group',
        sequence: { lte: 4 },
        source: { not: 'baseline' },
      }),
    }),
  )
})

it('never labels an unverified actor as the viewer', async () => {
  mockFindMany.mockResolvedValue([
    event({
      activityType: 'UPDATE_EXPENSE',
      actorUserId: null,
      actorName: 'Alice',
    }),
  ])
  const result = (
    await expenseAttributions('group', ['expense'], undefined, 'alice')
  ).get('expense')!
  expect(result.updatedBy).toBeNull()
  expect(result.lastEditedByYouAt).toBeUndefined()
})
