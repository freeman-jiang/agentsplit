// Feed tools: list_all_expenses and get_expense_options, with the current
// app's inputs and outputs (src/trpc/routers/expenses/*). The feed rules
// (access, scope, "involving me", the cursor) are in src/server/feed.ts; this
// file only maps names. One more statement reads the columns of the current
// wire shape that the feed row does not carry.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { preferredPayer } from '../../../shared/split'
import * as feed from '../../feed'
import { defineTool } from '../registry'
import { Attribution, Category, Person } from './expenses'
import {
  CalendarDate,
  CurrencyCodeInput,
  DateTime,
  Id,
  minorOf,
  MODE_NAMES,
  money,
  Money,
  NoArguments,
  NonNegativeInt,
  NullableString,
  RecurrenceInput,
  RULE_NAMES,
  SplitModeInput,
} from './shared'

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const AccountId = Schema.String.check(Schema.isMinLength(1))

/** The last row of a page. createdAt keeps microseconds, so rows created in the same millisecond are not skipped. */
const Cursor = Schema.Struct({
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z)?$/)).annotate({ format: 'date-time' }),
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)).annotate({ format: 'date-time' }),
  id: Id,
})
const CursorOutput = Schema.Struct({ date: DateTime, createdAt: DateTime, id: Id })

const FeedRow = Schema.Struct({
  id: Id,
  groupId: Id,
  title: Schema.String,
  vendor: NullableString,
  amount: Money,
  currencyCode: Schema.String,
  createdAt: DateTime,
  expenseDate: DateTime,
  categoryId: Schema.Int,
  paidById: Id,
  originalAmount: Schema.NullOr(Money),
  originalCurrency: NullableString,
  conversionRate: NullableString,
  isReimbursement: Schema.Boolean,
  splitMode: SplitModeInput,
  notes: NullableString,
  recurrenceRule: Schema.NullOr(RecurrenceInput),
  recurringExpenseLinkId: Schema.NullOr(Id),
  deletedAt: Schema.NullOr(DateTime),
  revision: NonNegativeInt,
  group: Schema.NullOr(Schema.Struct({ id: Id, name: Schema.String, slug: NullableString })),
  contextExpenseId: NullableString,
  contextExpenseTitle: NullableString,
  participantId: NullableString,
  attribution: optional(Attribution),
  paidBy: Person,
  payers: Schema.Array(Schema.Struct({ participant: Person, amount: Money })),
  paidFor: Schema.Array(Schema.Struct({ participant: Person, shares: Schema.String })),
  category: Category,
  _count: Schema.Struct({ documents: NonNegativeInt }),
})

type Extra = {
  id: string
  original_amount: string | null
  original_currency: string | null
  conversion_rate: string | null
  link_id: string | null
  category: { id: number; name: string; grouping: string } | null
}

export const listAllExpenses = defineTool({
  name: 'list_all_expenses',
  kind: 'read',
  description:
    'List accessible expenses and repayments across groups and private ungrouped expenses, ordered by expense date, creation time, then ID, newest first. By default (involvingMe=true) only expenses that you paid for or share are listed, as in the app; set involvingMe=false for every accessible expense. Filter by scope (all/grouped/ungrouped), groupId (a named group or a private context), personId or paidByUserId (account IDs from get_expense_options), dates, currency, category, type, or title/vendor text. Pass nextCursor unchanged for the next page. group=null means no named group; groupId is the private accounting context ID for existing expense/history/balance/payment tools. A private context settles only its original contextExpenseId; never copy that balance into a named group. paidBy is the payer who paid the most; payers lists every payer. Reads do not generate recurrences.',
  input: Schema.Struct({
    cursor: optional(Schema.NullOr(Cursor)),
    limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({ default: 30 })),
    scope: optional(Schema.Literals(['all', 'grouped', 'ungrouped']).annotate({ default: 'all' })),
    groupId: optional(Schema.String.check(Schema.isMinLength(1))),
    filter: optional(Schema.String.check(Schema.isMaxLength(200))),
    involvingMe: optional(
      Schema.Boolean.annotate({ default: true, description: 'Default true: only expenses that you paid for or share. Set false for every accessible expense.' }),
    ),
    personId: optional(AccountId),
    paidByUserId: optional(AccountId),
    currencyCode: optional(CurrencyCodeInput),
    categoryId: optional(NonNegativeInt),
    isReimbursement: optional(Schema.Boolean),
    from: optional(CalendarDate),
    to: optional(CalendarDate),
  }),
  strict: [''],
  output: Schema.Struct({ expenses: Schema.Array(FeedRow), nextCursor: Schema.NullOr(CursorOutput) }),
  run: async ({ db, principal }, input) => {
    const page = await feed.listFeed(db, {
      principal,
      limit: input.limit ?? 30,
      cursor: input.cursor ? { date: input.cursor.date.slice(0, 10), createdAt: input.cursor.createdAt, id: input.cursor.id } : null,
      filter: {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.filter === undefined ? {} : { search: input.filter }),
        ...(input.involvingMe === undefined ? {} : { involvingMe: input.involvingMe }),
        ...(input.personId === undefined ? {} : { personUserId: input.personId }),
        ...(input.paidByUserId === undefined ? {} : { payerUserId: input.paidByUserId }),
        ...(input.currencyCode === undefined ? {} : { currency: input.currencyCode }),
        ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
        ...(input.isReimbursement === undefined ? {} : { kind: input.isReimbursement ? ('payment' as const) : ('expense' as const) }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      },
    })
    // The feed already checked access to these rows; this reads only their other columns.
    const ids = page.expenses.map((e) => e.id)
    const extra = ids.length
      ? await db.execute<Extra>(sql`
          SELECT e.id, e.original_amount::text AS original_amount, e.original_currency, e.conversion_rate,
            (SELECT l.id FROM recurring_links l WHERE l.current_frame_expense_id = e.id LIMIT 1) AS link_id,
            (SELECT json_build_object('id', c.id, 'name', c.name, 'grouping', c.grouping) FROM categories c WHERE c.id = e.category_id) AS category
          FROM expenses e WHERE e.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
      : { rows: [] }
    const byId = new Map(extra.rows.map((r) => [r.id, r]))
    return {
      expenses: page.expenses.map((e) => {
        const x = byId.get(e.id)
        const names = new Map(e.people.map((p) => [p.id, p.name]))
        const person = (id: string) => ({ id, name: names.get(id) ?? '' })
        const payerId = e.payers.length ? preferredPayer(e.payers.map((p) => ({ participantId: p.participantId, amount: minorOf(p.amount, e.currency) }))) : ''
        return {
          id: e.id,
          groupId: e.groupId,
          title: e.title,
          vendor: e.vendor,
          amount: e.amount,
          currencyCode: e.currency,
          createdAt: e.createdAt,
          expenseDate: `${e.expenseDate}T00:00:00.000Z`,
          categoryId: e.categoryId,
          paidById: payerId,
          originalAmount: !x || x.original_amount === null || x.original_currency === null ? null : money(x.original_amount, x.original_currency),
          originalCurrency: x?.original_currency ?? null,
          conversionRate: x?.conversion_rate ?? null,
          isReimbursement: e.kind === 'payment',
          splitMode: MODE_NAMES[e.splitMode],
          notes: e.notes === '' ? null : e.notes,
          recurrenceRule: RULE_NAMES[e.recurrence],
          recurringExpenseLinkId: x?.link_id ?? null,
          deletedAt: null,
          revision: e.revision,
          group: e.group,
          contextExpenseId: e.contextExpenseId,
          contextExpenseTitle: e.contextExpenseTitle,
          participantId: e.participantId,
          attribution: e.attribution,
          paidBy: person(payerId),
          payers: e.payers.map((p) => ({ participant: person(p.participantId), amount: p.amount })),
          // An amount split stores minor units; the current app shows them as amounts.
          paidFor: e.shares.map((s) => ({ participant: person(s.participantId), shares: e.splitMode === 'amount' ? money(s.weight, e.currency) : s.weight })),
          category: x?.category ?? null,
          _count: { documents: e.documentCount },
        }
      }),
      nextCursor: page.nextCursor ? { date: `${page.nextCursor.date}T00:00:00.000Z`, createdAt: page.nextCursor.createdAt, id: page.nextCursor.id } : null,
    }
  },
})

export const getExpenseOptions = defineTool({
  name: 'get_expense_options',
  kind: 'read',
  description:
    'List your named groups and verified people you already share active access with, plus your account userId. Account IDs are not group participant IDs. Verified accounts have one global display name; participant names for those accounts always resolve to it. Unclaimed participants retain their invitation placeholder name. Use these accounts with create_expense (omit groupId and supply people) to create private ungrouped expenses; someone else may be invited by exact email. Does not search or disclose arbitrary accounts.',
  input: NoArguments,
  strict: [''],
  output: Schema.Struct({
    userId: Id,
    groups: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, slug: NullableString })),
    people: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, email: Schema.String })),
  }),
  run: async ({ db, principal }) => {
    const options = await feed.feedOptions(db, { principal })
    return { userId: options.userId, groups: options.groups, people: options.people }
  },
})

export const feedTools = [listAllExpenses, getExpenseOptions]
