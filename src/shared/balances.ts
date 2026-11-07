import { Schema } from 'effect'
import type { CurrencyCode } from './currencies'
import { minor, type Minor } from './minor'
import { compareIds } from './split'

/** One ledger entry as balances see it: who paid and who owes, in one currency. */
export type LedgerEntry = {
  readonly currency: CurrencyCode
  readonly payers: ReadonlyMap<string, Minor>
  readonly shares: ReadonlyMap<string, Minor>
}

export type Balance = { readonly paid: Minor; readonly owed: Minor; readonly net: Minor }

class LedgerImbalanceError extends Schema.TaggedError<LedgerImbalanceError>()(
  'LedgerImbalanceError',
  { currency: Schema.String, net: Schema.String },
) {}

/**
 * Balances per currency and participant. Currencies never mix. Each currency's
 * nets sum to zero; any other result means the ledger is corrupt, so it throws.
 */
export function computeBalances(entries: Iterable<LedgerEntry>): Map<CurrencyCode, Map<string, Balance>> {
  const totals = new Map<CurrencyCode, Map<string, { paid: bigint; owed: bigint }>>()
  const row = (currency: CurrencyCode, participantId: string) => {
    const byPerson = totals.get(currency) ?? new Map<string, { paid: bigint; owed: bigint }>()
    totals.set(currency, byPerson)
    const found = byPerson.get(participantId) ?? { paid: 0n, owed: 0n }
    byPerson.set(participantId, found)
    return found
  }
  for (const entry of entries) {
    for (const [id, amount] of entry.payers) row(entry.currency, id).paid += amount
    for (const [id, amount] of entry.shares) row(entry.currency, id).owed += amount
  }
  const result = new Map<CurrencyCode, Map<string, Balance>>()
  for (const [currency, byPerson] of [...totals].sort(([a], [b]) => compareIds(a, b))) {
    let sum = 0n
    const balances = new Map<string, Balance>()
    for (const [id, { paid, owed }] of byPerson) {
      sum += paid - owed
      balances.set(id, { paid: minor(paid), owed: minor(owed), net: minor(paid - owed) })
    }
    if (sum !== 0n) throw new LedgerImbalanceError({ currency, net: sum.toString() })
    result.set(currency, balances)
  }
  return result
}

export type Settlement = { readonly from: string; readonly to: string; readonly amount: Minor }

/**
 * Suggested repayments for one currency, stable across settlements: creditors
 * first, then by participant ID; the largest debtor at the end pays the first
 * creditor. This is the current app's rule (src/lib/balances.ts).
 */
export function suggestSettlements(balances: ReadonlyMap<string, Balance>): Settlement[] {
  const rows = [...balances]
    .map(([participantId, { net }]) => ({ participantId, total: net as bigint }))
    .filter((r) => r.total !== 0n)
    .sort((a, b) => (a.total > 0n) !== (b.total > 0n) ? (a.total > 0n ? -1 : 1) : compareIds(a.participantId, b.participantId))
  const result: Settlement[] = []
  while (rows.length > 1) {
    const first = rows[0]
    const last = rows[rows.length - 1]
    if (!first || !last) break
    const amount = first.total < -last.total ? first.total : -last.total
    if (amount <= 0n) throw new LedgerImbalanceError({ currency: '', net: amount.toString() })
    result.push({ from: last.participantId, to: first.participantId, amount: minor(amount) })
    first.total -= amount
    last.total += amount
    if (first.total === 0n) rows.shift()
    if (last.total === 0n) rows.pop()
  }
  if (rows.length && rows[0]?.total !== 0n) throw new LedgerImbalanceError({ currency: '', net: String(rows[0]?.total) })
  return result
}
