// The expense card figures and date headings must match the current app's.
import dayjs from 'dayjs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { getExpenseGroup } from '../../../src/lib/date-groups'
import { expenseRowFigures as oldFigures } from '../../../src/lib/expense-row'
import { dateGroup } from '~/client/components/date-groups'
import { expenseRowFigures } from '~/client/components/expense-row'
import { resolveShares } from '~/shared/split'
import { formatMinor, minor } from '~/shared/money'

const OLD = { upcoming: 'upcoming', thisWeek: 'thisWeek', earlierThisMonth: 'earlierThisMonth', lastMonth: 'lastMonth', earlierThisYear: 'earlierThisYear', lastYear: 'lastYear', older: 'older' }

describe('date headings', () => {
  it('match the current app for any day, today and first weekday', () => {
    const day = fc.integer({ min: Date.UTC(2023, 0, 1) / 864e5, max: Date.UTC(2028, 11, 31) / 864e5 }).map((n) => new Date(n * 864e5).toISOString().slice(0, 10))
    fc.assert(
      fc.property(day, day, fc.integer({ min: 0, max: 6 }), (date, today, start) => {
        const old = getExpenseGroup(dayjs(date), dayjs(today), start)
        expect(dateGroup({ date, today, weekStartsOn: start })).toBe(OLD[old as keyof typeof OLD] ?? old)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('card figures', () => {
  it('match the current app for single-payer expenses and payments', () => {
    const people = ['p1', 'p2', 'p3']
    fc.assert(
      fc.property(
        fc.integer({ min: -50000, max: 50000 }).filter((n) => n !== 0),
        fc.constantFrom(...people),
        fc.subarray(people, { minLength: 1 }),
        fc.boolean(),
        fc.constantFrom(null, ...people, 'p4'),
        (cents, payer, sharers, payment, viewer) => {
          const amount = minor(BigInt(cents))
          const shares = resolveShares({ amount, mode: 'evenly', preferredParticipantId: payer, participants: sharers.map((id) => ({ participantId: id, weight: '1' })) })
          const text = (value: bigint) => formatMinor({ amount: minor(value), currency: 'USD' })
          const names = new Map(people.map((p) => [p, p.toUpperCase()]))
          const ours = expenseRowFigures({
            expense: { kind: payment ? 'payment' : 'expense', currency: 'USD', amount: text(amount), payers: [{ participantId: payer, amount: text(amount) }], shares: [...shares].map(([participantId, a]) => ({ participantId, amount: text(a) })) },
            viewer,
            names,
          })
          const old = oldFigures(
            {
              amount: text(amount),
              currencyCode: 'USD',
              isReimbursement: payment,
              splitMode: 'EVENLY',
              id: 'x',
              paidBy: { id: payer, name: payer.toUpperCase() },
              paidFor: sharers.map((id) => ({ participant: { id, name: id.toUpperCase() }, shares: '1' })),
            } as unknown as Parameters<typeof oldFigures>[0],
            viewer,
          )
          // The current app prints amounts without trailing zeros; v2 prints the currency's decimals.
          const norm = (f: { label: string; amount: string | null; tone: string }) => ({ ...f, amount: f.amount === null ? null : Number(f.amount).toFixed(2) })
          expect({ paid: norm(ours.paid), personal: norm(ours.personal) }).toEqual({ paid: norm(old.paid), personal: norm(old.personal) })
        },
      ),
      { numRuns: 2000 },
    )
  })
})
