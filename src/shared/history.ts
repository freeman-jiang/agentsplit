// Saved history as readers return it (src/shared/snapshots.ts reads the
// stored formats into it), and its display for the revision panel. The
// contract's schemas of the same shapes are in src/shared/api/history.ts: the
// RPC handlers and the client's revision panel make the compiler check that
// each fits the other.
// No Effect import: the client bundle uses this module (BUILDING.md).
import { CURRENCIES, isCurrencyCode, type CurrencyCode } from './currencies'
import type { DecimalString } from './minor'
import type { ExpenseKind, Recurrence, SplitMode } from './vocabulary'

export type Category = { readonly grouping: string; readonly name: string }

/** A saved receipt pointer. `deleted` is set by the server when the receipt was deleted for good since. */
export type SavedDocument = { readonly id: string; readonly url: string; readonly deleted?: { readonly by: string; readonly at: string } | null }

/** One saved expense revision, whatever format stored it. Money is decimal text at the currency's precision. */
export type SavedExpense = {
  readonly schemaVersion: 1 | 2
  readonly id: string
  readonly revision: number
  readonly kind: ExpenseKind
  readonly title: string
  readonly vendor: string | null
  readonly notes: string
  readonly categoryId: number
  readonly category: Category | null
  /** YYYY-MM-DD. */
  readonly expenseDate: string
  /** ISO timestamp of the expense's creation, as saved. */
  readonly createdAt: string
  readonly currency: CurrencyCode
  readonly amount: DecimalString
  readonly payers: ReadonlyArray<{ readonly participantId: string; readonly name: string; readonly amount: DecimalString }>
  readonly splitMode: SplitMode
  /** `weight` is the split input as people read it: a share count, a percentage, or an amount in major units. */
  readonly shares: ReadonlyArray<{ readonly participantId: string; readonly name: string; readonly amount: DecimalString; readonly weight: string }>
  readonly recurrence: Recurrence
  readonly originalAmount: string | null
  readonly originalCurrency: string | null
  readonly conversionRate: string | null
  /** Saved receipt pointers. Early v2 snapshots store only the count. */
  readonly documents: ReadonlyArray<SavedDocument>
  readonly documentCount: number
  /**
   * The group as the revision saved it; `currency` is its code when one was
   * saved. Readers fill it; the RPC contract leaves it out, so clients lack it.
   */
  readonly group?: { readonly id: string; readonly name: string; readonly slug: string | null; readonly currency: string } | null
}

export type SavedGroup = {
  readonly schemaVersion: 1 | 2
  readonly name: string
  readonly slug: string | null
  readonly currency: string
  readonly information: string
  readonly participants: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export type SavedState = { readonly _tag: 'expense'; readonly expense: SavedExpense } | { readonly _tag: 'group'; readonly group: SavedGroup }

// ---------- display ----------

/** "1,234.50 USD": the currency's decimals and the ISO code, as the current app's revision panel shows. */
function codeAmount(amount: string, currency: string): string {
  const decimals = isCurrencyCode(currency) ? CURRENCIES[currency].decimals : 2
  const negative = amount.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const digits = decimals === 0 ? '' : `.${fraction.padEnd(decimals, '0').slice(0, decimals)}`
  return `${negative ? '-' : ''}${grouped}${digits} ${currency}`
}

export const REVISION_FIELDS = [
  ['title', 'Title'],
  ['vendor', 'Vendor'],
  ['amount', 'Amount'],
  ['date', 'Expense date'],
  ['payer', 'Paid by'],
  ['splits', 'Split between'],
  ['splitMode', 'Split rule'],
  ['reimbursement', 'Payment'],
  ['category', 'Category'],
  ['originalAmount', 'Original amount'],
  ['conversionRate', 'Exchange rate'],
  ['recurrence', 'Recurrence'],
  ['notes', 'Notes'],
  ['attachments', 'Attachment references'],
] as const
export type RevisionField = (typeof REVISION_FIELDS)[number][0]

const SPLIT_LABEL: Record<SplitMode, string> = { evenly: 'Evenly', shares: 'By shares', percentage: 'By percentage', amount: 'By amount' }
const RECURRENCE_LABEL: Record<Recurrence, string> = { none: 'None', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

/**
 * Every field of the revision panel as text. Changed fields are found by
 * comparing these strings, as the current app does, so a v1 revision and the
 * v2 revision after it compare equal when nothing changed.
 */
export function describeRevision(expense: SavedExpense): Record<RevisionField, string> {
  const money = (amount: string, currency: string = expense.currency) => codeAmount(amount, currency)
  return {
    title: expense.title,
    vendor: expense.vendor ?? '',
    amount: money(expense.amount),
    date: expense.expenseDate,
    payer: expense.payers.length === 1 ? (expense.payers[0]?.name ?? '') : expense.payers.map((p) => `${p.name}: ${money(p.amount)}`).join('\n'),
    splits: expense.shares.map((s) => `${s.name}: ${money(s.amount)} (share ${s.weight})`).join('\n'),
    splitMode: SPLIT_LABEL[expense.splitMode],
    reimbursement: expense.kind === 'payment' ? 'Yes' : 'No',
    category: expense.category?.name ?? '',
    originalAmount: expense.originalAmount === null ? '' : money(expense.originalAmount, expense.originalCurrency ?? expense.currency),
    conversionRate: expense.conversionRate ?? '',
    recurrence: RECURRENCE_LABEL[expense.recurrence],
    notes: expense.notes,
    attachments:
      expense.documents.length > 0
        ? expense.documents
            .map((d) => d.url)
            .sort()
            .join('\n')
        : expense.documentCount > 0
          ? `${expense.documentCount} ${expense.documentCount === 1 ? 'attachment' : 'attachments'}`
          : '',
  }
}

/** The title with its vendor, "<vendor> — <title>", as the current app's expenseTitle. */
export const titleWithVendor = (e: { title: string; vendor: string | null }) => (e.vendor ? `${e.vendor} — ${e.title}` : e.title)
