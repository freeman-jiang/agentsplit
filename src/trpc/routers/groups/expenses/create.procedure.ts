import { createExpense } from '@/lib/api'
import { effectiveBaseUrl } from '@/lib/env'
import {
  prepareExpenseUploads,
  uploadRequestsSchema,
} from '@/lib/expense-uploads'
import { randomId } from '@/lib/random'
import { expenseFormSchema } from '@/lib/schemas'
import {
  createUngroupedExpense,
  ungroupedExpenseInput,
} from '@/lib/ungrouped-expenses'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const createGroupExpenseProcedure = baseProcedure
  .input(
    z.object({
      groupId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Named group ID, or a private context ID when recording its repayment. Omit for a new ungrouped expense and supply people.',
        ),
      people: ungroupedExpenseInput.shape.people.optional(),
      expenseFormValues: expenseFormSchema,
      participantId: z.string().optional(),
      uploads: uploadRequestsSchema.optional(),
      // Optional caller-minted stable expense ID; otherwise minted server-side.
      expenseId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{21}$/)
        .optional(),
    }),
  )
  .mutation(
    async ({
      ctx,
      input: {
        groupId,
        people,
        expenseFormValues,
        participantId,
        expenseId,
        uploads,
      },
    }) => {
      if (!groupId) {
        if (!people)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Supply groupId for a group expense, or people for an ungrouped expense.',
          })
        if (uploads?.length)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Save an ungrouped expense first, then attach its receipts.',
          })
        const created = await createUngroupedExpense({
          actor: ctx.principal,
          baseUrl: effectiveBaseUrl,
          input: {
            expenseId: expenseId ?? randomId(),
            people,
            expense: expenseFormValues,
          },
        })
        return {
          ...created,
          amount: expenseFormValues.amount,
          currencyCode: expenseFormValues.currencyCode,
          uploads: [],
          uploadError: null,
        }
      }
      if (people)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'With groupId, use its existing participant IDs and omit people.',
        })
      const expense = await createExpense(
        expenseFormValues,
        groupId,
        participantId,
        expenseId,
        ctx.principal,
      )
      return {
        groupId,
        expenseId: expense.id,
        revision: expense.revision,
        amount: expense.amount,
        currencyCode: expense.currencyCode,
        ...(await prepareExpenseUploads(
          ctx.principal,
          groupId,
          expense.id,
          uploads,
        )),
      }
    },
  )
