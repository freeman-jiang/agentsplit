import { createRecurringExpenses } from '@/lib/api'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const processRecurringProcedure = baseProcedure
  .input(z.strictObject({ groupId: z.string().min(1).max(64) }))
  .mutation(({ ctx, input }) =>
    createRecurringExpenses(input.groupId, ctx.principal),
  )
