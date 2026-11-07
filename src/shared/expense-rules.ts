// One validation for every expense write: the form, the RPC handlers and the
// MCP tools all call validateExpense. The rules are the current app's
// (src/lib/schemas.ts expenseFormSchema), plus multiple payers.
import { CURRENCIES, type CurrencyCode } from './currencies'
import { isCalendarDate } from './dates'
import { LIMITS, numberText } from './limits'
import { DECIMAL, formatMinor, minor, minorOrNull, sumMinor, type Minor } from './minor'
import { formatWeight, parseWeight, preferredPayer, resolveShares } from './split'
import type { ExpenseKind, Recurrence, SplitMode } from './vocabulary'

export type ExpenseDraft = {
  readonly kind: ExpenseKind
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
  readonly recurrence: Recurrence
}

export type ResolvedExpense = Omit<ExpenseDraft, 'amount' | 'payers' | 'shares' | 'vendor'> & {
  readonly vendor: string | null
  readonly amount: Minor
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor }>
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly amount: Minor; readonly weight: string }>
}

/** One problem of a draft. `row` names the payer or share it is about; its field is then `payers.<index>` or `shares.<index>`. */
export type ExpenseIssue = { readonly field: string; readonly message: string; readonly row?: { readonly list: 'payers' | 'shares'; readonly participantId: string } }

// The current app's messages (messages/en-US.json SchemaErrors), in English only.
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
  const text = (units: bigint) => formatWeight({ units, scale: total.scale })
  const difference = total.units > hundred ? total.units - hundred : hundred - total.units
  return `The percentages add up to ${text(total.units)}%, ${text(difference)}% ${total.units > hundred ? 'more' : 'less'} than 100%.`
}

/** The outcome of validateExpense. A plain union, so the form can use it without loading Effect. */
export type ExpenseCheck = { readonly ok: true; readonly value: ResolvedExpense } | { readonly ok: false; readonly issues: ReadonlyArray<ExpenseIssue> }

/** The money of a draft: what checkMoney checks and resolves. */
export type MoneyDraft = Pick<ExpenseDraft, 'currency' | 'amount' | 'payers' | 'splitMode' | 'shares'>
type ResolvedMoney = Pick<ResolvedExpense, 'amount' | 'payers' | 'shares'>
type MoneyCheck = { readonly ok: true; readonly value: ResolvedMoney } | { readonly ok: false; readonly issues: ReadonlyArray<ExpenseIssue> }

/**
 * Checks a draft against the rules and the group's participants, and resolves
 * every amount into minor units. Returns every issue it finds, not only the first.
 */
export function validateExpense(data: {
  draft: ExpenseDraft
  participantIds: ReadonlySet<string>
}): ExpenseCheck {
  const { draft } = data
  const issues: ExpenseIssue[] = []
  const issue = (field: string, message: string) => issues.push({ field, message })

  // Not trimmed: the current app checks the title as typed (only vendor is trimmed).
  const title = draft.title
  if (title.length < LIMITS.titleMin) issue('title', `Enter at least ${numberText(LIMITS.titleMin)} characters.`)
  else if (title.length > LIMITS.titleMax) issue('title', `Enter at most ${numberText(LIMITS.titleMax)} characters.`)
  const vendor = draft.vendor?.trim() || null
  if (vendor && vendor.length > LIMITS.vendorMax) issue('vendor', `Enter at most ${numberText(LIMITS.vendorMax)} characters.`)
  if (draft.notes.length > LIMITS.notesMax) issue('notes', `Enter at most ${numberText(LIMITS.notesMax)} characters.`)
  if (!Number.isInteger(draft.categoryId) || draft.categoryId < 0) issue('categoryId', 'Unknown category')
  if (!isCalendarDate(draft.expenseDate)) issue('expenseDate', 'Use a real calendar date, YYYY-MM-DD')

  const money = checkMoney({ money: draft, participantIds: data.participantIds })
  if (!money.ok || issues.length) return { ok: false, issues: [...issues, ...(money.ok ? [] : money.issues)] }
  return { ok: true, value: { ...draft, title, vendor, ...money.value } }
}

/** The money rules alone: the amount, the payers and the split, resolved into minor units. The form's share preview uses it before the other fields are filled. */
export function checkMoney(data: { money: MoneyDraft; participantIds: ReadonlySet<string> }): MoneyCheck {
  const { money: draft, participantIds } = data
  const issues: ExpenseIssue[] = []
  const issue = (field: string, message: string) => issues.push({ field, message })
  const rowIssue = (row: NonNullable<ExpenseIssue['row']>, index: number, message: string) => issues.push({ field: `${row.list}.${index}`, message, row })
  const { currency } = draft
  const decimals = CURRENCIES[currency].decimals

  const amount = minorOrNull({ amount: draft.amount, currency }) ?? undefined
  if (amount === undefined) issue('amount', moneyMessage(draft.amount, currency))
  else if (amount === 0n) issue('amount', 'The amount must not be zero.')
  else if ((amount < 0n ? -amount : amount) > BigInt(LIMITS.amountMax) * 10n ** BigInt(decimals))
    issue('amount', `The amount must be at most ${numberText(LIMITS.amountMax)}.`)

  // Payers: each a group participant, once, with a nonzero part of the same sign, summing to the amount.
  const payers: { participantId: string; amount: Minor }[] = []
  const payerIds = new Set<string>()
  draft.payers.forEach((payer, index) => {
    const problem = (message: string) => rowIssue({ list: 'payers', participantId: payer.participantId }, index, message)
    if (!participantIds.has(payer.participantId)) problem('The payer is not in this group')
    if (payerIds.has(payer.participantId)) problem('Each payer appears once')
    payerIds.add(payer.participantId)
    const parsed = minorOrNull({ amount: payer.amount, currency })
    if (parsed === null) return void problem(moneyMessage(payer.amount, currency))
    if (parsed === 0n || (amount !== undefined && parsed < 0n !== amount < 0n))
      return void problem('Each payment must be nonzero, with the same sign as the amount')
    payers.push({ participantId: payer.participantId, amount: parsed })
  })
  if (draft.payers.length === 0) issue('payers', 'You must select a participant.')
  if (amount !== undefined && payers.length === draft.payers.length && payers.length && sumMinor(payers.map((p) => p.amount)) !== amount)
    issue('payers', sumMessage({ what: 'payments', sum: sumMinor(payers.map((p) => p.amount)), amount, currency }))

  // Shares: as the current app.
  if (draft.shares.length === 0) issue('shares', 'The expense must be paid for at least one participant.')
  if (draft.shares.length > LIMITS.participantsPerGroup) issue('shares', `At most ${LIMITS.participantsPerGroup} people`)
  const shareIds = new Set<string>()
  const weights: { participantId: string; weight: string }[] = []
  let percentTotal = 0n
  let percentScale = 0
  draft.shares.forEach((share, index) => {
    const problem = (message: string) => rowIssue({ list: 'shares', participantId: share.participantId }, index, message)
    if (!participantIds.has(share.participantId)) problem('This person is not in this group')
    if (shareIds.has(share.participantId)) problem('Duplicate beneficiary')
    shareIds.add(share.participantId)
    if (draft.splitMode === 'amount') {
      const parsed = minorOrNull({ amount: share.weight, currency })
      if (parsed === null) return void problem(moneyMessage(share.weight, currency))
      if (parsed === 0n || (amount !== undefined && parsed < 0n !== amount < 0n))
        return void problem('Each amount must be nonzero, with the same sign as the total')
      return void weights.push({ participantId: share.participantId, weight: parsed.toString() })
    }
    let weight: ReturnType<typeof parseWeight>
    try {
      weight = parseWeight(share.weight)
    } catch {
      return void problem(/^-/.test(share.weight) ? 'All shares must be higher than 0.' : 'Enter a decimal amount such as 12.34')
    }
    if (weight.units === 0n) return void problem('All shares must be higher than 0.')
    // An even split ignores the weight, but the current app still requires it to be positive.
    if (draft.splitMode === 'evenly') return void weights.push({ participantId: share.participantId, weight: '1' })
    if (draft.splitMode === 'percentage') {
      const scale = Math.max(percentScale, weight.scale)
      percentTotal = percentTotal * 10n ** BigInt(scale - percentScale) + weight.units * 10n ** BigInt(scale - weight.scale)
      percentScale = scale
    }
    weights.push({ participantId: share.participantId, weight: formatWeight(weight) })
  })
  if (draft.splitMode === 'percentage' && weights.length === draft.shares.length && percentTotal !== 100n * 10n ** BigInt(percentScale))
    issue('shares', percentMessage({ units: percentTotal, scale: percentScale }))
  if (draft.splitMode === 'amount' && amount !== undefined && weights.length === draft.shares.length) {
    const sum = sumMinor(weights.map((w) => minor(BigInt(w.weight))))
    if (sum !== amount) issue('shares', sumMessage({ what: 'amounts', sum, amount, currency }))
  }

  if (issues.length || amount === undefined) return { ok: false, issues }
  const resolved = resolveShares({ amount, mode: draft.splitMode, preferredParticipantId: preferredPayer(payers), participants: weights })
  return { ok: true, value: { amount, payers, shares: weights.map((w) => ({ ...w, amount: resolved.get(w.participantId) ?? minor(0n) })) } }
}
