// Balance and recurrence tools: get_balances, get_participant_balances and
// process_recurring_expenses, with the current app's inputs and outputs
// (src/trpc/routers/groups/balances/*, recurring.procedure.ts). Balances come
// from src/server/balances.ts, recurrence from src/server/recurring.ts.
import { Schema } from 'effect'
import { Id as IdInput } from '../../../shared/api'
import { todayUtc } from '../../../shared/dates'
import { suggestSettlements, type Balance } from '../../../shared/balances'
import type { CurrencyCode } from '../../../shared/currencies'
import { LIMITS } from '../../../shared/limits'
import { formatMinor, minor, type Minor } from '../../../shared/minor'
import * as balances from '../../balances'
import * as recurring from '../../recurring'
import { defineTool } from './registry'
import { boundaryOf, CurrencyCodeInput, HistoryFields } from './inputs'
import { HistoryView, Id, Money, optional, symbolOf } from './wire'

type Transfer = { from: string; to: string; amount: Minor }

/**
 * The current app's public balances: built from the suggested repayments, not
 * from raw sums (P-TOOL-BALANCES-05, kept in DECISIONS.md group D). A person
 * who pays receives `paidFor`; a person who is paid receives `paid`.
 */
function publicBalances(data: { transfers: readonly Transfer[]; currency: CurrencyCode }) {
  const sums = new Map<string, { paid: bigint; paidFor: bigint }>()
  const row = (id: string) => {
    const found = sums.get(id) ?? { paid: 0n, paidFor: 0n }
    sums.set(id, found)
    return found
  }
  for (const t of data.transfers) {
    row(t.from).paidFor += t.amount
    row(t.to).paid += t.amount
  }
  const text = (amount: bigint) => formatMinor({ amount: minor(amount), currency: data.currency })
  return Object.fromEntries([...sums].map(([id, s]) => [id, { paid: text(s.paid), paidFor: text(s.paidFor), total: text(s.paid - s.paidFor) }]))
}

/** One currency bucket of get_balances, from the balances of that currency. */
const bucket = ([currency, byPerson]: readonly [CurrencyCode, ReadonlyMap<string, Balance>]) => {
  const transfers = suggestSettlements(byPerson)
  return {
    currencyCode: currency,
    balances: publicBalances({ transfers, currency }),
    reimbursements: transfers.map((t) => ({ from: t.from, to: t.to, amount: formatMinor({ amount: t.amount, currency }) })),
  }
}

export const getBalances = defineTool({
  name: 'get_balances',
  kind: 'read',
  description:
    'Read balances and suggested repayments in separate currency buckets, optionally filtering currencyCode. Money is exact decimal text. Currency buckets must not be added or converted. Record suggestions through create_expense with isReimbursement=true: a repayment may involve several people and may be negative, as for a refund. Optional asOf timestamp or atActivityId calculates historical balances with the same splitter; missing legacy snapshots produce PRECONDITION_FAILED rather than an incomplete total.',
  input: Schema.Struct({
    ...HistoryFields,
    groupId: IdInput,
    currencyCode: optional(CurrencyCodeInput),
  }),
  strict: [''],
  output: Schema.Struct({
    history: optional(HistoryView),
    currencies: Schema.Array(
      Schema.Struct({
        currencyCode: Schema.String,
        balances: Schema.Record(Schema.String, Schema.Struct({ paid: Money, paidFor: Money, total: Money })),
        reimbursements: Schema.Array(Schema.Struct({ from: Id, to: Id, amount: Money })),
      }),
    ),
  }),
  run: async ({ db, principal }, input) => {
    const scope = { principal, groupId: input.groupId, currency: input.currencyCode }
    if (input.asOf === undefined && input.atActivityId === undefined) {
      const current = await balances.groupBalances(db, scope)
      return { currencies: [...current.balances].map(bucket) }
    }
    const saved = await balances.historicalBalances(db, { ...scope, ...boundaryOf(input) })
    return { history: saved.history, currencies: [...saved.balances].map(bucket) }
  },
})

export const getParticipantBalances = defineTool({
  name: 'get_participant_balances',
  kind: 'read',
  description:
    'Read exact per-currency net balances. Omit groups to include every accessible named group and private expense context, without a page-size cap; provide a unique groups list to restrict the scope. Omit participantId to use your fixed membership; supply it to inspect a particular participant. totals contains server-calculated net amounts per currency across the selected scope. These totals do not settle or merge debts. unboundGroupIds means the result is incomplete and must be described as partial. Do not combine different currencies. Dashboard totals are independent of expense-list filters. Discover participant IDs with get_group.',
  input: Schema.Struct({
    groups: optional(
      Schema.Array(Schema.Struct({ groupId: IdInput, participantId: optional(IdInput) }))
        .check(Schema.isMaxLength(LIMITS.pageMax))
        .check(Schema.makeFilter((list) => new Set(list.map((g) => g.groupId)).size === list.length || 'Choose each group or private context only once.'))
        .annotate({
          description:
            'Omit to include every currently accessible named group and private expense context, without a page-size cap. Supply a unique list to restrict the scope.',
        }),
    ),
  }),
  strict: [''],
  output: Schema.Struct({
    totals: Schema.Array(Schema.Struct({ currencyCode: Schema.String, amount: Money })),
    unboundGroupIds: Schema.Array(Id),
    balances: Schema.Array(
      Schema.Struct({
        groupId: Id,
        groupName: Schema.String,
        currency: Schema.String,
        currencyCode: Schema.String,
        participantId: Id,
        participantName: Schema.String,
        amount: Money,
      }),
    ),
  }),
  run: async ({ db, principal }, input) => {
    const result = await balances.accountBalances(db, { principal, ...(input.groups ? { scope: input.groups } : {}) })
    return {
      totals: result.totals.map((t) => ({ currencyCode: t.currency, amount: t.amount })),
      unboundGroupIds: result.unboundGroupIds,
      balances: result.balances.map((b) => ({
        groupId: b.groupId,
        groupName: b.groupName,
        currency: symbolOf(b.currency),
        currencyCode: b.currency,
        participantId: b.participantId,
        participantName: b.participantName,
        amount: b.amount,
      })),
    }
  },
})

export const processRecurringExpenses = defineTool({
  name: 'process_recurring_expenses',
  kind: 'write',
  destructive: false,
  idempotent: true,
  description:
    'Explicitly materialize due recurring expenses only in the specified group, using the server clock. Returns created expense IDs. Reads never generate recurring entries; a scheduled job also creates them every hour, and repeated processing does not duplicate frames.',
  input: Schema.Struct({ groupId: IdInput }),
  strict: [''],
  output: Schema.Struct({ createdExpenseIds: Schema.Array(Id) }),
  run: ({ db, principal }, input) => recurring.processGroup(db, { principal, groupId: input.groupId, today: todayUtc() }),
})

