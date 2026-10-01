import {
  ActivityType,
  Expense,
  RecurrenceRule,
  RecurringExpenseLink,
} from '@/generated/prisma/client'
import {
  activitySnapshotSchema,
  baselineExpense,
  createExpenseRevision,
  groupSnapshotSchema,
  recordExpenseSnapshot,
  withGroupWrite,
  type AuditActor,
} from '@/lib/expense-history'
import { decimalStrings, type DecimalStrings } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { randomId } from '@/lib/random'
import {
  expenseFormSchema,
  groupFormSchema,
  type ExpenseFormValues,
  type GroupFormValues,
} from '@/lib/schemas'
import { TRPCError } from '@trpc/server'
import { expenseCurrencySchema } from './currency'

// Re-exported for backwards compatibility with existing server-side importers.
export { randomId }

export async function createGroup(groupFormValues: GroupFormValues) {
  groupFormValues = groupFormSchema.parse(groupFormValues)
  return prisma.group.create({
    data: {
      id: randomId(),
      name: groupFormValues.name,
      information: groupFormValues.information,
      currency: groupFormValues.currency,
      currencyCode: groupFormValues.currencyCode,
      participants: {
        createMany: {
          data: groupFormValues.participants.map(({ name }) => ({
            id: randomId(),
            name,
          })),
        },
      },
    },
    include: { participants: true },
  })
}

export async function createExpense(
  expenseFormValues: ExpenseFormValues,
  groupId: string,
  participantId?: string,
  // A caller may mint a stable expense ID before saving.
  expenseId: string = randomId(),
  actor?: AuditActor,
): Promise<DecimalStrings<Expense>> {
  expenseFormValues = expenseFormSchema.parse(expenseFormValues)
  return withGroupWrite(groupId, async (tx) => {
    const group = await tx.group.findUnique({
      where: { id: groupId },
      include: { participants: true },
    })
    if (!group) throw new Error(`Invalid group ID: ${groupId}`)
    const currencyCode = expenseCurrencySchema.parse(
      expenseFormValues.currencyCode ?? group.currencyCode,
    )
    if (
      expenseFormValues.originalAmount !== undefined ||
      expenseFormValues.conversionRate !== undefined ||
      expenseFormValues.originalCurrency
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Choose an expense currency and amount; currency conversion is not supported',
      })

    for (const participant of [
      expenseFormValues.paidBy,
      ...expenseFormValues.paidFor.map((p) => p.participant),
    ]) {
      if (!group.participants.some((p) => p.id === participant))
        throw new Error(`Invalid participant ID: ${participant}`)
    }

    const isCreateRecurrence =
      expenseFormValues.recurrenceRule !== RecurrenceRule.NONE
    const recurringExpenseLinkPayload = createPayloadForNewRecurringExpenseLink(
      expenseFormValues.recurrenceRule as RecurrenceRule,
      expenseFormValues.expenseDate,
      groupId,
    )

    const expense = await createExpenseRevision(
      tx,
      {
        id: expenseId,
        groupId,
        expenseDate: expenseFormValues.expenseDate,
        categoryId: expenseFormValues.category,
        amount: expenseFormValues.amount,
        currencyCode,
        title: expenseFormValues.title,
        paidById: expenseFormValues.paidBy,
        splitMode: expenseFormValues.splitMode,
        recurrenceRule: expenseFormValues.recurrenceRule,
        recurringExpenseLink: {
          ...(isCreateRecurrence
            ? {
                create: recurringExpenseLinkPayload,
              }
            : {}),
        },
        paidFor: {
          createMany: {
            data: expenseFormValues.paidFor.map((paidFor) => ({
              participantId: paidFor.participant,
              shares: paidFor.shares,
            })),
          },
        },
        isReimbursement: expenseFormValues.isReimbursement,
        documents: {
          createMany: {
            data: expenseFormValues.documents.map((doc) => ({
              id: randomId(),
              url: doc.url,
              width: doc.width,
              height: doc.height,
            })),
          },
        },
        notes: expenseFormValues.notes,
      },
      { participantId, actor },
    )
    return decimalStrings(expense)
  })
}

export async function deleteExpense(
  groupId: string,
  expenseId: string,
  participantId?: string,
  actor?: AuditActor,
) {
  return withGroupWrite(groupId, async (tx) => {
    const existingExpense = await tx.expense.findFirst({
      where: { id: expenseId, groupId, deletedAt: null },
    })
    if (!existingExpense)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense not found' })
    await baselineExpense(tx, existingExpense)
    const deletedAt = new Date()
    const expense = await tx.expense.update({
      where: { id: expenseId },
      data: { deletedAt, revision: { increment: 1 } },
    })
    await tx.recurringExpenseLink.updateMany({
      where: { currentFrameExpenseId: expenseId, nextExpenseCreatedAt: null },
      data: { nextExpenseCreatedAt: deletedAt },
    })
    const claimedActor = participantId
      ? await tx.participant.findFirst({
          where: { id: participantId, groupId },
        })
      : null
    await tx.activity.create({
      data: {
        id: randomId(),
        groupId,
        expenseId,
        expenseRevision: expense.revision,
        activityType: ActivityType.DELETE_EXPENSE,
        data: existingExpense.title,
        participantId: claimedActor?.id,
        actorName: claimedActor?.name,
        actorUserId: actor?.userId,
        agentKeyId: actor?.connectionId,
        source: actor ? 'agent' : 'web',
      },
    })
  })
}

export async function getGroupExpensesParticipants(groupId: string) {
  const [payers, paidFor] = await Promise.all([
    prisma.expense.findMany({
      where: { groupId },
      distinct: ['paidById'],
      select: { paidById: true },
    }),
    prisma.expensePaidFor.findMany({
      where: { expense: { groupId } },
      distinct: ['participantId'],
      select: { participantId: true },
    }),
  ])

  return Array.from(
    new Set([
      ...payers.map((expense) => expense.paidById),
      ...paidFor.map((row) => row.participantId),
    ]),
  )
}

export async function getGroups(groupIds: string[]) {
  return (
    await prisma.group.findMany({
      where: { id: { in: groupIds } },
      include: { _count: { select: { participants: true } } },
    })
  ).map((group) => ({
    ...group,
    createdAt: group.createdAt.toISOString(),
  }))
}

export async function updateExpense(
  groupId: string,
  expenseId: string,
  expenseFormValues: ExpenseFormValues,
  participantId?: string,
  actor?: AuditActor,
) {
  expenseFormValues = expenseFormSchema.parse(expenseFormValues)
  return withGroupWrite(groupId, async (tx) => {
    const group = await tx.group.findUnique({
      where: { id: groupId },
      include: { participants: true },
    })
    if (!group) throw new Error(`Invalid group ID: ${groupId}`)

    const existingExpense = await tx.expense.findUnique({
      where: { id: expenseId, groupId, deletedAt: null },
      include: { paidFor: true, documents: true, recurringExpenseLink: true },
    })
    if (!existingExpense) throw new Error(`Invalid expense ID: ${expenseId}`)
    const currencyCode = expenseCurrencySchema.parse(
      expenseFormValues.currencyCode ?? existingExpense.currencyCode,
    )
    if (
      expenseFormValues.originalAmount !== undefined ||
      expenseFormValues.conversionRate !== undefined ||
      expenseFormValues.originalCurrency
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Currency conversion is not supported',
      })

    for (const participant of [
      expenseFormValues.paidBy,
      ...expenseFormValues.paidFor.map((p) => p.participant),
    ]) {
      if (!group.participants.some((p) => p.id === participant))
        throw new Error(`Invalid participant ID: ${participant}`)
    }

    await baselineExpense(tx, existingExpense)

    const isDeleteRecurrenceExpenseLink =
      existingExpense.recurrenceRule !== RecurrenceRule.NONE &&
      expenseFormValues.recurrenceRule === RecurrenceRule.NONE &&
      // Delete the existing RecurrenceExpenseLink only if it has not been acted upon yet
      existingExpense.recurringExpenseLink?.nextExpenseCreatedAt === null

    const isUpdateRecurrenceExpenseLink =
      existingExpense.recurrenceRule !== expenseFormValues.recurrenceRule &&
      // Update the exisiting RecurrenceExpenseLink only if it has not been acted upon yet
      existingExpense.recurringExpenseLink?.nextExpenseCreatedAt === null
    const isCreateRecurrenceExpenseLink =
      existingExpense.recurrenceRule === RecurrenceRule.NONE &&
      expenseFormValues.recurrenceRule !== RecurrenceRule.NONE &&
      // Create a new RecurrenceExpenseLink only if one does not already exist for the expense
      existingExpense.recurringExpenseLink === null

    const newRecurringExpenseLink = createPayloadForNewRecurringExpenseLink(
      expenseFormValues.recurrenceRule as RecurrenceRule,
      expenseFormValues.expenseDate,
      groupId,
    )

    const updatedRecurrenceExpenseLinkNextExpenseDate = calculateNextDate(
      expenseFormValues.recurrenceRule as RecurrenceRule,
      existingExpense.expenseDate,
    )

    const expense = await tx.expense.update({
      where: { id: expenseId },
      data: {
        revision: { increment: 1 },
        currencyCode,
        expenseDate: expenseFormValues.expenseDate,
        amount: expenseFormValues.amount,
        ...(expenseFormValues.amount !== existingExpense.amount.toFixed() ||
        currencyCode !== existingExpense.currencyCode
          ? {
              originalAmount: null,
              originalCurrency: null,
              conversionRate: null,
            }
          : {}),
        title: expenseFormValues.title,
        categoryId: expenseFormValues.category,
        paidById: expenseFormValues.paidBy,
        splitMode: expenseFormValues.splitMode,
        recurrenceRule: expenseFormValues.recurrenceRule,
        paidFor: {
          deleteMany: {},
          create: expenseFormValues.paidFor.map((paidFor) => ({
            participantId: paidFor.participant,
            shares: paidFor.shares,
          })),
        },
        recurringExpenseLink: {
          ...(isCreateRecurrenceExpenseLink
            ? {
                create: newRecurringExpenseLink,
              }
            : {}),
          ...(isUpdateRecurrenceExpenseLink
            ? {
                update: {
                  nextExpenseDate: updatedRecurrenceExpenseLinkNextExpenseDate,
                },
              }
            : {}),
          delete: isDeleteRecurrenceExpenseLink,
        },
        isReimbursement: expenseFormValues.isReimbursement,
        documents: {
          create: expenseFormValues.documents
            .filter(
              (doc) =>
                !existingExpense.documents.some(
                  (existing) => existing.id === doc.id,
                ),
            )
            .map((doc) => ({ ...doc, id: randomId() })),
          deleteMany: existingExpense.documents
            .filter(
              (existingDoc) =>
                !expenseFormValues.documents.some(
                  (doc) => doc.id === existingDoc.id,
                ),
            )
            .map((doc) => ({
              id: doc.id,
            })),
        },
        notes: expenseFormValues.notes,
      },
    })
    await recordExpenseSnapshot(tx, expense.id, ActivityType.UPDATE_EXPENSE, {
      participantId,
      actor,
    })
    return decimalStrings(expense)
  })
}

export async function updateGroup(
  groupId: string,
  groupFormValues: GroupFormValues,
  participantId?: string,
  actor?: AuditActor,
) {
  groupFormValues = groupFormSchema.parse(groupFormValues)
  return withGroupWrite(groupId, async (tx) => {
    const existingGroup = await tx.group.findUnique({
      where: { id: groupId },
      include: { participants: true },
    })
    if (!existingGroup) throw new Error('Invalid group ID')

    const group = await tx.group.update({
      where: { id: groupId },
      data: {
        name: groupFormValues.name,
        information: groupFormValues.information,
        currency: groupFormValues.currency,
        currencyCode: groupFormValues.currencyCode,
        participants: {
          deleteMany: existingGroup.participants.filter(
            (p) => !groupFormValues.participants.some((p2) => p2.id === p.id),
          ),
          updateMany: groupFormValues.participants
            .filter((participant) => participant.id !== undefined)
            .map((participant) => ({
              where: { id: participant.id },
              data: {
                name: participant.name,
              },
            })),
          createMany: {
            data: groupFormValues.participants
              .filter((participant) => participant.id === undefined)
              .map((participant) => ({
                id: randomId(),
                name: participant.name,
              })),
          },
        },
      },
      include: { participants: true },
    })
    const claimedActor = participantId
      ? existingGroup.participants.find(
          (participant) => participant.id === participantId,
        )
      : undefined
    await tx.activity.create({
      data: {
        id: randomId(),
        groupId,
        activityType: ActivityType.UPDATE_GROUP,
        participantId: claimedActor?.id,
        actorName: claimedActor?.name,
        actorUserId: actor?.userId,
        agentKeyId: actor?.connectionId,
        source: actor ? 'agent' : 'web',
        snapshot: groupSnapshotSchema.parse({
          schemaVersion: 1,
          kind: 'group',
          group,
        }),
      },
    })
    return group
  })
}

export async function getGroup(groupId: string) {
  return prisma.group.findUnique({
    where: { id: groupId },
    include: { participants: true },
  })
}

export async function getCategories() {
  return prisma.category.findMany()
}

export async function getGroupExpenses(
  groupId: string,
  options?: {
    offset?: number
    length?: number
    filter?: string
    from?: string
    to?: string
    currencyCode?: string
    readOnly?: boolean
  },
) {
  if (!options?.readOnly) await createRecurringExpenses()

  const result = await prisma.expense.findMany({
    select: {
      amount: true,
      currencyCode: true,
      category: true,
      createdAt: true,
      expenseDate: true,
      id: true,
      isReimbursement: true,
      originalAmount: true,
      originalCurrency: true,
      paidBy: { select: { id: true, name: true } },
      paidFor: {
        select: {
          participant: { select: { id: true, name: true } },
          shares: true,
        },
      },
      splitMode: true,
      recurrenceRule: true,
      title: true,
      _count: { select: { documents: true } },
    },
    where: {
      groupId,
      deletedAt: null,
      currencyCode: options?.currencyCode,
      title: options?.filter
        ? { contains: options.filter, mode: 'insensitive' }
        : undefined,
      expenseDate:
        options?.from || options?.to
          ? {
              gte: options.from
                ? new Date(`${options.from}T00:00:00.000Z`)
                : undefined,
              lte: options.to
                ? new Date(`${options.to}T00:00:00.000Z`)
                : undefined,
            }
          : undefined,
    },
    orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    skip: options && options.offset,
    take: options && options.length,
  })
  return decimalStrings(result)
}

export async function getGroupExpenseCount(groupId: string) {
  return prisma.expense.count({ where: { groupId, deletedAt: null } })
}

/**
 * Returns the currently active recurring expenses of a group: the latest frame
 * of every ongoing recurring series. Each materialized frame keeps its own
 * `recurringExpenseLink`, but only the current frame's link is still "open"
 * (`nextExpenseCreatedAt` is null) — past frames have it set once their
 * successor is created (see `createRecurringExpenses`). Filtering on the open
 * link ensures a single subscription is counted only once. Used for recurring
 * stats (#508).
 */
export async function getActiveRecurringExpenses(
  groupId: string,
  options?: { readOnly?: boolean },
) {
  if (!options?.readOnly) await createRecurringExpenses()

  const result = await prisma.expense.findMany({
    select: {
      id: true,
      title: true,
      amount: true,
      category: true,
      recurrenceRule: true,
      isReimbursement: true,
      currencyCode: true,
    },
    where: {
      groupId,
      deletedAt: null,
      isReimbursement: false,
      recurrenceRule: { not: RecurrenceRule.NONE },
      recurringExpenseLink: { is: { nextExpenseCreatedAt: null } },
    },
    orderBy: { amount: 'desc' },
  })
  return decimalStrings(result)
}

export async function getExpense(groupId: string, expenseId: string) {
  const result = await prisma.expense.findUnique({
    where: { id: expenseId, groupId, deletedAt: null },
    include: {
      paidBy: true,
      paidFor: true,
      category: true,
      documents: true,
      recurringExpenseLink: true,
    },
  })
  return decimalStrings(result)
}

export async function getActivities(
  groupId: string,
  options?: {
    offset?: number
    length?: number
    expenseId?: string
    from?: string
    to?: string
    activityType?: ActivityType
  },
) {
  const activities = await prisma.activity.findMany({
    where: {
      groupId,
      expenseId: options?.expenseId,
      activityType: options?.activityType,
      time:
        options?.from || options?.to
          ? {
              gte: options.from
                ? new Date(`${options.from}T00:00:00.000Z`)
                : undefined,
              lt: options.to
                ? new Date(
                    new Date(`${options.to}T00:00:00.000Z`).getTime() +
                      86_400_000,
                  )
                : undefined,
            }
          : undefined,
    },
    orderBy: options?.expenseId
      ? [
          { expenseRevision: { sort: 'desc', nulls: 'last' } },
          { time: 'desc' },
          { id: 'desc' },
        ]
      : [{ time: 'desc' }, { id: 'desc' }],
    skip: options?.offset,
    take: options?.length,
  })

  const expenseIds = activities
    .map((activity) => activity.expenseId)
    .filter(Boolean)
  const previousVersions = activities.flatMap((activity) =>
    activity.expenseId &&
    activity.expenseRevision !== null &&
    activity.expenseRevision > 0
      ? [
          {
            expenseId: activity.expenseId,
            expenseRevision: activity.expenseRevision - 1,
          },
        ]
      : [],
  )
  const [expenses, previous] = await Promise.all([
    prisma.expense.findMany({
      where: {
        groupId,
        deletedAt: null,
        id: { in: expenseIds },
      },
    }),
    previousVersions.length
      ? prisma.activity.findMany({ where: { groupId, OR: previousVersions } })
      : Promise.resolve([]),
  ])
  const previousByVersion = new Map(
    previous.map((activity) => [
      `${activity.expenseId}:${activity.expenseRevision}`,
      activity.snapshot,
    ]),
  )

  return decimalStrings(
    activities.map((activity) => ({
      ...activity,
      snapshot:
        activity.snapshot === null
          ? null
          : activitySnapshotSchema.parse(activity.snapshot),
      previousSnapshot: (() => {
        const previous = previousByVersion.get(
          `${activity.expenseId}:${(activity.expenseRevision ?? 0) - 1}`,
        )
        return previous === undefined || previous === null
          ? null
          : activitySnapshotSchema.parse(previous)
      })(),
      expense:
        activity.expenseId !== null
          ? expenses.find((expense) => expense.id === activity.expenseId)
          : undefined,
    })),
  )
}

async function createRecurringExpenses() {
  const localDate = new Date() // Current local date
  const utcDateFromLocal = new Date(
    Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate(),
      // More precision beyond date is required to ensure that recurring Expenses are created within <most precises unit> of when expected
      localDate.getUTCHours(),
      localDate.getUTCMinutes(),
    ),
  )

  const recurringExpenseLinksWithExpensesToCreate =
    await prisma.recurringExpenseLink.findMany({
      where: {
        nextExpenseCreatedAt: null,
        nextExpenseDate: {
          lte: utcDateFromLocal,
        },
        currentFrameExpense: { deletedAt: null },
      },
      include: {
        currentFrameExpense: {
          include: {
            paidBy: true,
            paidFor: true,
            category: true,
            documents: true,
          },
        },
      },
    })

  for (const recurringExpenseLink of recurringExpenseLinksWithExpensesToCreate) {
    let newExpenseDate = recurringExpenseLink.nextExpenseDate

    let currentExpenseRecord = recurringExpenseLink.currentFrameExpense
    let currentReccuringExpenseLinkId = recurringExpenseLink.id

    while (newExpenseDate < utcDateFromLocal) {
      const newExpenseId = randomId()
      const newRecurringExpenseLinkId = randomId()

      // Use a transacton to ensure that the only one expense is created for the RecurringExpenseLink
      // just in case two clients are processing the same RecurringExpenseLink at the same time
      const newExpense = await prisma
        .$transaction(
          async (transaction) => {
            await transaction.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${currentExpenseRecord.groupId} FOR UPDATE`
            // Re-read after acquiring the same group lock as edits and deletions.
            const openLink = await transaction.recurringExpenseLink.findFirst({
              where: {
                id: currentReccuringExpenseLinkId,
                nextExpenseCreatedAt: null,
                currentFrameExpense: { deletedAt: null },
              },
              include: {
                currentFrameExpense: {
                  include: {
                    paidFor: true,
                    documents: true,
                    category: true,
                    paidBy: true,
                  },
                },
              },
            })
            if (!openLink) return null
            if (openLink.nextExpenseDate >= utcDateFromLocal) return null
            newExpenseDate = openLink.nextExpenseDate
            currentExpenseRecord = openLink.currentFrameExpense
            const newRecurringExpenseNextExpenseDate = calculateNextDate(
              currentExpenseRecord.recurrenceRule as RecurrenceRule,
              newExpenseDate,
            )
            const {
              category: _category,
              paidBy: _payer,
              paidFor: _shares,
              documents: _documents,
              ...currentFields
            } = currentExpenseRecord
            const newExpense = await createExpenseRevision(
              transaction,
              {
                ...currentFields,
                categoryId: currentExpenseRecord.categoryId,
                paidById: currentExpenseRecord.paidById,
                paidFor: {
                  createMany: {
                    data: currentExpenseRecord.paidFor.map((paidFor) => ({
                      participantId: paidFor.participantId,
                      shares: paidFor.shares,
                    })),
                  },
                },
                documents: {
                  create: currentExpenseRecord.documents.map(
                    ({ url, width, height }) => ({
                      id: randomId(),
                      url,
                      width,
                      height,
                    }),
                  ),
                },
                id: newExpenseId,
                expenseDate: newExpenseDate,
                recurringExpenseLink: {
                  create: {
                    groupId: currentExpenseRecord.groupId,
                    id: newRecurringExpenseLinkId,
                    nextExpenseDate: newRecurringExpenseNextExpenseDate,
                  },
                },
              },
              { source: 'system' },
            )

            // Mark the RecurringExpenseLink as being "completed" since the new Expense was created
            // if an expense hasn't been created for this RecurringExpenseLink yet
            await transaction.recurringExpenseLink.update({
              where: {
                id: currentReccuringExpenseLinkId,
                nextExpenseCreatedAt: null,
              },
              data: {
                nextExpenseCreatedAt: newExpense.createdAt,
              },
            })
            return transaction.expense.findUniqueOrThrow({
              where: { id: newExpense.id },
              include: {
                paidFor: true,
                documents: true,
                category: true,
                paidBy: true,
              },
            })
          },
          { maxWait: 10_000, timeout: 15_000 },
        )
        .catch(() => {
          console.error(
            'Failed to created recurringExpense for expenseId: %s',
            currentExpenseRecord.id,
          )
          return null
        })

      // If the new expense failed to be created, break out of the while-loop
      if (newExpense === null) break

      // Set the values for the next iteration of the for-loop in case multiple recurring Expenses need to be created
      currentExpenseRecord = newExpense
      currentReccuringExpenseLinkId = newRecurringExpenseLinkId
      newExpenseDate = calculateNextDate(
        newExpense.recurrenceRule as RecurrenceRule,
        newExpense.expenseDate,
      )
    }
  }
}

function createPayloadForNewRecurringExpenseLink(
  recurrenceRule: RecurrenceRule,
  priorDateToNextRecurrence: Date,
  groupId: String,
): RecurringExpenseLink {
  const nextExpenseDate = calculateNextDate(
    recurrenceRule,
    priorDateToNextRecurrence,
  )

  const recurringExpenseLinkId = randomId()
  const recurringExpenseLinkPayload = {
    id: recurringExpenseLinkId,
    groupId: groupId,
    nextExpenseDate: nextExpenseDate,
  }

  return recurringExpenseLinkPayload as RecurringExpenseLink
}

// TODO: Modify this function to use a more comprehensive recurrence Rule library like rrule (https://github.com/jkbrzt/rrule)
//
// Current limitations:
// - If a date is intended to be repeated monthly on the 29th, 30th or 31st, it will change to repeating on the smallest
// date that the reccurence has encountered. Ex. If a recurrence is created for Jan 31st on 2025, the recurring expense
// will be created for Feb 28th, March 28, etc. until it is cancelled or fixed
function calculateNextDate(
  recurrenceRule: RecurrenceRule,
  priorDateToNextRecurrence: Date,
): Date {
  const nextDate = new Date(priorDateToNextRecurrence)
  switch (recurrenceRule) {
    case RecurrenceRule.DAILY:
      nextDate.setUTCDate(nextDate.getUTCDate() + 1)
      break
    case RecurrenceRule.WEEKLY:
      nextDate.setUTCDate(nextDate.getUTCDate() + 7)
      break
    case RecurrenceRule.MONTHLY:
      const nextYear = nextDate.getUTCFullYear()
      const nextMonth = nextDate.getUTCMonth() + 1
      let nextDay = nextDate.getUTCDate()

      // Reduce the next day until it is within the direct next month
      while (!isDateInNextMonth(nextYear, nextMonth, nextDay)) {
        nextDay -= 1
      }
      nextDate.setUTCMonth(nextMonth, nextDay)
      break
  }

  return nextDate
}

function isDateInNextMonth(
  utcYear: number,
  utcMonth: number,
  utcDate: number,
): Boolean {
  const testDate = new Date(Date.UTC(utcYear, utcMonth, utcDate))

  // We're not concerned if the year or month changes. We only want to make sure that the date is our target date
  if (testDate.getUTCDate() !== utcDate) {
    return false
  }

  return true
}
