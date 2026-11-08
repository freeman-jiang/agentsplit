// The revision panel marks a field as changed only when it changed. People
// come back from saved revisions in any order, so "Split between" must not
// change with a notes-only edit.
import { describe, expect, it } from 'vitest'
import { fieldChanged } from '~/client/components/log/revision-diff'
import { describeRevision, REVISION_FIELDS } from '~/shared/history'
import { readSnapshot } from '~/shared/snapshots'

const shares = [
  { participantId: 'alice', name: 'Alice', amount: '20.00', weight: '1' },
  { participantId: 'bob', name: 'Bob', amount: '10.00', weight: '1' },
]

const revision = (data: { revision: number; notes: string; shares: typeof shares }) => {
  const state = readSnapshot({
    categories: new Map(),
    raw: {
      schemaVersion: 2,
      kind: 'expense',
      group: { id: 'g', name: 'Home', slug: null, currency: 'USD' },
      expense: {
        id: 'e',
        revision: data.revision,
        kind: 'expense',
        title: 'Groceries',
        vendor: null,
        notes: data.notes,
        categoryId: 0,
        expenseDate: '2026-11-01',
        currency: 'USD',
        amount: '30.00',
        splitMode: 'amount',
        payers: [{ participantId: 'alice', name: 'Alice', amount: '30.00' }],
        shares: data.shares,
        recurrence: 'none',
        createdAt: '2026-11-01T00:00:00.000Z',
        documentCount: 0,
        documents: [],
      },
    },
  })
  if (state._tag !== 'expense') throw new Error('Expected an expense')
  return describeRevision(state.expense)
}

const changes = (previous: ReturnType<typeof revision>, current: ReturnType<typeof revision>) =>
  REVISION_FIELDS.filter(([field]) => fieldChanged({ field, previous: previous[field], current: current[field] })).map(([field]) => field)

describe('revision panel changes', () => {
  it('marks only the notes after a notes-only edit that lists the people in another order', () => {
    const before = revision({ revision: 1, notes: '', shares })
    const after = revision({ revision: 2, notes: 'Paid in cash', shares: [...shares].reverse() })
    expect(before.splits).not.toBe(after.splits)
    expect(changes(before, after)).toEqual(['notes'])
  })

  it('still marks "Split between" when a share changes', () => {
    const before = revision({ revision: 1, notes: '', shares })
    const after = revision({
      revision: 2,
      notes: '',
      shares: [
        { participantId: 'bob', name: 'Bob', amount: '15.00', weight: '1' },
        { participantId: 'alice', name: 'Alice', amount: '15.00', weight: '1' },
      ],
    })
    expect(changes(before, after)).toEqual(['splits'])
  })
})
