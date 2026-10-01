import { ActivityType } from '@/generated/prisma/browser'
import { getActivities } from '@/lib/api'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const listGroupActivitiesProcedure = baseProcedure
  .input(
    z
      .object({
        groupId: z.string().min(1).max(64),
        cursor: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(5),
        expenseId: z.string().min(1).max(64).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        activityType: z.enum(ActivityType).optional(),
      })
      .refine(({ from, to }) => !from || !to || from <= to, {
        message: 'from must be on or before to',
        path: ['to'],
      }),
  )
  .query(
    async ({
      input: { groupId, cursor, limit, expenseId, from, to, activityType },
    }) => {
      const activities = await getActivities(groupId, {
        offset: cursor,
        length: limit + 1,
        expenseId,
        from,
        to,
        activityType,
      })
      return {
        activities: activities.slice(0, limit),
        hasMore: !!activities[limit],
        nextCursor: cursor + limit,
      }
    },
  )
