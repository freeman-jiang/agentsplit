// The v2 money rules must give exactly the current app's results. These tests
// run the current app's own code (../src/lib) on random expenses and compare.
import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { getSuggestedReimbursements } from '../../../src/lib/balances'
import { getExpenseShares } from '../../../src/lib/shares'
import { computeBalances, suggestSettlements } from '~/shared/balances'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { formatMinor, minor, parseMinor, type Minor } from '~/shared/money'
import { resolveShares, type SplitMode } from '~/shared/split'

const OLD_MODE = { evenly: 'EVENLY', shares: 'BY_SHARES', percentage: 'BY_PERCENTAGE', amount: 'BY_AMOUNT' } as const
const currencies = Object.keys(CURRENCIES) as CurrencyCode[]

const decimalText = (value: string) => value.replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '')

const expenseArb = fc
  .record({
    currency: fc.constantFrom(...currencies),
    amount: fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
    mode: fc.constantFrom<SplitMode>('evenly', 'shares', 'percentage', 'amount'),
    people: fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 7 }),
    weights: fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 7, maxLength: 7 }),
    payerIndex: fc.nat(),
  })
  .map((e) => ({ ...e, payer: e.people[e.payerIndex % e.people.length] ?? '' }))

describe('resolveShares matches the current app', () => {
  it('for every split mode, currency and sign', () => {
    fc.assert(
      fc.property(expenseArb, (e) => {
        const amount = minor(e.amount)
        const weights = e.people.map((_, i) => e.weights[i] ?? 0)
        // Old weights: share counts and percentages as decimals; amount-mode weights in currency units.
        const oldWeight = (w: number) =>
          e.mode === 'amount' ? formatMinor({ amount: minor(BigInt(w)), currency: e.currency }) : (w / 100).toFixed(2)
        const newWeight = (w: number) => (e.mode === 'amount' ? String(w) : decimalText((w / 100).toFixed(2)))
        const old = getExpenseShares({
          amount: formatMinor({ amount, currency: e.currency }),
          currencyCode: e.currency,
          paidById: e.payer,
          splitMode: OLD_MODE[e.mode],
          paidFor: e.people.map((participantId, i) => ({ participantId, shares: oldWeight(weights[i] ?? 0) })),
        })
        const next = resolveShares({
          amount,
          mode: e.mode,
          preferredParticipantId: e.payer,
          participants: e.people.map((participantId, i) => ({ participantId, weight: newWeight(weights[i] ?? 0) })),
        })
        expect([...next.keys()]).toEqual([...old.keys()])
        for (const [id, value] of next) {
          const expected = Result.getOrThrow(parseMinor({ amount: old.get(id) ?? '', currency: e.currency }))
          expect(value).toBe(expected)
        }
      }),
      { numRuns: 3000 },
    )
  })
})

describe('balances', () => {
  const ledgerArb = fc.array(expenseArb, { minLength: 1, maxLength: 25 })

  it('net to zero in every currency (conservation)', () => {
    fc.assert(
      fc.property(ledgerArb, (expenses) => {
        const entries = expenses.map((e) => {
          const amount = minor(e.amount)
          const shares = resolveShares({
            amount,
            mode: e.mode === 'amount' ? 'shares' : e.mode,
            preferredParticipantId: e.payer,
            participants: e.people.map((participantId, i) => ({ participantId, weight: String(e.weights[i] ?? 0) })),
          })
          const zeroWeights = [...shares.values()].every((v) => v === 0n) && amount !== 0n
          return { currency: e.currency, payers: new Map<string, Minor>(zeroWeights ? [] : [[e.payer, amount]]), shares }
        })
        for (const balances of computeBalances(entries).values()) {
          let sum = 0n
          for (const b of balances.values()) sum += b.net
          expect(sum).toBe(0n)
        }
      }),
    )
  })

  it('settlement suggestions match the current app and settle every balance', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: -100_000n, max: 100_000n }), { minLength: 1, maxLength: 9 }), (values) => {
        const nets = [...values, -values.reduce((a, b) => a + b, 0n)]
        const balances = new Map(nets.map((net, i) => [`p${i}`, { paid: minor(0n), owed: minor(0n), net: minor(net) }]))
        const next = suggestSettlements(balances)
        const old = getSuggestedReimbursements(
          Object.fromEntries(nets.map((net, i) => [`p${i}`, { paid: '0', paidFor: '0', total: formatMinor({ amount: minor(net), currency: 'JPY' }) }])),
        )
        expect(next.map((s) => ({ from: s.from, to: s.to, amount: formatMinor({ amount: s.amount, currency: 'JPY' }) }))).toEqual(old)
        const after = new Map(nets.map((net, i) => [`p${i}`, net]))
        for (const s of next) {
          after.set(s.from, (after.get(s.from) ?? 0n) + s.amount)
          after.set(s.to, (after.get(s.to) ?? 0n) - s.amount)
        }
        expect([...after.values()].every((v) => v === 0n)).toBe(true)
      }),
    )
  })
})

describe('money parsing', () => {
  it('round-trips minor units through decimal strings', () => {
    fc.assert(
      fc.property(fc.constantFrom(...currencies), fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (currency, value) => {
        const text = formatMinor({ amount: minor(value), currency })
        expect(Result.getOrThrow(parseMinor({ amount: text, currency }))).toBe(value)
      }),
    )
  })

  it('rejects more decimals than the currency allows', () => {
    expect(Result.isFailure(parseMinor({ amount: '1.005', currency: 'USD' }))).toBe(true)
    expect(Result.isFailure(parseMinor({ amount: '1.5', currency: 'JPY' }))).toBe(true)
    expect(Result.getOrThrow(parseMinor({ amount: '1.50', currency: 'USD' }))).toBe(150n)
    expect(Result.getOrThrow(parseMinor({ amount: '-0.07', currency: 'USD' }))).toBe(-7n)
  })
})
