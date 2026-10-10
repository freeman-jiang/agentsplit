import { getGroup, getGroupExpenses } from '@/lib/api'
import { getBalances, groupExpensesByCurrency } from '@/lib/balances'
import { getCurrency } from '@/lib/currency'
import { MAX_GROUPS_PER_QUERY } from '@/lib/group-query-limits'
import { add } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
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
        .max(MAX_GROUPS_PER_QUERY)
        .refine(
          (groups) =>
            new Set(groups.map((group) => group.groupId)).size ===
            groups.length,
          'Choose each group or private context only once.',
        )
        .optional()
        .describe(
          'Omit to include every currently accessible named group and private expense context, without a page-size cap. Supply a unique list to restrict the scope.',
        ),
    }),
  )
  .query(async ({ ctx, input: { groups } }) => {
    const selectedGroups =
      groups ??
      (await prisma.userGroupAccess.findMany({
        where: { userId: ctx.principal.userId, active: true },
        select: { groupId: true },
      }))
    const unboundGroupIds: string[] = []
    const balances = await Promise.all(
      selectedGroups.map(
        async ({
          groupId,
          participantId,
        }: {
          groupId: string
          participantId?: string
        }) => {
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
          if (!group)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Group not found.',
            })

          const participant = group.participants.find(
            (p) => p.id === participantId,
          )
          if (!participant)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Participant does not belong to this group.',
            })

          const expenses = await getGroupExpenses(groupId, {
            readOnly: true,
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
        },
      ),
    )

    const rows = balances.flatMap((balance) => balance ?? [])
    const byCurrency = new Map<string, string>()
    for (const row of rows)
      byCurrency.set(
        row.currencyCode,
        add(byCurrency.get(row.currencyCode) ?? '0', row.amount),
      )
    return {
      balances: rows,
      totals: [...byCurrency]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currencyCode, amount]) => ({ currencyCode, amount })),
      unboundGroupIds: unboundGroupIds.sort(),
    }
  })
