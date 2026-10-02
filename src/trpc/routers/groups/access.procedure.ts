import { effectiveBaseUrl } from '@/lib/env'
import { changeGroupAccess, groupAccessInput } from '@/lib/group-access'
import { baseProcedure } from '@/trpc/init'

export const groupAccessProcedure = baseProcedure
  .input(groupAccessInput)
  .mutation(({ ctx, input }) =>
    changeGroupAccess(ctx.principal!, input, effectiveBaseUrl),
  )
