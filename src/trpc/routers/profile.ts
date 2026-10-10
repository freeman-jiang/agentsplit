import { assertOAuthWriteAccess } from '@/lib/expense-history'
import { prisma } from '@/lib/prisma'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { baseProcedure, createTRPCRouter } from '../init'

export const profileRouter = createTRPCRouter({
  update: baseProcedure
    .input(
      z.strictObject({
        name: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .describe(
            'Your single global display name, used across all current groups, expenses and future entries. Historical audit names and snapshots are preserved. Updates only the authenticated account; never changes email, IDs, membership or money.',
          ),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      prisma.$transaction(async (tx) => {
        await assertOAuthWriteAccess(tx, ctx.principal)
        const account = await tx.user.findUnique({
          where: { id: ctx.principal.userId },
        })
        if (!account?.emailVerified)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Verify your email before setting your display name.',
          })
        return {
          profile: await tx.user.update({
            where: { id: ctx.principal.userId },
            data: { name: input.name },
            select: { id: true, name: true, email: true, emailVerified: true },
          }),
        }
      }),
    ),
})
