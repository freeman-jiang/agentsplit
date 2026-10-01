import { createExpense } from '@/lib/api'
import {
  prepareExpenseUploads,
  uploadRequestsSchema,
} from '@/lib/expense-uploads'
import { expenseFormSchema } from '@/lib/schemas'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const createGroupExpenseProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      expenseFormValues: expenseFormSchema,
      participantId: z.string().optional(),
      uploads: uploadRequestsSchema.optional(),
      // Optional caller-minted stable expense ID; otherwise minted server-side.
      expenseId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{21}$/)
        .optional(),
    }),
  )
  .mutation(
    async ({
      ctx,
      input: { groupId, expenseFormValues, participantId, expenseId, uploads },
    }) => {
      const expense = await createExpense(
        expenseFormValues,
        groupId,
        participantId,
        expenseId,
        ctx.principal,
      )
      return {
        expenseId: expense.id,
        revision: expense.revision,
        amount: expense.amount,
        currencyCode: expense.currencyCode,
        ...(await prepareExpenseUploads(
          ctx.principal,
          groupId,
          expense.id,
          uploads,
        )),
      }
    },
  )
