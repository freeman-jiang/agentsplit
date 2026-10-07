import { getGroup, getGroupExpenses } from '@/lib/api'
import { getBalances, groupExpensesByCurrency } from '@/lib/balances'
import { getCurrency } from '@/lib/currency'
import { MAX_GROUPS_PER_QUERY } from '@/lib/group-query-limits'
import { prisma } from '@/lib/prisma'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

/** Omit participantId for the caller's fixed membership; explicit IDs inspect another participant. */
export const forUserBalancesProcedure = baseProcedure
  .input(
    z.object({
      groups: z
        .array(
          z.object({
            groupId: z.string().min(1).max(64),
            participantId: z.string().min(1).max(64).optional(),
          }),
        )
        .max(MAX_GROUPS_PER_QUERY),
    }),
  )
  .query(async ({ ctx, input: { groups } }) => {
    const unboundGroupIds: string[] = []
    const balances = await Promise.all(
      groups.map(async ({ groupId, participantId }) => {
        if (!participantId) {
          const membership = await prisma.userGroupAccess.findUnique({
            where: {
              userId_groupId: { groupId, userId: ctx.principal!.userId },
            },
          })
          participantId = membership?.participantId ?? undefined
          if (!participantId) unboundGroupIds.push(groupId)
        }
        if (!participantId) return null
        const fixedParticipantId = participantId
        const group = await getGroup(groupId)
        if (!group) return null

        const participant = group.participants.find(
          (p) => p.id === participantId,
        )
        if (!participant) return null

        const expenses = await getGroupExpenses(groupId, {
          readOnly: ctx.readOnly,
        })
        return groupExpensesByCurrency(expenses).map(
          ({ currencyCode, expenses }) => ({
            groupId,
            groupName: group.name,
            currency: getCurrency(currencyCode).symbol,
            currencyCode,
            participantId,
            participantName: participant.name,
            amount: getBalances(expenses)[fixedParticipantId]?.total ?? '0',
          }),
        )
      }),
    )

    return {
      balances: balances.flatMap((balance) => balance ?? []),
      unboundGroupIds: unboundGroupIds.sort(),
    }
  })
