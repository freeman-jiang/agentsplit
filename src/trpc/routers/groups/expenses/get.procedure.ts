import { getExpense } from '@/lib/api'
import { effectiveBaseUrl } from '@/lib/env'
import {
  exclusiveHistorySelection,
  historicalExpense,
  historicalFields,
} from '@/lib/history-query'
import { receiptDownloadUrl } from '@/lib/receipt-url'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const getGroupExpenseProcedure = baseProcedure
  .input(
    z
      .object({
        groupId: z.string().min(1),
        expenseId: z.string().min(1),
        ...historicalFields,
        revision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Exact saved expense revision; exclusive with asOf/atActivityId.',
          ),
      })
      .refine(exclusiveHistorySelection, {
        message: 'Choose revision, asOf, or atActivityId',
      }),
  )
  .query(
    async ({ input: { groupId, expenseId, revision, asOf, atActivityId } }) => {
      let history:
        | {
            activityId: string
            recordedAt: string
            revision: number
            deleted: boolean
            snapshot: import('@/lib/expense-history').ExpenseSnapshot
          }
        | undefined
      let expense: Awaited<ReturnType<typeof getExpense>>
      if (revision !== undefined || asOf || atActivityId) {
        const record = await historicalExpense(groupId, expenseId, {
          revision,
          asOf,
          atActivityId,
        })
        const saved = record.snapshot.expense
        history = {
          activityId: record.event.id,
          recordedAt: record.event.time.toISOString(),
          revision: record.event.expenseRevision!,
          deleted: record.event.activityType === 'DELETE_EXPENSE',
          snapshot: record.snapshot,
        }
        expense = {
          ...saved,
          createdAt: new Date(saved.createdAt),
          expenseDate: new Date(saved.expenseDate),
          paidById: saved.paidBy.id,
          paidBy: { ...saved.paidBy, groupId },
          paidFor: saved.paidFor.map((p) => ({
            expenseId,
            participantId: p.participantId,
            shares: p.shares,
          })),
          documents: saved.documents.map((d) => ({ ...d, expenseId })),
          revision: record.event.expenseRevision!,
          deletedAt: history.deleted ? record.event.time : null,
          recurringExpenseLinkId: null,
          recurringExpenseLink: null,
        }
      } else expense = await getExpense(groupId, expenseId)
      if (!expense) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Expense not found',
        })
      }
      return {
        history,
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
    },
  )
