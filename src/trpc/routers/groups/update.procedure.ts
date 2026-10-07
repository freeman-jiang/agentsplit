import { updateGroup } from '@/lib/api'
import { groupChangesSchema } from '@/lib/schemas'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const updateGroupProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      groupFormValues: groupChangesSchema,
      participantId: z.string().optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    }),
  )
  .mutation(
    async ({
      ctx,
      input: { groupId, groupFormValues, participantId, expectedRevision },
    }) => {
      const group = await updateGroup(
        groupId,
        groupFormValues,
        participantId,
        ctx.principal,
        expectedRevision,
      )
      return { groupId: group.id, group }
    },
  )
