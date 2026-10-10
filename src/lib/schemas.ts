import { RecurrenceRule, SplitMode } from '@/generated/prisma/browser'
import * as z from 'zod'
import { expenseCurrencySchema, getCurrency } from './currency'
import { groupSlugSchema } from './group-slug'
import { Decimal, decimalStringSchema, decimalTextSchema } from './money'

export const GROUP_INFORMATION_MAX = 10_000
export const EXPENSE_NOTES_MAX = 5_000

export const groupFormSchema = z
  .object({
    name: z.string().min(2, 'min2').max(50, 'max50'),
    slug: groupSlugSchema,
    information: z.string().max(GROUP_INFORMATION_MAX, 'max10000').optional(),
    currency: z.string().min(1, 'min1').max(5, 'max5'),
    currencyCode: z.union([z.string().length(3).nullish(), z.literal('')]), // ISO-4217 currency code
    participants: z
      .array(
        z.object({
          id: z.string().max(64).optional(),
          name: z.string().min(1, 'min1').max(50, 'max50'),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine(({ participants }, ctx) => {
    participants.forEach((participant, i) => {
      participants.slice(0, i).forEach((otherParticipant) => {
        if (participant.id && participant.id === otherParticipant.id) {
          ctx.addIssue({
            code: 'custom',
            message: 'Duplicate participant ID',
            path: ['participants', i, 'id'],
          })
        }
        if (
          otherParticipant.name === participant.name &&
          (!otherParticipant.id || !participant.id)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'duplicateParticipantName',
            path: ['participants', i, 'name'],
          })
        }
      })
    })
  })

export const groupCreateSchema = groupFormSchema.safeExtend({
  participants: z.array(z.object({ name: z.string().min(1).max(50) })).max(99),
})

export type GroupFormValues = z.infer<typeof groupFormSchema>

export const expenseFormSchema = z
  .strictObject({
    currencyCode: expenseCurrencySchema,
    expenseDate: z
      .union([
        z.date(),
        z.iso
          .date()
          .refine(
            (value) =>
              Number.isFinite(new Date(value).getTime()) &&
              new Date(value).toISOString().slice(0, 10) === value,
            'Invalid calendar date',
          ),
      ])
      .transform((value) => (value instanceof Date ? value : new Date(value)))
      .meta({
        type: 'string',
        format: 'date',
        description: 'Calendar date in YYYY-MM-DD format',
      }),
    title: z.string().min(2, 'min2').max(200, 'max200'),
    vendor: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .optional()
      .describe(
        'Optional merchant name, e.g. Costco. Keep the purchase description in title without repeating vendor. Set null or empty string to clear.',
      ),
    category: z.number().int().nonnegative().default(0),
    amount: decimalStringSchema
      .refine((value) => !new Decimal(value).isZero(), 'amountNotZero')
      .refine(
        (value) => new Decimal(value).abs().lte('10000000'),
        'amountTenMillion',
      ),
    originalAmount: z.undefined().optional(),
    originalCurrency: z
      .union([z.literal(''), z.null(), z.undefined()])
      .optional(),
    conversionRate: z.undefined().optional(),
    paidBy: z.string({
      error: (issue) =>
        issue.input === undefined ? 'paidByRequired' : undefined,
    }),
    paidFor: z
      .array(
        z.object({
          participant: z.string().max(64),
          shares: decimalStringSchema,
        }),
      )
      .min(1, 'paidForMin1')
      .max(100),
    splitMode: z.enum(SplitMode).default('EVENLY'),
    saveDefaultSplittingOptions: z.boolean().default(false),
    isReimbursement: z.boolean(),
    documents: z
      .array(
        z.object({
          id: z.string().max(64),
          url: z.string().url().max(2000),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        }),
      )
      .max(100)
      .default([]),
    notes: z.string().max(EXPENSE_NOTES_MAX, 'max5000').optional(),
    recurrenceRule: z.enum(RecurrenceRule).default('NONE'),
  })
  .superRefine((expense, ctx) => {
    // Field errors can be non-aborting in Zod. Never calculate on invalid text.
    if (
      ![expense.amount, ...expense.paidFor.map((p) => p.shares)].every(
        (value) => decimalTextSchema.safeParse(value).success,
      )
    )
      return
    const digits = getCurrency(expense.currencyCode).decimal_digits
    const precision = (value: string, path: (string | number)[]) => {
      if (new Decimal(value).decimalPlaces() > digits)
        ctx.addIssue({
          code: 'custom',
          message: `${expense.currencyCode} amounts allow at most ${digits} decimal places`,
          path,
        })
    }
    precision(expense.amount, ['amount'])
    if (expense.splitMode === 'BY_AMOUNT')
      expense.paidFor.forEach((person, index) =>
        precision(person.shares, ['paidFor', index, 'shares']),
      )
    const sum = Decimal.sum(...expense.paidFor.map((p) => p.shares))
    const ids = new Set<string>()
    expense.paidFor.forEach((person, index) => {
      if (ids.has(person.participant))
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate beneficiary',
          path: ['paidFor', index, 'participant'],
        })
      ids.add(person.participant)
      const share = new Decimal(person.shares)
      const wrongSign =
        expense.splitMode === 'BY_AMOUNT'
          ? share.isZero() ||
            share.isNegative() !== new Decimal(expense.amount).isNegative()
          : !share.isPositive() || share.isZero()
      if (wrongSign)
        ctx.addIssue({
          code: 'custom',
          message: 'noZeroShares',
          path: ['paidFor', index, 'shares'],
        })
    })
    if (expense.splitMode === 'BY_AMOUNT' && !sum.eq(expense.amount))
      ctx.addIssue({ code: 'custom', message: 'amountSum', path: ['paidFor'] })
    if (expense.splitMode === 'BY_PERCENTAGE' && !sum.eq('100'))
      ctx.addIssue({
        code: 'custom',
        message: 'percentageSum',
        path: ['paidFor'],
      })
  })

/** Partial inputs only validate present fields; cross-field rules run after merging under the group lock. */
export const expenseChangesSchema = z
  .strictObject({
    ...expenseFormSchema.shape,
    category: expenseFormSchema.shape.category.removeDefault(),
    splitMode: expenseFormSchema.shape.splitMode.removeDefault(),
    saveDefaultSplittingOptions:
      expenseFormSchema.shape.saveDefaultSplittingOptions.removeDefault(),
    documents: expenseFormSchema.shape.documents.removeDefault(),
    recurrenceRule: expenseFormSchema.shape.recurrenceRule.removeDefault(),
  })
  .partial()
export const groupChangesSchema = z
  .strictObject(groupFormSchema.shape)
  .partial()
export type ExpenseChanges = z.input<typeof expenseChangesSchema>
export type GroupChanges = z.input<typeof groupChangesSchema>

export type ExpenseFormValues = z.output<typeof expenseFormSchema>
// Raw form input type (before zod transforms/coercions). react-hook-form
// operates on these values; the resolver produces ExpenseFormValues on submit.
export type ExpenseFormInput = z.input<typeof expenseFormSchema>

export type SplittingOptions = {
  // Used for saving default splitting options in localStorage
  splitMode: SplitMode
  paidFor: ExpenseFormValues['paidFor'] | null
}
