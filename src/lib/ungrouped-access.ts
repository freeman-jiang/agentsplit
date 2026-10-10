import type { Prisma } from '@/generated/prisma/client'
import { TRPCError } from '@trpc/server'
import type { ExpenseFormValues } from './schemas'

export async function assertUngroupedWrite({
  tx,
  groupId,
  expenseId,
  values,
  creating,
}: {
  tx: Prisma.TransactionClient
  groupId: string
  expenseId: string
  values: ExpenseFormValues
  creating: boolean
}) {
  const context = await tx.ungroupedExpense.findUnique({
    where: { groupId },
    include: { people: true },
  })
  if (!context) return
  if (values.recurrenceRule !== 'NONE')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Ungrouped expenses do not recur.',
    })
  if (expenseId === context.expenseId && values.isReimbursement)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Record repayments separately from the original expense.',
    })
  if (expenseId !== context.expenseId && !values.isReimbursement)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Create a separate ungrouped expense for a new purchase.',
    })
  if (!values.isReimbursement) {
    const involved = new Set([
      values.paidBy,
      ...values.paidFor.map((p) => p.participant),
    ])
    if (
      involved.size !== context.people.length ||
      context.people.some((p) => !involved.has(p.participantId))
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'The people with access to this private expense cannot be changed. Create a new expense for a different set of people.',
      })
    }
  } else if (
    creating &&
    !(await tx.expense.findFirst({
      where: { id: context.expenseId, deletedAt: null },
    }))
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Cannot record a repayment for a deleted expense.',
    })
  }
}
