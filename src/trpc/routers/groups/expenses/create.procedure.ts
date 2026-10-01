import { createExpense } from '@/lib/api'
import { expenseFormSchema } from '@/lib/schemas'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const createGroupExpenseProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      expenseFormValues: expenseFormSchema,
      participantId: z.string().optional(),
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
      input: { groupId, expenseFormValues, participantId, expenseId },
    }) => {
      const expense = await createExpense(
        expenseFormValues,
        groupId,
        participantId,
        expenseId,
        ctx.principal,
      )
      return { expenseId: expense.id }
    },
  )
