import { ActivityType } from '@/generated/prisma/browser'
import { getActivities } from '@/lib/api'
import {
  exclusiveHistorySelection,
  historicalFields,
  historyBoundary,
  recordedTimeSchema,
} from '@/lib/history-query'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const listGroupActivitiesProcedure = baseProcedure
  .input(
    z
      .object({
        ...historicalFields,
        recordedFrom: recordedTimeSchema.optional(),
        recordedTo: recordedTimeSchema.optional(),
        order: z.enum(['asc', 'desc']).default('desc'),
        groupId: z.string().min(1).max(64),
        cursor: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(5),
        expenseId: z.string().min(1).max(64).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        activityType: z.enum(ActivityType).optional(),
      })
      .refine(exclusiveHistorySelection, {
        message: 'Choose asOf or atActivityId',
      })
      .refine(
        ({ recordedFrom, recordedTo }) =>
          !recordedFrom ||
          !recordedTo ||
          Date.parse(recordedFrom) <= Date.parse(recordedTo),
        { message: 'recordedFrom must be on or before recordedTo' },
      )
      .refine(({ from, to }) => !from || !to || from <= to, {
        message: 'from must be on or before to',
        path: ['to'],
      }),
  )
  .query(
    async ({
      input: {
        groupId,
        cursor,
        limit,
        expenseId,
        from,
        to,
        activityType,
        asOf,
        atActivityId,
        recordedFrom,
        recordedTo,
        order,
      },
    }) => {
      const boundary = await historyBoundary(groupId, { asOf, atActivityId })
      const activities = await getActivities(groupId, {
        boundarySequence: boundary.sequence,
        historical: Boolean(asOf || atActivityId),
        recordedFrom,
        recordedTo:
          asOf && (!recordedTo || Date.parse(asOf) < Date.parse(recordedTo))
            ? asOf
            : recordedTo,
        order,
        offset: cursor,
        length: limit + 1,
        expenseId,
        from,
        to,
        activityType,
      })
      return {
        atActivityId: boundary.atActivityId,
        asOf: boundary.asOf,
        activities: activities.slice(0, limit),
        hasMore: !!activities[limit],
        nextCursor: cursor + limit,
      }
    },
  )
