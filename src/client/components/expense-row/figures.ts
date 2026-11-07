// What an expense row says about the viewer, ported from the current app's
// src/lib/expense-row.ts, for several payers. Presentation only: the amounts
// come from the stored, resolved parts.
import type { CurrencyCode } from '~/shared/currencies'
import { formatMinor, minor, minorOrNull } from '~/shared/minor'
import type { ExpenseKind } from '~/shared/vocabulary'

type Part = { readonly participantId: string; readonly amount: string }
export type RowExpense = {
  readonly kind: ExpenseKind
  readonly currency: CurrencyCode
  readonly amount: string
  readonly payers: readonly Part[]
  readonly shares: readonly Part[]
}
export type Tone = 'neutral' | 'positive' | 'negative'
type Figure = { readonly label: string; readonly amount: string | null; readonly tone: Tone }

const units = (amount: string, currency: CurrencyCode) => minorOrNull({ amount, currency }) ?? 0n
const abs = (value: bigint) => (value < 0n ? -value : value)

/** "Alice and Bob", "Alice, Bob and Cara", with "you" for the viewer. */
export function namesOf(data: { ids: readonly string[]; names: ReadonlyMap<string, string>; viewer: string | null }) {
  const list = data.ids.map((id) => (id === data.viewer ? 'you' : (data.names.get(id) ?? 'Unknown')))
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** The two figures of a row: what was paid, and what it means for the viewer. */
export function expenseRowFigures(data: { expense: RowExpense; viewer: string | null; names: ReadonlyMap<string, string> }): { paid: Figure; personal: Figure } {
  const { expense, viewer } = data
  const { currency } = expense
  const text = (value: bigint) => formatMinor({ amount: minor(value), currency })
  const amount = units(expense.amount, currency)
  const income = amount < 0n
  const payer = viewer !== null && expense.payers.some((p) => p.participantId === viewer)
  const paid: Figure = {
    label: `${namesOf({ ids: expense.payers.map((p) => p.participantId), names: data.names, viewer })} ${income ? 'received' : 'paid'}`,
    amount: text(abs(amount)),
    tone: 'neutral',
  }
  if (!viewer) return { paid, personal: { label: 'identity not linked', amount: null, tone: 'neutral' } }
  const paidByViewer = expense.payers.filter((p) => p.participantId === viewer).reduce((sum, p) => sum + units(p.amount, currency), 0n)
  const shareRow = expense.shares.find((s) => s.participantId === viewer)
  if (!payer && !shareRow) return { paid, personal: { label: 'not involved', amount: null, tone: 'neutral' } }
  const share = shareRow ? units(shareRow.amount, currency) : 0n
  const net = paidByViewer - share
  if (expense.kind === 'payment')
    return { paid, personal: { label: payer !== income ? 'you repaid' : 'you received', amount: text(payer ? abs(net) : abs(share)), tone: 'neutral' } }
  if (income) return { paid, personal: { label: 'your share', amount: text(abs(share)), tone: 'positive' } }
  return {
    paid,
    personal: {
      label: net > 0n ? 'you lent' : net < 0n ? 'you borrowed' : 'your share',
      amount: text(net === 0n ? abs(share) : abs(net)),
      tone: net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral',
    },
  }
}

/** Who wrote an entry, on a compact row: "Last edited by", else "Added by"; never a time. */
export function attributionLine(data: { addedBy: string | null; editedBy: string | null }) {
  if (data.editedBy) return `Last edited by ${data.editedBy}`
  if (data.addedBy) return `Added by ${data.addedBy}`
  return 'Original author unavailable'
}
