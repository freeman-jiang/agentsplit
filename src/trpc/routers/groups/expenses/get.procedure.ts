import { getExpense } from '@/lib/api'
import { effectiveBaseUrl } from '@/lib/env'
import { receiptDownloadUrl } from '@/lib/receipt-url'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const getGroupExpenseProcedure = baseProcedure
  .input(z.object({ groupId: z.string().min(1), expenseId: z.string().min(1) }))
  .query(async ({ input: { groupId, expenseId } }) => {
    const expense = await getExpense(groupId, expenseId)
    if (!expense) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Expense not found',
      })
    }
    return {
      expense: {
        ...expense,
        documents: expense.documents.map((document) => ({
          ...document,
          downloadUrl: receiptDownloadUrl(
            groupId,
            document.url,
            effectiveBaseUrl,
          ),
        })),
      },
    }
  })
