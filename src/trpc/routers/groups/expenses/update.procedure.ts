import { updateExpense } from '@/lib/api'
import {
  prepareExpenseUploads,
  uploadIdsSchema,
  uploadRequestsSchema,
} from '@/lib/expense-uploads'
import { expenseChangesSchema } from '@/lib/schemas'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const updateGroupExpenseProcedure = baseProcedure
  .input(
    z.object({
      expenseId: z.string().min(1),
      groupId: z.string().min(1),
      expenseFormValues: expenseChangesSchema.default({}),
      participantId: z.string().optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      uploads: uploadRequestsSchema.optional(),
      attachUploadIds: uploadIdsSchema.optional(),
    }),
  )
  .mutation(
    async ({
      ctx,
      input: {
        expenseId,
        groupId,
        expenseFormValues,
        participantId,
        expectedRevision,
        uploads,
        attachUploadIds,
      },
    }) => {
      const expense = await updateExpense(
        groupId,
        expenseId,
        expenseFormValues,
        participantId,
        ctx.principal,
        expectedRevision,
        attachUploadIds,
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
