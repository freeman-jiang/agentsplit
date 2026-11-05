// One validation for every expense write: the form, the RPC handlers and the
// MCP tools all call validateExpense. The rules are the current app's
// (src/lib/schemas.ts expenseFormSchema), plus multiple payers.
import { Result } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'
import { formatMinor, minor, parseMinor, sumMinor, type Minor } from './money'
import { parseWeight, preferredPayer, resolveShares, type SplitMode } from './split'

export const LIMITS = { titleMin: 2, titleMax: 200, vendorMax: 100, notesMax: 5_000, people: 100, amountMax: 10_000_000n } as const

export type ExpenseDraft = {
  readonly kind: 'expense' | 'payment'
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly expenseDate: string
  readonly currency: CurrencyCode
  readonly amount: string
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly amount: string }>
  readonly splitMode: SplitMode
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly weight: string }>
  readonly recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
}

export type ResolvedExpense = Omit<ExpenseDraft, 'amount' | 'payers' | 'shares' | 'vendor'> & {
  readonly vendor: string | null
  readonly amount: Minor
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor }>
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor; readonly weight: string }>
}

export type ExpenseIssue = { readonly field: string; readonly message: string }

const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const normalizeWeight = (text: string) => {
  const { units, scale } = parseWeight(text)
  if (scale === 0) return units.toString()
  const digits = units.toString().padStart(scale + 1, '0')
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

// The current app's messages (messages/en-US.json SchemaErrors), in English only.
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const moneyMessage = (text: string, currency: CurrencyCode) =>
  DECIMAL.test(text) ? `${currency} amounts allow at most ${CURRENCIES[currency].decimals} decimal places` : 'Enter a decimal amount such as 12.34'

function sumMessage(data: { what: 'amounts' | 'payments'; sum: Minor; amount: Minor; currency: CurrencyCode }) {
  const { sum, amount, currency } = data
  const difference = minor(sum > amount ? sum - amount : amount - sum)
  const text = (value: Minor) => formatMinor({ amount: value, currency })
  return `The ${data.what} add up to ${text(sum)}, ${text(difference)} ${sum > amount ? 'more' : 'less'} than the expense amount (${text(amount)}).`
}

function percentMessage(total: { units: bigint; scale: number }) {
  const hundred = 100n * 10n ** BigInt(total.scale)
  const text = (units: bigint) => {
    const digits = units.toString().padStart(total.scale + 1, '0')
    return normalizeWeight(total.scale ? `${digits.slice(0, -total.scale)}.${digits.slice(-total.scale)}` : digits)
  }
  const difference = total.units > hundred ? total.units - hundred : hundred - total.units
  return `The percentages add up to ${text(total.units)}%, ${text(difference)}% ${total.units > hundred ? 'more' : 'less'} than 100%.`
}

/**
 * Checks a draft against the rules and the group's participants, and resolves
 * every amount into minor units. Returns every issue it finds, not only the first.
 */
export function validateExpense(data: {
  draft: ExpenseDraft
  participantIds: ReadonlySet<string>
}): Result.Result<ResolvedExpense, ReadonlyArray<ExpenseIssue>> {
  const { draft, participantIds } = data
  const issues: ExpenseIssue[] = []
  const issue = (field: string, message: string) => issues.push({ field, message })
  const { currency } = draft
  const decimals = CURRENCIES[currency].decimals

  // Not trimmed: the current app checks the title as typed (only vendor is trimmed).
  const title = draft.title
  if (title.length < LIMITS.titleMin) issue('title', 'Enter at least two characters.')
  else if (title.length > LIMITS.titleMax) issue('title', 'Enter at most 200 characters.')
  const vendor = draft.vendor?.trim() || null
  if (vendor && vendor.length > LIMITS.vendorMax) issue('vendor', 'Enter at most 100 characters.')
  if (draft.notes.length > LIMITS.notesMax) issue('notes', 'Enter at most 5,000 characters.')
  if (!Number.isInteger(draft.categoryId) || draft.categoryId < 0) issue('categoryId', 'Unknown category')
  if (!isCalendarDate(draft.expenseDate)) issue('expenseDate', 'Use a real calendar date, YYYY-MM-DD')

  const parsedAmount = parseMinor({ amount: draft.amount, currency })
  const amount = Result.isSuccess(parsedAmount) ? parsedAmount.success : undefined
  if (amount === undefined) issue('amount', moneyMessage(draft.amount, currency))
  else if (amount === 0n) issue('amount', 'The amount must not be zero.')
  else if ((amount < 0n ? -amount : amount) > LIMITS.amountMax * 10n ** BigInt(decimals))
    issue('amount', 'The amount must be at most 10,000,000.')

  // Payers: each a group participant, once, with a nonzero part of the same sign, summing to the amount.
  const payers: { participantId: string; amount: Minor }[] = []
  const payerIds = new Set<string>()
  draft.payers.forEach((payer, index) => {
    const field = `payers.${index}`
    if (!participantIds.has(payer.participantId)) issue(field, 'The payer is not in this group')
    if (payerIds.has(payer.participantId)) issue(field, 'Each payer appears once')
    payerIds.add(payer.participantId)
    const parsed = parseMinor({ amount: payer.amount, currency })
    if (Result.isFailure(parsed)) return void issue(field, moneyMessage(payer.amount, currency))
    if (parsed.success === 0n || (amount !== undefined && parsed.success < 0n !== amount < 0n))
      return void issue(field, 'Each payment must be nonzero, with the same sign as the amount')
    payers.push({ participantId: payer.participantId, amount: parsed.success })
  })
  if (draft.payers.length === 0) issue('payers', 'You must select a participant.')
  if (amount !== undefined && payers.length === draft.payers.length && payers.length && sumMinor(payers.map((p) => p.amount)) !== amount)
    issue('payers', sumMessage({ what: 'payments', sum: sumMinor(payers.map((p) => p.amount)), amount, currency }))

  // Shares: as the current app.
  if (draft.shares.length === 0) issue('shares', 'The expense must be paid for at least one participant.')
  if (draft.shares.length > LIMITS.people) issue('shares', `At most ${LIMITS.people} people`)
  const shareIds = new Set<string>()
  const weights: { participantId: string; weight: string }[] = []
  let percentTotal = 0n
  let percentScale = 0
  draft.shares.forEach((share, index) => {
    const field = `shares.${index}`
    if (!participantIds.has(share.participantId)) issue(field, 'This person is not in this group')
    if (shareIds.has(share.participantId)) issue(field, 'Duplicate beneficiary')
    shareIds.add(share.participantId)
    if (draft.splitMode === 'amount') {
      const parsed = parseMinor({ amount: share.weight, currency })
      if (Result.isFailure(parsed)) return void issue(field, moneyMessage(share.weight, currency))
      if (parsed.success === 0n || (amount !== undefined && parsed.success < 0n !== amount < 0n))
        return void issue(field, 'Each amount must be nonzero, with the same sign as the total')
      return void weights.push({ participantId: share.participantId, weight: parsed.success.toString() })
    }
    let weight: ReturnType<typeof parseWeight>
    try {
      weight = parseWeight(share.weight)
    } catch {
      return void issue(field, /^-/.test(share.weight) ? 'All shares must be higher than 0.' : 'Enter a decimal amount such as 12.34')
    }
    if (weight.units === 0n) return void issue(field, 'All shares must be higher than 0.')
    // An even split ignores the weight, but the current app still requires it to be positive.
    if (draft.splitMode === 'evenly') return void weights.push({ participantId: share.participantId, weight: '1' })
    if (draft.splitMode === 'percentage') {
      const scale = Math.max(percentScale, weight.scale)
      percentTotal = percentTotal * 10n ** BigInt(scale - percentScale) + weight.units * 10n ** BigInt(scale - weight.scale)
      percentScale = scale
    }
    weights.push({ participantId: share.participantId, weight: normalizeWeight(share.weight) })
  })
  if (draft.splitMode === 'percentage' && weights.length === draft.shares.length && percentTotal !== 100n * 10n ** BigInt(percentScale))
    issue('shares', percentMessage({ units: percentTotal, scale: percentScale }))
  if (draft.splitMode === 'amount' && amount !== undefined && weights.length === draft.shares.length) {
    const sum = sumMinor(weights.map((w) => minor(BigInt(w.weight))))
    if (sum !== amount) issue('shares', sumMessage({ what: 'amounts', sum, amount, currency }))
  }

  if (issues.length || amount === undefined) return Result.fail(issues)
  const resolved = resolveShares({ amount, mode: draft.splitMode, preferredParticipantId: preferredPayer(payers), participants: weights })
  return Result.succeed({
    ...draft,
    title,
    vendor,
    amount,
    payers,
    shares: weights.map((w) => ({ ...w, amount: resolved.get(w.participantId) ?? minor(0n) })),
  })
}
