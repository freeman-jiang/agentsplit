import { effectiveBaseUrl } from '@/lib/env'
import { changeGroupAccess } from '@/lib/group-access'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const groupAccessProcedure = baseProcedure
  .input(
    z
      .strictObject({
        action: z.enum(['join', 'leave']),
        shareUrl: z.url().max(2000).optional(),
        groupId: z.string().min(1).max(64).optional(),
      })
      .superRefine((input, ctx) => {
        if (input.action === 'join' && !input.shareUrl)
          ctx.addIssue({
            code: 'custom',
            message: 'shareUrl is required to join',
            path: ['shareUrl'],
          })
        if (input.action === 'leave' && !input.groupId)
          ctx.addIssue({
            code: 'custom',
            message: 'groupId is required to leave',
            path: ['groupId'],
          })
      }),
  )
  .mutation(async ({ ctx, input }) => {
    if (!ctx.principal)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Agent authentication is required',
      })
    if (
      input.action === 'leave' &&
      !ctx.principal.groupIds.includes(input.groupId!)
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This connection cannot access the requested group',
      })
    return changeGroupAccess(ctx.principal, input, effectiveBaseUrl)
  })
