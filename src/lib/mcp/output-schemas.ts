import {
  ActivityType,
  RecurrenceRule,
  SplitMode,
} from '@/generated/prisma/browser'
import type { AppRouter } from '@/trpc/routers/_app'
import type { inferRouterOutputs } from '@trpc/server'
import * as z from 'zod'
import type { MCP_TOOL_REGISTRY } from './registry'

// These describe the JSON wire format, after Date/Decimal serialization.
// No expense calculation or database behavior is implemented here.
type Wire<T> = T extends { toJSON(): infer J }
  ? Wire<J>
  : T extends readonly (infer Item)[]
    ? Wire<Item>[]
    : T extends object
      ? { [K in keyof T as undefined extends T[K] ? never : K]: Wire<T[K]> } & {
          [K in keyof T as undefined extends T[K] ? K : never]?: Wire<
            Exclude<T[K], undefined>
          >
        }
      : T
type AtPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? AtPath<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never
type OutputSchemas = {
  [P in (typeof MCP_TOOL_REGISTRY)[number]['procedure']]: z.ZodType<
    Wire<AtPath<inferRouterOutputs<AppRouter>, P>>
  >
}

const id = z.string()
const money = z.number().int().describe('Integer currency minor units')
const dateTime = z.iso.datetime()
const person = z.object({ id, name: z.string() })
const participant = person.extend({ groupId: id })
const category = z.object({
  id: z.number().int(),
  name: z.string(),
  grouping: z.string(),
})
const group = z.object({
  id,
  name: z.string(),
  information: z.string().nullable(),
  currency: z.string(),
  currencyCode: z.string().nullable(),
  createdAt: dateTime,
})
const groupWithParticipants = group.extend({
  participants: z.array(participant),
})
const expenseFields = z.object({
  id,
  groupId: id,
  title: z.string(),
  amount: money,
  createdAt: dateTime,
  expenseDate: dateTime,
  categoryId: z.number().int(),
  paidById: id,
  originalAmount: money.nullable(),
  originalCurrency: z.string().nullable(),
  conversionRate: z
    .string()
    .nullable()
    .describe('Serialized decimal exchange rate'),
  isReimbursement: z.boolean(),
  splitMode: z.enum(SplitMode),
  notes: z.string().nullable(),
  recurrenceRule: z.enum(RecurrenceRule).nullable(),
  recurringExpenseLinkId: id.nullable(),
})
const expenseSummary = expenseFields
  .pick({
    id: true,
    title: true,
    amount: true,
    createdAt: true,
    expenseDate: true,
    originalAmount: true,
    originalCurrency: true,
    isReimbursement: true,
    splitMode: true,
    recurrenceRule: true,
  })
  .extend({
    paidBy: person,
    paidFor: z.array(
      z.object({ participant: person, shares: z.number().int() }),
    ),
    category: category.nullable(),
    _count: z.object({ documents: z.number().int().nonnegative() }),
  })
const expense = expenseFields.extend({
  paidBy: participant,
  paidFor: z.array(
    z.object({ expenseId: id, participantId: id, shares: z.number().int() }),
  ),
  category: category.nullable(),
  documents: z.array(
    z.object({
      id,
      url: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      expenseId: id.nullable(),
    }),
  ),
  recurringExpenseLink: z
    .object({
      id,
      groupId: id,
      currentFrameExpenseId: id,
      nextExpenseCreatedAt: dateTime.nullable(),
      nextExpenseDate: dateTime,
    })
    .nullable(),
})
const pagination = {
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative(),
}
const drilldown = z.object({
  expenses: z.array(
    expenseFields.pick({
      id: true,
      title: true,
      amount: true,
      expenseDate: true,
    }),
  ),
})
const monthlyCategory = z.object({
  key: z.string(),
  categoryId: z.number().int().nullable(),
  grouping: z.string(),
  name: z.string(),
  amount: money,
  expenseAmount: money,
  incomeAmount: money,
})

/** Every registered tool needs a reviewed wire contract matching its query. */
export const MCP_OUTPUT_SCHEMAS = {
  'groups.list': z.object({
    groups: z.array(
      group.extend({
        _count: z.object({ participants: z.number().int().nonnegative() }),
      }),
    ),
    ...pagination,
  }),
  'groups.get': z.object({ group: groupWithParticipants.nullable() }),
  'groups.getDetails': z.object({
    group: groupWithParticipants,
    participantsWithExpenses: z.array(id),
  }),
  'groups.expenses.list': z.object({
    expenses: z.array(expenseSummary),
    ...pagination,
  }),
  'groups.expenses.get': z.object({ expense }),
  'groups.balances.list': z.object({
    balances: z.record(
      id,
      z.object({ paid: money, paidFor: money, total: money }),
    ),
    reimbursements: z.array(z.object({ from: id, to: id, amount: money })),
  }),
  'groups.balances.forUser': z.object({
    balances: z.array(
      z.object({
        groupId: id,
        groupName: z.string(),
        currency: z.string(),
        currencyCode: z.string().nullable(),
        participantId: id,
        participantName: z.string(),
        amount: money,
      }),
    ),
  }),
  'groups.activities.list': z.object({
    activities: z.array(
      z.object({
        id,
        groupId: id,
        time: dateTime,
        activityType: z.enum(ActivityType),
        participantId: id.nullable(),
        expenseId: id.nullable(),
        data: z.string().nullable(),
        expense: expenseFields.optional(),
      }),
    ),
    ...pagination,
  }),
  'categories.list': z.object({ categories: z.array(category) }),
  'groups.stats.overview': z.object({
    totalGroupSpendings: money,
    totalParticipantSpendings: money.optional(),
    totalParticipantShare: money.optional(),
    summary: z.object({
      expenseCount: z.number().int().nonnegative(),
      totalSpending: money,
      averageExpense: money,
      largestExpense: z.object({ title: z.string(), amount: money }).nullable(),
      firstDate: z.iso.date().nullable(),
      lastDate: z.iso.date().nullable(),
    }),
    months: z.array(z.object({ month: z.string(), total: money })),
    monthlyCategorySpending: z.object({
      months: z.array(
        z.object({
          key: z.string(),
          year: z.number().int(),
          month: z.number().int(),
          amount: money,
          expenseAmount: money,
          incomeAmount: money,
          categories: z.array(monthlyCategory),
        }),
      ),
      categories: z.array(monthlyCategory),
      maxExpenseAmount: money,
    }),
    participants: z.array(
      z.object({
        participantId: id,
        name: z.string(),
        paid: money,
        paidCount: z.number().int(),
        share: money,
      }),
    ),
    categories: z.array(
      category
        .extend({ categoryId: z.number().int(), total: money })
        .omit({ id: true }),
    ),
    recurring: z.object({
      count: z.number().int().nonnegative(),
      estimatedMonthly: money,
      estimatedYearly: money,
      byPeriod: z.array(
        z.object({
          period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
          count: z.number().int(),
          total: money,
        }),
      ),
    }),
  }),
  'groups.stats.categoryExpenses': drilldown,
} satisfies OutputSchemas
