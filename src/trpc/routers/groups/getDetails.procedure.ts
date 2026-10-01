import { getGroup, getGroupExpensesParticipants } from '@/lib/api'
import { effectiveBaseUrl } from '@/lib/env'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const getGroupDetailsProcedure = baseProcedure
  .input(z.object({ groupId: z.string().min(1) }))
  .query(async ({ input: { groupId } }) => {
    const group = await getGroup(groupId)
    if (!group) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Group not found.',
      })
    }

    const participantsWithExpenses = await getGroupExpensesParticipants(groupId)
    return {
      group,
      participantsWithExpenses,
      links: {
        share: `${effectiveBaseUrl}/groups/${group.id}`,
        csv: `${effectiveBaseUrl}/groups/${group.id}/expenses/export/csv`,
        json: `${effectiveBaseUrl}/groups/${group.id}/expenses/export/json`,
      },
    }
  })
