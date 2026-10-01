import { RecurrenceRule } from '@/generated/prisma/browser'
import { getGroupExpenses } from '@/lib/api'
import { expenseCurrencySchema } from '@/lib/currency'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const listGroupExpensesProcedure = baseProcedure
  .input(
    z
      .object({
        groupId: z.string().min(1).max(64),
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        filter: z.string().max(200).optional(),
        currencyCode: expenseCurrencySchema.optional(),
        categoryId: z.number().int().nonnegative().optional(),
        paidById: z.string().min(1).max(64).optional(),
        participantId: z.string().min(1).max(64).optional(),
        isReimbursement: z.boolean().optional(),
        recurrenceRule: z.enum(RecurrenceRule).optional(),
        from: z.iso
          .date()
          .describe('Inclusive expense date, YYYY-MM-DD')
          .optional(),
        to: z.iso
          .date()
          .describe('Inclusive expense date, YYYY-MM-DD')
          .optional(),
      })
      .refine(({ from, to }) => !from || !to || from <= to, {
        message: 'from must be on or before to',
        path: ['to'],
      }),
  )
  .query(
    async ({
      ctx,
      input: {
        groupId,
        cursor = 0,
        limit = 10,
        filter,
        from,
        to,
        currencyCode,
        categoryId,
        paidById,
        participantId,
        isReimbursement,
        recurrenceRule,
      },
    }) => {
      const expenses = await getGroupExpenses(groupId, {
        offset: cursor,
        length: limit + 1,
        filter,
        from,
        to,
        currencyCode,
        categoryId,
        paidById,
        participantId,
        isReimbursement,
        recurrenceRule,
        readOnly: ctx.readOnly,
      })
      return {
        expenses: expenses.slice(0, limit).map((expense) => ({
          ...expense,
          createdAt: new Date(expense.createdAt),
          expenseDate: new Date(expense.expenseDate),
        })),
        hasMore: !!expenses[limit],
        nextCursor: cursor + limit,
      }
    },
  )
