import { deleteExpense } from '@/lib/api'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const deleteGroupExpenseProcedure = baseProcedure
  .input(
    z.object({
      expenseId: z.string().min(1),
      groupId: z.string().min(1),
      participantId: z.string().optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    }),
  )
  .mutation(
    async ({
      ctx,
      input: { expenseId, groupId, participantId, expectedRevision },
    }) => {
      return deleteExpense(
        groupId,
        expenseId,
        participantId,
        ctx.principal,
        expectedRevision,
      )
    },
  )
