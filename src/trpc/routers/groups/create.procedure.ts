import { createGroup } from '@/lib/api'
import { groupFormSchema } from '@/lib/schemas'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const createGroupProcedure = baseProcedure
  .input(
    z.object({
      groupFormValues: groupFormSchema,
      groupId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{21}$/)
        .optional(),
    }),
  )
  .mutation(async ({ ctx, input: { groupFormValues, groupId } }) => {
    const group = await createGroup(groupFormValues, ctx.principal, groupId)
    return { groupId: group.id, group }
  })
