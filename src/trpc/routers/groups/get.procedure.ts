import { getGroup } from '@/lib/api'
import { prisma } from '@/lib/prisma'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const getGroupProcedure = baseProcedure
  .input(z.object({ groupId: z.string().min(1) }))
  .query(async ({ ctx, input: { groupId } }) => {
    const group = await getGroup(groupId)
    const membership = await prisma.userGroupAccess.findUniqueOrThrow({
      where: { userId_groupId: { groupId, userId: ctx.principal!.userId } },
      select: { participantId: true, role: true },
    })
    return { group, membership }
  })
