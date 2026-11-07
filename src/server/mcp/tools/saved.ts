// Saved states (src/shared/history.ts) in the current app's snapshot field
// names, for list_activity and the historical reads of get_expense. Both
// stored formats arrive as one SavedExpense, so the output has one shape.
import { Schema } from 'effect'
import type { SavedExpense, SavedState } from '../../../shared/history'
import { minorOf } from '../../../shared/minor'
import { preferredPayer } from '../../../shared/split'
import { RECURRENCE_NAMES, SPLIT_MODE_NAMES } from '../../../shared/vocabulary'
import {
  DateTime,
  Id,
  isCurrencyCode,
  Money,
  NonNegativeInt,
  NullableString,
  RecurrenceInput,
  SplitModeInput,
  symbolOf,
} from './shared'

const Category = Schema.NullOr(Schema.Struct({ id: Schema.Int, name: Schema.String, grouping: Schema.String }))

/** Set for a receipt that was deleted for good: who deleted it (their account name) and when. History keeps the pointer. */
export const ReceiptDeleted = Schema.NullOr(Schema.Struct({ by: Schema.String, at: DateTime }))

/**
 * One saved revision. `schemaVersion` is the stored format: 1 for revisions
 * from the current app, 2 for revisions v2 wrote.
 */
export const ExpenseSnapshot = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  kind: Schema.Literal('expense'),
  /** The group as the revision saved it. Every stored format saves it. */
  group: Schema.Struct({ id: Id, name: Schema.String, slug: NullableString, currency: Schema.String, currencyCode: NullableString }),
  expense: Schema.Struct({
    id: Id,
    groupId: Id,
    revision: NonNegativeInt,
    title: Schema.String,
    vendor: NullableString,
    amount: Money,
    currencyCode: Schema.String,
    expenseDate: DateTime,
    createdAt: DateTime,
    categoryId: Schema.Int,
    category: Category,
    originalAmount: NullableString,
    originalCurrency: NullableString,
    conversionRate: NullableString,
    paidBy: Schema.Struct({ id: Id, name: Schema.String }),
    payers: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, amount: Money })),
    paidFor: Schema.Array(Schema.Struct({ participantId: Id, name: Schema.String, shares: Schema.String })),
    splitMode: SplitModeInput,
    isReimbursement: Schema.Boolean,
    notes: NullableString,
    recurrenceRule: Schema.NullOr(RecurrenceInput),
    documents: Schema.Array(Schema.Struct({ id: Id, url: Schema.String, deleted: Schema.optionalKey(ReceiptDeleted) })),
  }),
})

export const GroupSnapshot = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  kind: Schema.Literal('group'),
  group: Schema.Struct({
    id: Id,
    name: Schema.String,
    slug: NullableString,
    currency: Schema.String,
    currencyCode: NullableString,
    information: NullableString,
    participants: Schema.Array(Schema.Struct({ id: Id, name: Schema.String })),
  }),
})

export const Snapshot = Schema.NullOr(Schema.Union([ExpenseSnapshot, GroupSnapshot]))

/** The payer who paid the most, as list_expenses names `paidBy`. */
export function savedPayer(e: SavedExpense): { id: string; name: string } {
  if (e.payers.length === 0) return { id: '', name: '' }
  const id = preferredPayer(e.payers.map((p) => ({ participantId: p.participantId, amount: minorOf(p.amount, e.currency) })))
  const payer = e.payers.find((p) => p.participantId === id)
  return { id, name: payer?.name ?? '' }
}

export const categoryOf = (e: SavedExpense) => (e.category ? { id: e.categoryId, name: e.category.name, grouping: e.category.grouping } : null)

export function expenseSnapshot(data: { expense: SavedExpense; groupId: string }): typeof ExpenseSnapshot.Encoded {
  const e = data.expense
  return {
    schemaVersion: e.schemaVersion,
    kind: 'expense',
    group: e.group
      ? {
          id: e.group.id,
          name: e.group.name,
          slug: e.group.slug,
          currency: symbolOf(e.group.currency),
          currencyCode: isCurrencyCode(e.group.currency) ? e.group.currency : null,
        }
      : // Not seen in stored data; the expense's own group and currency then stand in.
        { id: data.groupId, name: '', slug: null, currency: symbolOf(e.currency), currencyCode: e.currency },
    expense: {
      id: e.id,
      groupId: data.groupId,
      revision: e.revision,
      title: e.title,
      vendor: e.vendor,
      amount: e.amount,
      currencyCode: e.currency,
      expenseDate: `${e.expenseDate}T00:00:00.000Z`,
      createdAt: e.createdAt,
      categoryId: e.categoryId,
      category: categoryOf(e),
      originalAmount: e.originalAmount,
      originalCurrency: e.originalCurrency,
      conversionRate: e.conversionRate,
      paidBy: savedPayer(e),
      payers: e.payers.map((p) => ({ participantId: p.participantId, name: p.name, amount: p.amount })),
      paidFor: e.shares.map((s) => ({ participantId: s.participantId, name: s.name, shares: s.weight })),
      splitMode: SPLIT_MODE_NAMES[e.splitMode],
      isReimbursement: e.kind === 'payment',
      notes: e.notes === '' ? null : e.notes,
      recurrenceRule: RECURRENCE_NAMES[e.recurrence],
      documents: e.documents.map((d) => ({ id: d.id, url: d.url, ...(d.deleted === undefined ? {} : { deleted: d.deleted }) })),
    },
  }
}

export function snapshotOf(data: { state: SavedState | null; groupId: string }): typeof Snapshot.Encoded {
  const { state } = data
  if (state === null) return null
  if (state._tag === 'expense') return expenseSnapshot({ expense: state.expense, groupId: data.groupId })
  const g = state.group
  return {
    schemaVersion: g.schemaVersion,
    kind: 'group',
    group: {
      id: data.groupId,
      name: g.name,
      slug: g.slug,
      currency: symbolOf(g.currency),
      currencyCode: isCurrencyCode(g.currency) ? g.currency : null,
      information: g.information === '' ? null : g.information,
      participants: g.participants.map((p) => ({ id: p.id, name: p.name })),
    },
  }
}
