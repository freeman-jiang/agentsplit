// The dashboard feed across every group and private context, the account-wide
// balance, and ungrouped (private) expenses. MCP's list_all_expenses and the
// ungrouped form of create_expense call the same services.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { isUtcTime, UTC_TIME } from '../dates'
import { LIMITS } from '../limits'
import { Category } from './expenses'
import { CurrencyCodeSchema, DecimalOutput } from '../money'
import {
  Attribution,
  CalendarDate,
  CallerTotals,
  CategoryId,
  EmailInput,
  Expense,
  ExpenseInput,
  ExpenseKindSchema,
  GroupKindSchema,
  Id,
  IdempotencyKey,
  NameInput,
  NewId,
  PageLimit,
  Participant,
  ReadError,
  RoleSchema,
  Transfer,
  SearchText,
  WriteError,
} from './core'

// ---------- feed ----------

/** The last row of a page: its expense date, its exact creation time (microseconds) and its ID. */
export const FeedCursor = Schema.Struct({
  date: CalendarDate,
  createdAt: Schema.String.check(Schema.isPattern(UTC_TIME), Schema.makeFilter((value: string) => isUtcTime(value) || 'Invalid time')),
  id: Id,
})

/** 'grouped' keeps named groups only; 'ungrouped' keeps private expenses only. Default 'all'. */
export const FeedScope = Schema.Literals(['all', 'grouped', 'ungrouped'])

export const FeedFilter = Schema.Struct({
  scope: Schema.optionalKey(FeedScope),
  /** One named group or one private context. */
  groupId: Schema.optionalKey(Id),
  /** Case-insensitive substring of the title or the vendor. */
  search: Schema.optionalKey(SearchText),
  /** Keep expenses that the caller pays for or shares. Default true, in the UI and for agents. */
  involvingMe: Schema.optionalKey(Schema.Boolean),
  /** An account (user) ID: keep expenses that this account pays for or shares. */
  personUserId: Schema.optionalKey(Id),
  /** An account (user) ID: keep expenses that this account paid. */
  payerUserId: Schema.optionalKey(Id),
  currency: Schema.optionalKey(CurrencyCodeSchema),
  categoryId: Schema.optionalKey(CategoryId),
  kind: Schema.optionalKey(ExpenseKindSchema),
  /** Inclusive bounds on the expense date. */
  from: Schema.optionalKey(CalendarDate),
  to: Schema.optionalKey(CalendarDate),
})

export const GroupRef = Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.NullOr(Schema.String) })

export const FeedItem = Schema.Struct({
  ...Expense.fields,
  /** Current display names of the payers and the people who share the cost. */
  people: Schema.Array(Participant),
  /** The named group, or null for a private expense. */
  group: Schema.NullOr(GroupRef),
  /** For a private context: the original expense, which a repayment settles. */
  contextExpenseId: Schema.NullOr(Schema.String),
  contextExpenseTitle: Schema.NullOr(Schema.String),
  /** The caller's participant in this expense's group or context. */
  participantId: Schema.NullOr(Schema.String),
  attribution: Attribution,
})

export const FeedPage = Schema.Struct({ expenses: Schema.Array(FeedItem), nextCursor: Schema.NullOr(FeedCursor) })

export const AccountBalances = Schema.Struct({
  /** One row per group or context and currency, for the caller's own participant. */
  balances: Schema.Array(
    Schema.Struct({
      groupId: Schema.String,
      groupName: Schema.String,
      kind: GroupKindSchema,
      currency: CurrencyCodeSchema,
      participantId: Schema.String,
      participantName: Schema.String,
      /** Positive: the caller is owed. Negative: the caller owes. */
      amount: DecimalOutput,
    }),
  ),
  /** The rows summed per currency. */
  totals: CallerTotals,
  /** Groups where the caller has no linked participant; the totals leave them out. */
  unboundGroupIds: Schema.Array(Schema.String),
})

export const FeedOptions = Schema.Struct({
  userId: Schema.String,
  /** Named groups with active access, by name. Private contexts are not listed. */
  groups: Schema.Array(GroupRef),
  /** The caller and the verified accounts that share an active group with a linked participant, by name. */
  people: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String })),
  categories: Schema.Array(Category),
})

// ---------- expense page and private contexts ----------

export const PendingInvitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  participantId: Schema.String,
  participantName: Schema.String,
  expiresAt: Schema.String,
})

/** Everything the expense page needs, for any expense the caller can see. */
export const ExpenseContext = Schema.Struct({
  expense: Expense,
  group: Schema.Struct({ ...GroupRef.fields, kind: GroupKindSchema }),
  role: RoleSchema,
  participantId: Schema.NullOr(Schema.String),
  /** Every participant of the group or context, with current display names. */
  participants: Schema.Array(Participant),
  /** Set for a private context only. */
  context: Schema.NullOr(
    Schema.Struct({
      expenseId: Schema.String,
      title: Schema.String,
      /** Suggested repayments per currency that settle this expense; empty when settled. */
      settlements: Schema.Array(Schema.Struct({ currency: CurrencyCodeSchema, transfers: Schema.Array(Transfer) })),
      /** Pending invitations, for the creator only. Expired ones stay listed so they can be renewed. */
      invitations: Schema.Array(PendingInvitation),
    }),
  ),
})

/** A person of a new ungrouped expense, named by a local ID that the expense's payers and shares use. */
const LocalId = Schema.String.check(Schema.isBetweenLength(1, LIMITS.localIdMax))
export const PrivatePerson = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('account'),
    id: LocalId,
    userId: Schema.String.check(Schema.isBetweenLength(1, LIMITS.userIdMax)),
  }),
  Schema.Struct({
    kind: Schema.Literal('email'),
    id: LocalId,
    name: NameInput,
    email: EmailInput.annotate({ format: 'email' }),
  }),
])

/** The people of a new ungrouped expense, the caller included. */
export const PrivatePeople = Schema.Array(PrivatePerson).check(Schema.isBetweenLength(2, LIMITS.participantsPerGroup))

export const UngroupedResult = Schema.Struct({
  expenseId: Schema.String,
  groupId: Schema.String,
  revision: Schema.Number,
  /** Private links to share by hand; no email is sent. Shown once: only a hash of each secret is stored. */
  invitations: Schema.Array(Schema.Struct({ email: Schema.String, url: Schema.String, expiresAt: Schema.String })),
  participants: Schema.Array(Schema.Struct({ localId: Schema.String, participantId: Schema.String, name: Schema.String })),
})

export const RenewedInvitation = Schema.Struct({ ...PendingInvitation.fields, url: Schema.String })

// ---------- procedures ----------

export class FeedApi extends RpcGroup.make(
  Rpc.make('feed.list', {
    payload: {
      filter: FeedFilter,
      cursor: Schema.NullOr(FeedCursor),
      limit: PageLimit,
    },
    success: FeedPage,
    error: ReadError,
  }),
  Rpc.make('feed.balances', { success: AccountBalances, error: ReadError }),
  Rpc.make('feed.options', { success: FeedOptions, error: ReadError }),
  Rpc.make('expenses.context', { payload: { expenseId: Id }, success: ExpenseContext, error: ReadError }),
  Rpc.make('expenses.createUngrouped', {
    payload: {
      expenseId: NewId,
      idempotencyKey: IdempotencyKey,
      people: PrivatePeople,
      /** Payers and shares name people by their local IDs. */
      expense: ExpenseInput,
    },
    success: UngroupedResult,
    error: WriteError,
  }),
  Rpc.make('expenses.renewInvitation', {
    payload: { groupId: Id, participantId: Id, idempotencyKey: IdempotencyKey },
    success: RenewedInvitation,
    error: WriteError,
  }),
) {}
