import { getGroups } from '@/lib/api'
import { MAX_GROUPS_PER_QUERY } from '@/lib/group-query-limits'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const listGroupsProcedure = baseProcedure
  .input(
    z.object({
      groupIds: z
        .array(z.string().min(1).max(64))
        .max(MAX_GROUPS_PER_QUERY)
        .optional(),
      cursor: z.number().int().min(0).optional().default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_GROUPS_PER_QUERY)
        .optional()
        .default(MAX_GROUPS_PER_QUERY),
    }),
  )
  .query(async ({ ctx, input: { groupIds, cursor, limit } }) => {
    const available = groupIds ?? ctx.principal?.groupIds ?? []
    const named = await getGroups(available)
    const groups = named.slice(cursor, cursor + limit)
    return {
      groups,
      hasMore: named.length > cursor + limit,
      nextCursor: cursor + limit,
    }
  })
