import { exportCSV as csvExport } from '@/lib/export-csv'
import { exportJSON as jsonExport } from '@/lib/export-json'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const exportGroupProcedure = baseProcedure
  .input(
    z.strictObject({
      groupId: z.string().min(1).max(64),
      format: z.enum(['json', 'csv']).default('json'),
    }),
  )
  .query(async ({ input: { groupId, format } }) => {
    const response = await (format === 'json' ? jsonExport : csvExport)(groupId)
    if (!response.ok)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
    return {
      filename: `agentsplit-${groupId}.${format}`,
      contentType: format === 'json' ? 'application/json' : 'text/csv',
      content: await response.text(),
    }
  })
