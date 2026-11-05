// v2 must accept exactly the expenses the current app accepts, and reject the rest.
import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { expenseFormSchema } from '../../../src/lib/schemas'
import { validateExpense, type ExpenseDraft } from '~/shared/expense-rules'
import type { SplitMode } from '~/shared/split'

const OLD_MODE = { evenly: 'EVENLY', shares: 'BY_SHARES', percentage: 'BY_PERCENTAGE', amount: 'BY_AMOUNT' } as const
const people = ['p1', 'p2', 'p3', 'p4']

const decimal = fc.oneof(
  fc.constantFrom('0', '1', '2', '3', '10', '33.33', '33.34', '50', '100', '0.5', '0.01', '0.001', '1.005', '-1', '-10.5', '1e3', '', ' 1', '01'),
  fc.integer({ min: -20000, max: 20000 }).map((n) => (n / 100).toFixed(2)),
  fc.integer({ min: 1, max: 300 }).map(String),
)

const draftArb = fc.record({
  title: fc.constantFrom('', 'a', 'ab', 'Dinner', ' a', 'x'.repeat(200), 'x'.repeat(201)),
  vendor: fc.constantFrom(null, '', ' Costco ', 'v'.repeat(100), 'v'.repeat(101)),
  notes: fc.constantFrom('', 'n', 'n'.repeat(5000), 'n'.repeat(5001)),
  expenseDate: fc.constantFrom('2026-11-05', '2026-02-29', '2024-02-29', '2026-13-01', '2026-1-5', 'x'),
  currency: fc.constantFrom('USD' as const, 'JPY' as const),
  amount: decimal,
  mode: fc.constantFrom<SplitMode>('evenly', 'shares', 'percentage', 'amount'),
  payer: fc.constantFrom(...people, 'stranger'),
  shares: fc.array(fc.record({ participantId: fc.constantFrom(...people, 'stranger'), weight: decimal }), { minLength: 0, maxLength: 5 }),
  categoryId: fc.constantFrom(0, 3, -1),
})

describe('validateExpense matches the current expense form rules', () => {
  it('accepts and rejects the same single-payer drafts', () => {
    fc.assert(
      fc.property(draftArb, (d) => {
        let oldAccepted: boolean
        try {
          oldAccepted = expenseFormSchema.safeParse({
          currencyCode: d.currency,
          expenseDate: d.expenseDate,
          title: d.title,
          vendor: d.vendor,
          category: d.categoryId,
          amount: d.amount,
          paidBy: d.payer,
          paidFor: d.shares.map((s) => ({ participant: s.participantId, shares: s.weight })),
          splitMode: OLD_MODE[d.mode],
          isReimbursement: false,
          notes: d.notes,
          recurrenceRule: 'NONE',
          }).success
        } catch {
          // The current schema throws on some invalid input (an empty split); that is a rejection too.
          oldAccepted = false
        }
        const draft: ExpenseDraft = {
          kind: 'expense',
          title: d.title,
          vendor: d.vendor,
          notes: d.notes,
          categoryId: d.categoryId,
          expenseDate: d.expenseDate,
          currency: d.currency,
          amount: d.amount,
          payers: [{ participantId: d.payer, amount: d.amount }],
          splitMode: d.mode,
          shares: d.shares,
          recurrence: 'none',
        }
        // The current form checks membership on the server; v2 checks it here, so test with
        // members only when the old schema has no way to know.
        const allMembers = [d.payer, ...d.shares.map((s) => s.participantId)].every((p) => people.includes(p))
        const next = validateExpense({ draft, participantIds: new Set(allMembers ? people : [...people, 'stranger']) })
        expect({ accepted: Result.isSuccess(next), draft: d }).toEqual({ accepted: oldAccepted, draft: d })
      }),
      { numRuns: 5000 },
    )
  })
})
