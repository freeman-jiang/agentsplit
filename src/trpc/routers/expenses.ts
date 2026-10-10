import { effectiveBaseUrl } from '@/lib/env'
import {
  expenseFeedInput,
  expenseOptions,
  listExpenseFeed,
} from '@/lib/expense-feed'
import { prisma } from '@/lib/prisma'
import {
  createUngroupedExpense,
  renewPrivateInvitation,
  ungroupedExpenseInput,
} from '@/lib/ungrouped-expenses'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { baseProcedure, createTRPCRouter } from '../init'

export const expensesRouter = createTRPCRouter({
  renewInvitation: baseProcedure
    .input(
      z.object({
        groupId: z.string().min(1),
        participantId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      renewPrivateInvitation({
        actor: ctx.principal,
        ...input,
        baseUrl: effectiveBaseUrl,
      }),
    ),
  list: baseProcedure
    .input(expenseFeedInput)
    .query(({ ctx, input }) =>
      listExpenseFeed({ userId: ctx.principal.userId, input }),
    ),
  options: baseProcedure.query(({ ctx }) =>
    expenseOptions({ userId: ctx.principal.userId }),
  ),
  createUngrouped: baseProcedure
    .input(ungroupedExpenseInput)
    .mutation(({ ctx, input }) =>
      createUngroupedExpense({
        actor: ctx.principal,
        input,
        baseUrl: effectiveBaseUrl,
      }),
    ),
  context: baseProcedure
    .input(z.object({ expenseId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const expense = await prisma.expense.findFirst({
        where: {
          id: input.expenseId,
          deletedAt: null,
          group: {
            userAccess: {
              some: { userId: ctx.principal.userId, active: true },
            },
          },
        },
        select: {
          groupId: true,
          isReimbursement: true,
          group: {
            select: {
              ungroupedContext: {
                select: {
                  expenseId: true,
                  expense: { select: { title: true } },
                },
              },
            },
          },
        },
      })
      if (!expense)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Expense not found.',
        })
      return {
        groupId: expense.groupId,
        isReimbursement: expense.isReimbursement,
        contextExpenseId: expense.group.ungroupedContext?.expenseId ?? null,
        contextExpenseTitle:
          expense.group.ungroupedContext?.expense.title ?? null,
      }
    }),
})
