// v1 snapshots must read exactly as the current app shows them. These tests run
// the current app's revision display (../src/lib/expense-history-display.ts)
// and splitter on random v1 snapshots and compare every field.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { describeExpenseRevision } from '../../../src/lib/expense-history-display'
import { getExpenseShares } from '../../../src/lib/shares'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { describeRevision, readSnapshot } from '~/shared/history'
import { formatMinor, minor } from '~/shared/money'
import { v1Snapshot } from '../db/history-fixtures'

const currencies = Object.keys(CURRENCIES) as CurrencyCode[]
const MODES = ['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'] as const
/** The current app's decimalStrings: minimal decimal text. */
const minimal = (text: string) => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text)

const snapshotArb = fc
  .record({
    currency: fc.constantFrom(...currencies),
    amount: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((a) => a !== 0n),
    mode: fc.constantFrom(...MODES),
    people: fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 6 }),
    weights: fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 6, maxLength: 6 }),
    exactAmounts: fc.boolean(),
    payerIndex: fc.nat(),
    vendor: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
    reimbursement: fc.boolean(),
    recurrence: fc.constantFrom('NONE', 'DAILY', 'WEEKLY', 'MONTHLY', null),
    notes: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
    urls: fc.array(fc.webUrl(), { maxLength: 3 }),
  })
  .map((r) => {
    const money = (units: bigint) => minimal(formatMinor({ amount: minor(units), currency: r.currency }))
    const weights = r.people.map((_, i) => BigInt(r.weights[i] ?? 0))
    // Amount splits: either parts that add up exactly, or arbitrary amounts (the fallback path).
    if (r.mode === 'BY_AMOUNT' && r.exactAmounts) {
      const total = weights.reduce((a, b) => a + b, 0n) || 1n
      let left = r.amount
      weights.forEach((w, i) => {
        weights[i] = i === weights.length - 1 ? left : (r.amount * w) / total
        left -= weights[i] ?? 0n
      })
    }
    const shares = weights.map((w) => (r.mode === 'BY_AMOUNT' ? money(w) : minimal((Number(w) / 100).toFixed(2))))
    const payer = r.people[r.payerIndex % r.people.length] ?? ''
    return {
      ...r,
      snapshot: v1Snapshot({
        id: 'x',
        groupId: 'g',
        revision: 1,
        title: 'Title',
        vendor: r.vendor,
        amount: money(r.amount),
        currencyCode: r.currency,
        expenseDate: '2024-02-29',
        createdAt: '2024-02-29T08:00:00.000Z',
        categoryId: 9,
        category: { id: 9, grouping: 'Food and Drink', name: 'Groceries' },
        paidBy: { id: payer, name: `name-${payer}` },
        paidFor: r.people.map((p, i) => ({ participantId: p, name: `name-${p}`, shares: shares[i] ?? '0' })),
        splitMode: r.mode,
        isReimbursement: r.reimbursement,
        notes: r.notes,
        recurrenceRule: r.recurrence,
        documents: r.urls.map((url, i) => ({ id: `d${i}`, url, width: 1, height: 1 })),
      }),
    }
  })

describe('v1 snapshots read as the current app shows them', () => {
  it('gives every participant the current app’s exact share', () => {
    fc.assert(
      fc.property(snapshotArb, ({ snapshot, currency }) => {
        const state = readSnapshot({ raw: snapshot, categories: new Map() })
        if (state._tag !== 'expense') throw new Error('Expected an expense')
        const e = snapshot.expense
        const old = getExpenseShares({ amount: e.amount, currencyCode: currency, paidById: e.paidBy.id, splitMode: e.splitMode, paidFor: e.paidFor })
        for (const s of state.expense.shares) expect(minimal(s.amount)).toBe(minimal(old.get(s.participantId) ?? '0'))
        // With any nonzero weight, shares add up to the amount, as balances require. Zero total
        // weight gives zero shares in both apps (legacy rows only, P-MONEY-57).
        const units = (text: string) => BigInt(text.replace('.', ''))
        if (e.splitMode === 'EVENLY' || e.paidFor.some((p) => Number(p.shares) !== 0))
          expect(state.expense.shares.reduce((sum, s) => sum + units(s.amount), 0n)).toBe(units(state.expense.amount))
      }),
      { numRuns: 500 },
    )
  })

  it('shows every revision field as the current app’s panel does', () => {
    fc.assert(
      fc.property(snapshotArb, ({ snapshot, mode }) => {
        const state = readSnapshot({ raw: snapshot, categories: new Map() })
        if (state._tag !== 'expense') throw new Error('Expected an expense')
        // The current app's parser types the snapshot; this is the stored JSON it parses.
        const old = describeExpenseRevision(snapshot as Parameters<typeof describeExpenseRevision>[0], 'en-US')
        const ours = describeRevision(state.expense)
        expect({ ...ours, splits: undefined }).toEqual({ ...old, splits: undefined })
        // Amount-split weights are shown at the currency's precision ("12.30", not "12.3"), so a
        // v1 revision and the v2 revision after it compare equal. Other weights read the same.
        if (mode !== 'BY_AMOUNT') expect(ours.splits).toBe(old.splits)
        else expect(ours.splits.replace(/\(share [^)]*\)/g, '')).toBe(old.splits.replace(/\(share [^)]*\)/g, ''))
      }),
      { numRuns: 500 },
    )
  })
})
