import { getGroup, getGroupExpensesParticipants } from '@/lib/api'
import { effectiveBaseUrl } from '@/lib/env'
import { groupMembers } from '@/lib/group-access'
import { groupPath } from '@/lib/group-slug'
import { prisma } from '@/lib/prisma'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const getGroupDetailsProcedure = baseProcedure
  .input(z.object({ groupId: z.string().min(1) }))
  .query(async ({ ctx, input: { groupId } }) => {
    const group = await getGroup(groupId)
    if (!group) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Group not found.',
      })
    }

    const participantsWithExpenses = await getGroupExpensesParticipants(groupId)
    const privateContext = await prisma.ungroupedExpense.findUnique({
      where: { groupId },
    })
    return {
      context: {
        kind: privateContext ? ('ungrouped' as const) : ('group' as const),
        expenseId: privateContext?.expenseId ?? null,
      },
      group,
      access: await groupMembers(groupId, ctx.principal!.userId),
      participantsWithExpenses,
      links: {
        share: `${effectiveBaseUrl}${groupPath(group)}`,
        csv: `${effectiveBaseUrl}${groupPath(group)}/expenses/export/csv`,
        json: `${effectiveBaseUrl}${groupPath(group)}/expenses/export/json`,
      },
    }
  })
