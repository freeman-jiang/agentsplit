import type { ExpenseSnapshot } from '@/lib/expense-history'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Activity } from './activity-item'
import { ActivityRevision } from './activity-revision'

jest.mock('next-intl', () => ({
  useLocale: () => 'en-US',
  useTranslations: () =>
    Object.assign((key: string) => key, { has: () => false }),
}))

const original: ExpenseSnapshot = {
  schemaVersion: 1,
  kind: 'expense',
  group: {
    id: 'group-a',
    name: 'Original group',
    currency: '$',
    currencyCode: 'USD',
  },
  expense: {
    id: 'expense-a',
    groupId: 'group-a',
    revision: 1,
    title: 'Original dinner',
    amount: '60',
    currencyCode: 'USD',
    expenseDate: '2026-09-30T00:00:00.000Z',
    createdAt: '2026-09-30T00:00:00.000Z',
    categoryId: 0,
    category: null,
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    paidBy: { id: 'alice', name: 'Alice' },
    paidFor: [
      { participantId: 'alice', name: 'Alice', shares: '1' },
      { participantId: 'bob', name: 'Bob', shares: '1' },
    ],
    splitMode: 'EVENLY',
    isReimbursement: false,
    notes: 'Original notes',
    recurrenceRule: 'NONE',
    documents: [
      {
        id: 'receipt-a',
        url: 'https://receipt.test/original.png',
        width: 100,
        height: 100,
      },
    ],
  },
}
const event: Activity = {
  expense: undefined,
  id: 'event-a',
  groupId: 'group-a',
  expenseId: 'expense-a',
  participantId: 'alice',
  time: new Date('2026-09-30T00:00:00Z'),
  activityType: 'UPDATE_EXPENSE',
  data: 'Updated dinner',
  expenseRevision: 2,
  source: 'web',
  actorName: 'Alice',
  actorUserId: null,
  agentKeyId: null,
  snapshot: {
    ...original,
    expense: { ...original.expense, revision: 2, amount: '90' },
  },
  previousSnapshot: original,
}

it('renders preserved values, previous/current splits, and unverified actor information', () => {
  const html = renderToStaticMarkup(<ActivityRevision activity={event} />)
  expect(html).toContain('60.00 USD')
  expect(html).toContain('90.00 USD')
  expect(html).toContain('Bob: 30.00 USD')
  expect(html).toContain('Bob: 45.00 USD')
  expect(html).toContain('unverified label')
  expect(html).toContain('https://receipt.test/original.png')
})

it('shows the last saved version after deletion and never makes script receipt URLs clickable', () => {
  const unsafe: ExpenseSnapshot = {
    ...original,
    expense: {
      ...original.expense,
      documents: [
        { ...original.expense.documents[0], url: 'javascript:alert(1)' },
      ],
    },
  }
  const html = renderToStaticMarkup(
    <ActivityRevision
      activity={{
        ...event,
        activityType: 'DELETE_EXPENSE',
        snapshot: null,
        previousSnapshot: unsafe,
      }}
    />,
  )
  expect(html).toContain('Deleted')
  expect(html).toContain('remains in history')
  expect(html).toContain('Original dinner')
  expect(html).not.toContain('href="javascript:')
})
