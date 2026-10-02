import { Prisma } from '@/generated/prisma/client'
import type { AuditActor } from '@/lib/expense-history'
import { prisma } from '@/lib/prisma'
import { initTRPC, TRPCError } from '@trpc/server'
import { headers } from 'next/headers'
import { cache } from 'react'
import superjson from 'superjson'

superjson.registerCustom<Prisma.Decimal, string>(
  {
    isApplicable: (v): v is Prisma.Decimal => Prisma.Decimal.isDecimal(v),
    serialize: (v) => v.toJSON(),
    deserialize: (v) => new Prisma.Decimal(v),
  },
  'decimal.js',
)

export type TRPCContext = {
  /** MCP reads must not materialize recurring expenses as a side effect. */
  readOnly?: boolean
  principal?: AuditActor & { groupIds: string[] }
}

export const createTRPCContext = cache(async (): Promise<TRPCContext> => {
  const { sessionPrincipal } = await import('@/lib/session')
  return { principal: await sessionPrincipal(await headers()) }
})

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC.context<TRPCContext>().create({
  /**
   * @see https://trpc.io/docs/server/data-transformers
   */
  transformer: superjson,
})

// Base router and procedure helpers
export const createTRPCRouter = t.router
export const baseProcedure = t.procedure.use(
  async ({ ctx, path, getRawInput, next }) => {
    const principal = ctx.principal
    if (!principal)
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required' })
    if (
      path.startsWith('groups.') &&
      !['groups.create', 'groups.access'].includes(path)
    ) {
      const input = (await getRawInput()) as
        | {
            groupId?: string
            groupIds?: string[]
            groups?: { groupId: string }[]
          }
        | undefined
      const requested =
        path === 'groups.list'
          ? (input?.groupIds ?? principal.groupIds)
          : path === 'groups.balances.forUser'
            ? input?.groups?.map((g) => g.groupId)
            : input?.groupId
              ? [input.groupId]
              : undefined
      if (!requested)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Group identifier is required',
        })
      const grants = await prisma.userGroupAccess.findMany({
        where: {
          userId: principal.userId,
          active: true,
          groupId: { in: requested },
        },
      })
      if (requested.some((id) => !grants.some((g) => g.groupId === id)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Group access denied',
        })
      if (path === 'groups.update' && grants.some((g) => g.role !== 'admin'))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only group admins can edit group settings',
        })
    }
    return next({ ctx: { ...ctx, principal } })
  },
)
