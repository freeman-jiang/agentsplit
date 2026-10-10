import {
  ActivityType,
  RecurrenceRule,
  SplitMode,
} from '@/generated/prisma/browser'
import { expenseCurrencySchema } from '@/lib/currency'
import {
  activitySnapshotSchema,
  expenseSnapshotSchema,
} from '@/lib/expense-history'
import { uploadTargetSchema } from '@/lib/expense-uploads'
import { historicalViewSchema } from '@/lib/history-query'
import { decimalTextSchema } from '@/lib/money'
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
const money = decimalTextSchema.describe(
  'Exact decimal string in the stated currency, e.g. 12.34',
)
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
  slug: z.string().nullable(),
  information: z.string().nullable(),
  revision: z.number().int().nonnegative().default(0),
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
  vendor: z.string().nullable(),
  amount: money,
  currencyCode: z.string(),
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
  deletedAt: dateTime.nullable(),
  revision: z.number().int().nonnegative(),
})
const attribution = z.object({
  createdAt: dateTime.nullable().optional(),
  updatedAt: dateTime.nullable().optional(),
  lastEditedByYouAt: dateTime.nullable().optional(),
  createdBy: z
    .object({
      userId: id.nullable(),
      name: z.string(),
      source: z.string(),
    })
    .nullable(),
  updatedBy: z
    .object({
      userId: id.nullable(),
      name: z.string(),
      source: z.string(),
    })
    .nullable(),
})

const expenseSummary = expenseFields
  .pick({
    id: true,
    title: true,
    vendor: true,
    amount: true,
    currencyCode: true,
    createdAt: true,
    expenseDate: true,
    originalAmount: true,
    originalCurrency: true,
    isReimbursement: true,
    splitMode: true,
    recurrenceRule: true,
  })
  .extend({
    attribution: attribution.optional(),
    paidBy: person,
    paidFor: z.array(
      z.object({ participant: person, shares: decimalTextSchema }),
    ),
    category: category.nullable(),
    _count: z.object({ documents: z.number().int().nonnegative() }),
  })
const expense = expenseFields.extend({
  attribution,
  paidBy: participant,
  paidFor: z.array(
    z.object({ expenseId: id, participantId: id, shares: decimalTextSchema }),
  ),
  category: category.nullable(),
  documents: z.array(
    z.object({
      id,
      url: z.string(),
      downloadUrl: z
        .string()
        .describe(
          'Authenticated receipt URL. GET with X-API-Key set to the same API key; do not send the key to the storage URL.',
        ),
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
const monthlyCategory = z.object({
  key: z.string(),
  categoryId: z.number().int().nullable(),
  grouping: z.string(),
  name: z.string(),
  amount: money,
  expenseAmount: money,
  incomeAmount: money,
})

const expenseWrite = z.object({
  expenseId: id,
  revision: z.number().int().nonnegative(),
  amount: money,
  currencyCode: z.string(),
  uploads: z.array(uploadTargetSchema),
  uploadError: z.string().nullable(),
})

/** Every registered tool needs a reviewed wire contract matching its query. */
export const MCP_OUTPUT_SCHEMAS = {
  'expenses.options': z.object({
    userId: id,
    groups: z.array(
      z.object({ id, name: z.string(), slug: z.string().nullable() }),
    ),
    people: z.array(person.extend({ email: z.string() })),
  }),
  'profile.update': z.object({
    profile: z.object({
      id,
      name: z.string(),
      email: z.string(),
      emailVerified: z.boolean(),
    }),
  }),
  'expenses.list': z.object({
    expenses: z.array(
      expenseFields.extend({
        group: z
          .object({ id, name: z.string(), slug: z.string().nullable() })
          .nullable(),
        contextExpenseId: id.nullable(),
        contextExpenseTitle: z.string().nullable(),
        participantId: id.nullable(),
        attribution: attribution.optional(),
        paidBy: person,
        paidFor: z.array(
          z.object({ participant: person, shares: decimalTextSchema }),
        ),
        category: category.nullable(),
        _count: z.object({ documents: z.number().int() }),
      }),
    ),
    nextCursor: z
      .object({ date: dateTime, createdAt: dateTime, id })
      .nullable(),
  }),
  'groups.create': z.object({ groupId: id, group: groupWithParticipants }),
  'groups.update': z.object({ groupId: id, group: groupWithParticipants }),
  'groups.access': z.object({
    groupId: id,
    joined: z.boolean(),
    invitation: z
      .object({
        id,
        email: z.string(),
        expiresAt: dateTime,
        url: z.string(),
        participantId: id,
        participantName: z.string(),
      })
      .optional(),
  }),
  'groups.expenses.create': expenseWrite.extend({
    groupId: id,
    participants: z
      .array(z.object({ localId: id, participantId: id, name: z.string() }))
      .optional(),
    invitations: z
      .array(
        z.object({ email: z.string(), url: z.string(), expiresAt: dateTime }),
      )
      .optional(),
  }),
  'groups.expenses.update': expenseWrite,
  'groups.expenses.delete': z.object({
    expenseId: id,
    revision: z.number().int().nonnegative(),
    deleted: z.literal(true),
  }),
  'groups.processRecurring': z.object({ createdExpenseIds: z.array(id) }),
  'groups.export': z.object({
    filename: z.string(),
    contentType: z.string(),
    content: z.string(),
  }),
  'reference.get': z.object({
    categories: z.array(category),
    currencies: z.array(
      z.object({
        code: expenseCurrencySchema,
        name: z.string(),
        symbol: z.string(),
        decimalPlaces: z.number().int().nonnegative(),
      }),
    ),
    splitModes: z.array(z.enum(SplitMode)),
    recurrenceRules: z.array(z.enum(RecurrenceRule)),
    attachments: z.object({
      enabled: z.boolean(),
      contentTypes: z.array(z.string()),
      maxBytes: z.number().int().positive(),
    }),
  }),
  'groups.list': z.object({
    groups: z.array(
      group.extend({
        _count: z.object({ participants: z.number().int().nonnegative() }),
      }),
    ),
    ...pagination,
  }),
  'groups.getDetails': z.object({
    context: z.object({
      kind: z.enum(['group', 'ungrouped']),
      expenseId: id.nullable(),
    }),
    access: z.object({
      role: z.string(),
      participantId: id.nullable(),
      reservedParticipantIds: z.array(id),
      members: z.array(
        z.object({
          id,
          name: z.string(),
          email: z.string(),
          role: z.string(),
          participantId: id.nullable(),
        }),
      ),
      invitations: z.array(
        z.object({
          id,
          email: z.string(),
          expiresAt: dateTime,
          participantId: id.nullable(),
          participantName: z.string().nullable(),
        }),
      ),
    }),
    group: groupWithParticipants,
    participantsWithExpenses: z.array(id),
    links: z.object({ share: z.string(), csv: z.string(), json: z.string() }),
  }),
  'groups.expenses.list': z.object({
    history: historicalViewSchema.optional(),
    expenses: z.array(expenseSummary),
    ...pagination,
  }),
  'groups.expenses.get': z.object({
    expense,
    history: z
      .object({
        activityId: id,
        recordedAt: dateTime,
        revision: z.number().int(),
        deleted: z.boolean(),
        snapshot: expenseSnapshotSchema,
      })
      .optional(),
  }),
  'groups.balances.list': z.object({
    history: historicalViewSchema.optional(),
    currencies: z.array(
      z.object({
        currencyCode: z.string(),
        balances: z.record(
          id,
          z.object({ paid: money, paidFor: money, total: money }),
        ),
        reimbursements: z.array(z.object({ from: id, to: id, amount: money })),
      }),
    ),
  }),
  'groups.balances.forUser': z.object({
    unboundGroupIds: z.array(id),
    balances: z.array(
      z.object({
        groupId: id,
        groupName: z.string(),
        currency: z.string(),
        currencyCode: z.string(),
        participantId: id,
        participantName: z.string(),
        amount: money,
      }),
    ),
  }),
  'groups.activities.list': z.object({
    atActivityId: id.nullable(),
    asOf: dateTime,
    activities: z.array(
      z.object({
        id,
        groupId: id,
        time: dateTime,
        activityType: z.enum(ActivityType),
        participantId: id.nullable(),
        expenseId: id.nullable(),
        data: z.string().nullable(),
        expenseRevision: z.number().int().nonnegative().nullable(),
        snapshot: activitySnapshotSchema.nullable(),
        previousSnapshot: activitySnapshotSchema.nullable(),
        source: z.string(),
        actorName: z.string().nullable(),
        actorUserId: id.nullable(),
        agentKeyId: id.nullable(),
        expense: expenseFields.optional(),
      }),
    ),
    ...pagination,
  }),
  'groups.stats.overview': z.object({
    currencyCode: z.string().nullable(),
    availableCurrencyCodes: z.array(z.string()),
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
} satisfies OutputSchemas
