import {
  ActivityType,
  Expense,
  RecurrenceRule,
  RecurringExpenseLink,
} from '@/generated/prisma/client'
import {
  activitySnapshotSchema,
  assertActorWriteAccess,
  assertOAuthWriteAccess,
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
  groupCreateSchema,
  groupFormSchema,
  type ExpenseChanges,
  type ExpenseFormValues,
  type GroupChanges,
  type GroupFormValues,
} from '@/lib/schemas'
import { TRPCError } from '@trpc/server'
import { expenseCurrencySchema } from './currency'
import { currentParticipants, participantDisplayNames } from './display-names'
import {
  expenseAttributions,
  type ExpenseAttribution,
} from './expense-attribution'
import { expenseTitle } from './expense-title'
import type { FinalizedUploads } from './expense-uploads'
import { claimGroupSlug } from './group-slug-write'
import { assertReceiptOwnership } from './receipt-ownership'
import { assertRevision } from './revision'
import { assertUngroupedWrite } from './ungrouped-access'

// Re-exported for backwards compatibility with existing server-side importers.
export { randomId }

export async function createGroup(
  groupFormValues: GroupFormValues,
  actor?: AuditActor,
  groupId = randomId(),
) {
  groupFormValues = (actor ? groupCreateSchema : groupFormSchema).parse(
    groupFormValues,
  )
  return prisma.$transaction(async (tx) => {
    await assertOAuthWriteAccess(tx, actor)
    const prior = await tx.group.findUnique({
      where: { id: groupId },
      include: { participants: true },
    })
    if (prior)
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Group ID is already in use; read it before retrying or choose a new ID',
      })
    const creator = actor
      ? await tx.user.findUnique({ where: { id: actor.userId } })
      : null
    if (actor && !creator?.emailVerified)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'A verified account is required',
      })
    const creatorId = actor ? randomId() : undefined
    const participants = [
      ...(creator
        ? [
            {
              id: creatorId!,
              name: creator.name.trim().slice(0, 50) || 'Member',
            },
          ]
        : []),
      ...groupFormValues.participants.map(({ name }) => ({
        id: randomId(),
        name,
      })),
    ]
    if (new Set(participants.map((p) => p.name)).size !== participants.length)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'The creator is added automatically. Give each other participant a distinct name.',
      })
    await claimGroupSlug(tx, groupFormValues.slug, groupId)
    const group = await tx.group.create({
      data: {
        id: groupId,
        name: groupFormValues.name,
        slug: groupFormValues.slug || null,
        information: groupFormValues.information,
        currency: groupFormValues.currency,
        currencyCode: groupFormValues.currencyCode,
        revision: 1,
        participants: {
          createMany: {
            data: participants,
          },
        },
      },
      include: { participants: true },
    })
    if (actor)
      await tx.userGroupAccess.create({
        data: {
          userId: actor.userId,
          groupId: group.id,
          role: 'admin',
          participantId: creatorId,
        },
      })
    await tx.activity.create({
      data: {
        id: randomId(),
        groupId: group.id,
        activityType: 'CREATE_GROUP',
        data: group.name,
        actorUserId: actor?.userId,
        actorName: actor?.name ?? actor?.userId,
        agentKeyId: actor?.connectionId || undefined,
        source: actor?.source ?? (actor ? 'agent' : 'web'),
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

export async function createExpense(
  expenseFormValues: ExpenseFormValues,
  groupId: string,
  participantId?: string,
  // A caller may mint a stable expense ID before saving.
  expenseId: string = randomId(),
  actor?: AuditActor,
): Promise<DecimalStrings<Expense>> {
  expenseFormValues = expenseFormSchema.parse(expenseFormValues)
  return withGroupWrite(
    groupId,
    async (tx) => {
      const group = await tx.group.findUnique({
        where: { id: groupId },
        include: { participants: true },
      })
      if (!group) throw new Error(`Invalid group ID: ${groupId}`)
      await assertUngroupedWrite({
        tx,
        groupId,
        expenseId,
        values: expenseFormValues,
        creating: true,
      })
      if (
        await tx.expense.findFirst({
          where: { id: expenseId, groupId },
          select: { id: true },
        })
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Expense ID already exists. Read it before retrying; use a new ID only for a distinct expense.',
        })
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
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Payer and beneficiary IDs must belong to this group',
          })
      }

      if (actor)
        await assertReceiptOwnership(tx, groupId, expenseFormValues.documents)
      const isCreateRecurrence =
        expenseFormValues.recurrenceRule !== RecurrenceRule.NONE
      const recurringExpenseLinkPayload =
        createPayloadForNewRecurringExpenseLink(
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
          vendor: expenseFormValues.vendor || null,
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
    },
    actor,
  )
}

export async function deleteExpense(
  groupId: string,
  expenseId: string,
  participantId?: string,
  actor?: AuditActor,
  expectedRevision?: number,
) {
  return withGroupWrite(
    groupId,
    async (tx) => {
      const existingExpense = await tx.expense.findFirst({
        where: { id: expenseId, groupId, deletedAt: null },
      })
      if (!existingExpense)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense not found' })
      const privateContext = await tx.ungroupedExpense.findUnique({
        where: { groupId },
      })
      if (
        privateContext?.expenseId === expenseId &&
        (await tx.expense.count({
          where: { groupId, isReimbursement: true, deletedAt: null },
        }))
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Remove this expense’s recorded repayments before deleting the expense.',
        })
      }
      assertRevision(existingExpense.revision, expectedRevision, actor)
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
          data: expenseTitle(existingExpense),
          participantId: actor ? undefined : claimedActor?.id,
          actorName: actor?.name ?? actor?.userId ?? claimedActor?.name,
          actorUserId: actor?.userId,
          agentKeyId: actor?.connectionId || undefined,
          source: actor?.source ?? (actor ? 'agent' : 'web'),
        },
      })
      return { expenseId, revision: expense.revision, deleted: true as const }
    },
    actor,
  )
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
      where: { id: { in: groupIds }, ungroupedContext: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
  expenseFormValues: ExpenseChanges,
  participantId?: string,
  actor?: AuditActor,
  expectedRevision?: number,
  attachUploadIds: string[] = [],
) {
  const uploads = attachUploadIds.length
    ? await import('./expense-uploads')
    : undefined
  let finalized: FinalizedUploads | undefined
  try {
    const result = await withGroupWrite(
      groupId,
      async (tx) => {
        const group = await tx.group.findUnique({
          where: { id: groupId },
          include: { participants: true },
        })
        if (!group) throw new Error(`Invalid group ID: ${groupId}`)

        const existingExpense = await tx.expense.findUnique({
          where: { id: expenseId, groupId, deletedAt: null },
          include: {
            paidFor: true,
            documents: true,
            recurringExpenseLink: true,
          },
        })
        if (!existingExpense)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Expense not found',
          })
        assertRevision(existingExpense.revision, expectedRevision, actor)
        let values = expenseFormSchema.parse({
          title: existingExpense.title,
          vendor: existingExpense.vendor,
          currencyCode: existingExpense.currencyCode,
          amount: existingExpense.amount.toFixed(),
          expenseDate: existingExpense.expenseDate,
          category: existingExpense.categoryId,
          paidBy: existingExpense.paidById,
          paidFor: existingExpense.paidFor.map((person) => ({
            participant: person.participantId,
            shares: person.shares.toFixed(),
          })),
          splitMode: existingExpense.splitMode,
          isReimbursement: existingExpense.isReimbursement,
          documents: existingExpense.documents,
          notes: existingExpense.notes ?? '',
          recurrenceRule: existingExpense.recurrenceRule ?? 'NONE',
          ...expenseFormValues,
        })
        const currencyCode = expenseCurrencySchema.parse(
          values.currencyCode ?? existingExpense.currencyCode,
        )
        await assertUngroupedWrite({
          tx,
          groupId,
          expenseId,
          values,
          creating: false,
        })
        if (
          values.originalAmount !== undefined ||
          values.conversionRate !== undefined ||
          values.originalCurrency
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Currency conversion is not supported',
          })

        for (const participant of [
          values.paidBy,
          ...values.paidFor.map((p) => p.participant),
        ]) {
          if (!group.participants.some((p) => p.id === participant))
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Payer and beneficiary IDs must belong to this group',
            })
        }

        if (actor) await assertReceiptOwnership(tx, groupId, values.documents)
        if (attachUploadIds.length) {
          finalized = await uploads!.finalizeExpenseUploads(
            actor,
            groupId,
            expenseId,
            attachUploadIds,
          )
          for (const document of finalized.documents)
            await tx.receiptObject.create({
              data: {
                id: document.id,
                groupId,
                url: document.url,
                createdBy: actor?.userId,
              },
            })
          values = expenseFormSchema.parse({
            ...values,
            documents: [...values.documents, ...finalized.documents],
          })
        }
        if (
          Object.keys(expenseFormValues).length === 0 &&
          attachUploadIds.length === 0
        )
          return decimalStrings(existingExpense)
        await baselineExpense(tx, existingExpense)

        const isDeleteRecurrenceExpenseLink =
          existingExpense.recurrenceRule !== RecurrenceRule.NONE &&
          values.recurrenceRule === RecurrenceRule.NONE &&
          // Delete the existing RecurrenceExpenseLink only if it has not been acted upon yet
          existingExpense.recurringExpenseLink?.nextExpenseCreatedAt === null

        const isUpdateRecurrenceExpenseLink =
          existingExpense.recurrenceRule !== values.recurrenceRule &&
          // Update the exisiting RecurrenceExpenseLink only if it has not been acted upon yet
          existingExpense.recurringExpenseLink?.nextExpenseCreatedAt === null
        const isCreateRecurrenceExpenseLink =
          existingExpense.recurrenceRule === RecurrenceRule.NONE &&
          values.recurrenceRule !== RecurrenceRule.NONE &&
          // Create a new RecurrenceExpenseLink only if one does not already exist for the expense
          existingExpense.recurringExpenseLink === null

        const newRecurringExpenseLink = createPayloadForNewRecurringExpenseLink(
          values.recurrenceRule as RecurrenceRule,
          values.expenseDate,
          groupId,
        )

        const updatedRecurrenceExpenseLinkNextExpenseDate = calculateNextDate(
          values.recurrenceRule as RecurrenceRule,
          existingExpense.expenseDate,
        )

        const expense = await tx.expense.update({
          where: { id: expenseId },
          data: {
            revision: { increment: 1 },
            currencyCode,
            expenseDate: values.expenseDate,
            amount: values.amount,
            ...(values.amount !== existingExpense.amount.toFixed() ||
            currencyCode !== existingExpense.currencyCode
              ? {
                  originalAmount: null,
                  originalCurrency: null,
                  conversionRate: null,
                }
              : {}),
            title: values.title,
            vendor: values.vendor || null,
            categoryId: values.category,
            paidById: values.paidBy,
            splitMode: values.splitMode,
            recurrenceRule: values.recurrenceRule,
            paidFor: {
              deleteMany: {},
              create: values.paidFor.map((paidFor) => ({
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
                      nextExpenseDate:
                        updatedRecurrenceExpenseLinkNextExpenseDate,
                    },
                  }
                : {}),
              delete: isDeleteRecurrenceExpenseLink,
            },
            isReimbursement: values.isReimbursement,
            documents: {
              create: values.documents
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
                    !values.documents.some((doc) => doc.id === existingDoc.id),
                )
                .map((doc) => ({
                  id: doc.id,
                })),
            },
            notes: values.notes,
          },
        })
        await recordExpenseSnapshot(
          tx,
          expense.id,
          ActivityType.UPDATE_EXPENSE,
          {
            participantId,
            actor,
          },
        )
        return decimalStrings(expense)
      },
      actor,
    )
    await uploads?.cleanupReceiptKeys(finalized?.temporaryKeys ?? [])
    return result
  } catch (error) {
    await uploads?.cleanupReceiptKeys(finalized?.permanentKeys ?? [])
    throw error
  }
}

export async function updateGroup(
  groupId: string,
  groupFormValues: GroupChanges,
  participantId?: string,
  actor?: AuditActor,
  expectedRevision?: number,
) {
  return withGroupWrite(
    groupId,
    async (tx) => {
      if (await tx.ungroupedExpense.findUnique({ where: { groupId } })) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'A private expense is not a named group. Its people and visibility cannot be changed through group settings.',
        })
      }
      if (actor) {
        const membership = await tx.userGroupAccess.findUnique({
          where: { userId_groupId: { userId: actor.userId, groupId } },
        })
        if (membership?.role !== 'admin')
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only group admins can edit group settings',
          })
      }
      const existingGroup = await tx.group.findUnique({
        where: { id: groupId },
        include: { participants: true },
      })
      if (!existingGroup)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
      existingGroup.participants = await currentParticipants({
        people: existingGroup.participants,
        db: tx,
      })
      assertRevision(existingGroup.revision, expectedRevision, actor)
      for (const person of groupFormValues.participants ?? []) {
        if (
          person.id &&
          !existingGroup.participants.some(
            (existing) => existing.id === person.id,
          )
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Existing participant IDs must belong to this group; omit the ID to add someone new',
          })
      }
      const values = groupFormSchema.parse({
        name: existingGroup.name,
        slug: existingGroup.slug,
        information: existingGroup.information ?? '',
        currency: existingGroup.currency,
        currencyCode: existingGroup.currencyCode,
        participants: existingGroup.participants.map((person) => ({
          id: person.id,
          name: person.name,
        })),
        ...groupFormValues,
      })

      // Bound identities and invitations cannot be renamed or removed by a general settings edit.
      const identities = await tx.participant.findMany({
        where: {
          groupId,
          OR: [{ memberships: { some: {} } }, { invitations: { some: {} } }],
        },
      })
      const identityNames = new Map(
        existingGroup.participants.map((p) => [p.id, p.name]),
      )
      for (const person of identities) {
        if (
          !values.participants.some(
            (p) =>
              p.id === person.id && p.name === identityNames.get(person.id),
          )
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'Members and invited participant identities cannot be renamed or removed.',
          })
      }
      if (Object.keys(groupFormValues).length === 0) return existingGroup
      await claimGroupSlug(tx, values.slug, groupId)
      const group = await tx.group.update({
        where: { id: groupId },
        data: {
          revision: { increment: 1 },
          name: values.name,
          slug: values.slug || null,
          information: values.information,
          currency: values.currency,
          currencyCode: values.currencyCode,
          participants: {
            deleteMany: existingGroup.participants.filter(
              (p) => !values.participants.some((p2) => p2.id === p.id),
            ),
            updateMany: values.participants
              .filter(
                (participant) =>
                  participant.id !== undefined &&
                  !identities.some((p) => p.id === participant.id),
              )
              .map((participant) => ({
                where: { id: participant.id },
                data: {
                  name: participant.name,
                },
              })),
            createMany: {
              data: values.participants
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
      group.participants = await currentParticipants({
        people: group.participants,
        db: tx,
      })
      await tx.activity.create({
        data: {
          id: randomId(),
          groupId,
          activityType: ActivityType.UPDATE_GROUP,
          participantId: actor ? undefined : claimedActor?.id,
          actorName: actor?.name ?? actor?.userId ?? claimedActor?.name,
          actorUserId: actor?.userId,
          agentKeyId: actor?.connectionId || undefined,
          source: actor?.source ?? (actor ? 'agent' : 'web'),
          snapshot: groupSnapshotSchema.parse({
            schemaVersion: 1,
            kind: 'group',
            group,
          }),
        },
      })
      return group
    },
    actor,
  )
}

export async function getGroup(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { participants: true },
  })
  return group
    ? {
        ...group,
        participants: await currentParticipants({ people: group.participants }),
      }
    : null
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
    vendor?: string
    from?: string
    to?: string
    currencyCode?: string
    categoryId?: number
    paidById?: string
    participantId?: string
    isReimbursement?: boolean
    recurrenceRule?: RecurrenceRule
    readOnly?: boolean
    viewerUserId?: string
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
      vendor: true,
      _count: { select: { documents: true } },
    },
    where: {
      groupId,
      deletedAt: null,
      currencyCode: options?.currencyCode,
      vendor: options?.vendor
        ? { equals: options.vendor, mode: 'insensitive' }
        : undefined,
      categoryId: options?.categoryId,
      paidById: options?.paidById,
      isReimbursement: options?.isReimbursement,
      recurrenceRule: options?.recurrenceRule,
      OR: options?.participantId
        ? [
            { paidById: options.participantId },
            { paidFor: { some: { participantId: options.participantId } } },
          ]
        : undefined,
      AND: options?.filter
        ? [
            {
              OR: [
                { title: { contains: options.filter, mode: 'insensitive' } },
                { vendor: { contains: options.filter, mode: 'insensitive' } },
              ],
            },
          ]
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
  const attribution = await expenseAttributions(
    groupId,
    result.map((e) => e.id),
    undefined,
    options?.viewerUserId,
  )
  const names = await participantDisplayNames({
    participantIds: result.flatMap((e) => [
      e.paidBy.id,
      ...e.paidFor.map((p) => p.participant.id),
    ]),
  })
  return decimalStrings(result).map(
    (e): typeof e & { attribution?: ExpenseAttribution } => ({
      ...e,
      paidBy: { ...e.paidBy, name: names.get(e.paidBy.id) ?? e.paidBy.name },
      paidFor: e.paidFor.map((p) => ({
        ...p,
        participant: {
          ...p.participant,
          name: names.get(p.participant.id) ?? p.participant.name,
        },
      })),
      attribution: attribution.get(e.id) ?? {
        createdBy: null,
        updatedBy: null,
      },
    }),
  )
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
      vendor: true,
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
  if (result)
    result.paidBy = (await currentParticipants({ people: [result.paidBy] }))[0]!
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
    boundarySequence?: number
    historical?: boolean
    recordedFrom?: string
    recordedTo?: string
    order?: 'asc' | 'desc'
  },
) {
  const activities = await prisma.activity.findMany({
    where: {
      groupId,
      sequence:
        options?.boundarySequence === undefined
          ? undefined
          : { lte: options.boundarySequence },
      AND: [
        ...(options?.recordedFrom
          ? [{ time: { gte: new Date(options.recordedFrom) } }]
          : []),
        ...(options?.recordedTo
          ? [{ time: { lte: new Date(options.recordedTo) } }]
          : []),
      ],
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
    orderBy:
      options?.boundarySequence !== undefined
        ? [{ sequence: options.order ?? 'desc' }]
        : options?.expenseId
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
    options?.historical
      ? Promise.resolve([])
      : prisma.expense.findMany({
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
    activities.map(({ sequence: _sequence, ...activity }) => ({
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

export async function createRecurringExpenses(
  groupId?: string,
  actor?: AuditActor,
) {
  const createdIds: string[] = []
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
        groupId,
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
            await assertActorWriteAccess(
              transaction,
              currentExpenseRecord.groupId,
              actor,
            )
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
              { source: 'system', actor },
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
        .catch((error) => {
          if (actor) throw error
          console.error(
            'Failed to created recurringExpense for expenseId: %s',
            currentExpenseRecord.id,
          )
          return null
        })

      // If the new expense failed to be created, break out of the while-loop
      if (newExpense === null) break

      // Set the values for the next iteration of the for-loop in case multiple recurring Expenses need to be created
      createdIds.push(newExpense.id)
      currentExpenseRecord = newExpense
      currentReccuringExpenseLinkId = newRecurringExpenseLinkId
      newExpenseDate = calculateNextDate(
        newExpense.recurrenceRule as RecurrenceRule,
        newExpense.expenseDate,
      )
    }
  }
  return { createdExpenseIds: createdIds }
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
