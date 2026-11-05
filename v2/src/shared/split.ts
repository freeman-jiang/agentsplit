// Splitting without Effect, for the client and the server alike. The schema
// of a split mode is SplitModeSchema in shared/api/core.ts.
import { minor, sumMinor, type Minor } from './minor'

export const SPLIT_MODES = ['evenly', 'shares', 'percentage', 'amount'] as const
export type SplitMode = (typeof SPLIT_MODES)[number]

/** A weight is an exact non-negative decimal: a share count, a percentage, or an amount. */
export type Weight = { readonly units: bigint; readonly scale: number }

export function parseWeight(text: string): Weight {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text)
  if (!match) throw new Error(`Invalid split weight: ${text}`)
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  return { units: BigInt((match[1] ?? '0') + fraction), scale: fraction.length }
}

const atScale = (weight: Weight, scale: number) => weight.units * 10n ** BigInt(scale - weight.scale)

export class SplitError extends Error {
  readonly _tag = 'SplitError'
  constructor(readonly reason: 'no-participants' | 'zero-weights' | 'amount-mismatch') {
    super(`Split failed: ${reason}`)
  }
}

/**
 * Divides `amount` in proportion to `weights`, in whole minor units.
 * Each part is floored; the leftover units go first to `preferred`, then by
 * largest remainder, then by position. The parts always sum to `amount`.
 * This is the current app's rule (src/lib/shares.ts), on integers.
 */
export function apportion(data: {
  amount: Minor
  weights: readonly Weight[]
  preferred: number
}): Minor[] {
  const { weights, preferred } = data
  if (weights.length === 0) return []
  const negative = data.amount < 0n
  const units = negative ? -data.amount : data.amount
  const scale = Math.max(...weights.map((w) => w.scale))
  const scaled = weights.map((w) => atScale(w, scale))
  const total = scaled.reduce((a, b) => a + b, 0n)
  if (total === 0n) return weights.map(() => minor(0n))
  const parts = scaled.map((w) => (units * w) / total)
  const order = scaled
    .map((w, index) => ({ index, remainder: units * w - (parts[index] ?? 0n) * total }))
    .sort(
      (a, b) =>
        Number(b.index === preferred) - Number(a.index === preferred) ||
        (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0) ||
        a.index - b.index,
    )
  const leftover = Number(units - parts.reduce((a, b) => a + b, 0n))
  for (let i = 0; i < leftover; i++) {
    const index = order[i]?.index ?? 0
    parts[index] = (parts[index] ?? 0n) + 1n
  }
  return parts.map((part) => minor(negative ? -part : part))
}

/** Code-unit order, as the current app sorts participant IDs (`a < b`). */
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export type ShareInput = {
  readonly amount: Minor
  readonly mode: SplitMode
  /** The participant who receives the first leftover unit. */
  readonly preferredParticipantId: string
  /** Weights as exact decimal text. For `amount` mode the weights are minor units. */
  readonly participants: ReadonlyArray<{ readonly participantId: string; readonly weight: string }>
}

/** The resolved amount each participant owes for one expense, in minor units. */
export function resolveShares(input: ShareInput): ReadonlyMap<string, Minor> {
  const people = [...input.participants].sort((a, b) => compareIds(a.participantId, b.participantId))
  if (input.mode === 'amount') {
    const exact = people.map((p) => minor(BigInt(p.weight)))
    if (sumMinor(exact) === input.amount) return new Map(people.map((p, i) => [p.participantId, exact[i] ?? minor(0n)]))
  }
  const weights = people.map((p) => parseWeight(input.mode === 'evenly' ? '1' : p.weight.replace(/^-/, '')))
  const parts = apportion({
    amount: input.amount,
    weights,
    preferred: people.findIndex((p) => p.participantId === input.preferredParticipantId),
  })
  return new Map(people.map((p, i) => [p.participantId, parts[i] ?? minor(0n)]))
}

/** The payer who receives the first leftover unit: the largest payment, then the smallest ID. */
export function preferredPayer(payers: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor }>): string {
  const [first] = [...payers].sort(
    (a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0) || compareIds(a.participantId, b.participantId),
  )
  if (!first) throw new SplitError('no-participants')
  return first.participantId
}
