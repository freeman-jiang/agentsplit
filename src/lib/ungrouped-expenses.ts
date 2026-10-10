import { createHash, randomBytes } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { getCurrency } from './currency'
import { expenseOptions } from './expense-feed'
import {
  assertOAuthWriteAccess,
  createExpenseRevision,
  groupSnapshotSchema,
  withGroupWrite,
  type AuditActor,
} from './expense-history'
import { prisma } from './prisma'
import { randomId } from './random'
import { expenseFormSchema } from './schemas'

export async function renewPrivateInvitation({
  actor,
  groupId,
  participantId,
  baseUrl,
}: {
  actor: AuditActor
  groupId: string
  participantId: string
  baseUrl: string
}) {
  return withGroupWrite(
    groupId,
    async (tx) => {
      const membership = await tx.userGroupAccess.findUnique({
        where: { userId_groupId: { userId: actor.userId, groupId } },
      })
      const person = await tx.ungroupedPerson.findUnique({
        where: { participantId },
        include: { participant: true },
      })
      if (membership?.role !== 'admin' || person?.groupId !== groupId)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Only the expense creator can reissue its original invitations.',
        })
      if (
        await tx.userGroupAccess.findFirst({
          where: { groupId, participantId },
        })
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This person has already joined.',
        })
      await tx.groupInvitation.updateMany({
        where: { groupId, participantId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      const secret = randomBytes(32).toString('base64url')
      const invitation = await tx.groupInvitation.create({
        data: {
          id: randomId(),
          groupId,
          participantId,
          participantName: person.participant.name,
          email: person.email,
          tokenHash: createHash('sha256').update(secret).digest('hex'),
          createdBy: actor.userId,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      })
      await tx.activity.create({
        data: {
          id: randomId(),
          groupId,
          activityType: 'UPDATE_GROUP',
          data: 'Private expense invitation renewed',
          actorUserId: actor.userId,
          actorName: actor.name ?? actor.userId,
          source: actor.source ?? 'agent',
          agentKeyId: actor.connectionId || null,
        },
      })
      return {
        id: invitation.id,
        email: invitation.email,
        participantId: person.participantId,
        participantName: person.participant.name,
        expiresAt: invitation.expiresAt.toISOString(),
        url: new URL(`/invite/${secret}`, baseUrl).href,
      }
    },
    actor,
  )
}

export const ungroupedExpenseInput = z.object({
  expenseId: z.string().regex(/^[A-Za-z0-9_-]{21}$/),
  people: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('account'),
          id: z.string().min(1).max(42),
          userId: z.string().min(1).max(128),
        }),
        z.object({
          kind: z.literal('email'),
          id: z.string().min(1).max(42),
          name: z.string().trim().min(1).max(50),
          email: z.email().transform((v) => v.trim().toLowerCase()),
        }),
      ]),
    )
    .min(2)
    .max(100),
  expense: expenseFormSchema,
})

export async function createUngroupedExpense({
  actor,
  input,
  baseUrl,
}: {
  actor: AuditActor
  input: z.output<typeof ungroupedExpenseInput>
  baseUrl: string
}) {
  const { people: known } = await expenseOptions({ userId: actor.userId })
  const people = input.people.map((person) => {
    const account =
      person.kind === 'account'
        ? known.find((p) => p.id === person.userId)
        : known.find((p) => p.email.toLowerCase() === person.email)
    if (person.kind === 'account' && !account)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Choose an existing contact or invite someone by email.',
      })
    return {
      localId: person.id,
      // Common prefix preserves the splitter's local-ID ordering while making
      // reusable agent labels ("me", "friend") unique in the participant table.
      id: `${input.expenseId}_${person.id}`,
      name: account?.name ?? (person.kind === 'email' ? person.name : ''),
      email: (
        account?.email ?? (person.kind === 'email' ? person.email : '')
      ).toLowerCase(),
      userId: account?.id,
    }
  })
  const self = people.find((p) => p.userId === actor.userId)
  const participants = new Set([
    input.expense.paidBy,
    ...input.expense.paidFor.map((p) => p.participant),
  ])
  if (
    !self ||
    !participants.has(self.localId) ||
    people.some((p) => !participants.has(p.localId)) ||
    participants.size !== people.length ||
    new Set(people.map((p) => p.id)).size !== people.length ||
    new Set(people.map((p) => p.email)).size !== people.length
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Include yourself and exactly the people paying for or sharing this expense. Each person must be unique.',
    })
  }
  if (
    input.expense.isReimbursement ||
    input.expense.documents.length ||
    input.expense.recurrenceRule !== 'NONE'
  )
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Create the expense first, then attach receipts or record a repayment. Ungrouped expenses do not recur.',
    })
  return prisma.$transaction(
    async (tx) => {
      await assertOAuthWriteAccess(tx, actor)
      const owner = await tx.user.findUnique({ where: { id: actor.userId } })
      if (!owner?.emailVerified)
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'A verified account is required.',
        })
      const prior = await tx.expense.findUnique({
        where: { id: input.expenseId },
        select: { id: true },
      })
      if (prior)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Expense ID already exists. Read it before retrying.',
        })
      const groupId = input.expenseId
      const group = await tx.group.create({
        data: {
          id: groupId,
          name: input.expense.title,
          currency: getCurrency(input.expense.currencyCode).symbol,
          currencyCode: input.expense.currencyCode,
          revision: 1,
          participants: {
            create: people.map((p) => ({ id: p.id, name: p.name })),
          },
        },
        include: { participants: true },
      })
      await tx.userGroupAccess.createMany({
        data: people.flatMap((p) =>
          p.userId
            ? [
                {
                  userId: p.userId,
                  groupId,
                  participantId: p.id,
                  role: p.userId === actor.userId ? 'admin' : 'member',
                },
              ]
            : [],
        ),
      })
      await tx.activity.create({
        data: {
          id: randomId(),
          groupId,
          activityType: 'CREATE_GROUP',
          data: 'Private expense',
          actorUserId: actor.userId,
          actorName: actor.name ?? actor.userId,
          source: actor.source ?? 'agent',
          agentKeyId: actor.connectionId || null,
          snapshot: groupSnapshotSchema.parse({
            schemaVersion: 1,
            kind: 'group',
            group,
          }),
        },
      })
      const expense = input.expense
      const persistedIds = new Map(people.map((p) => [p.localId, p.id]))
      await createExpenseRevision(
        tx,
        {
          id: input.expenseId,
          groupId,
          expenseDate: expense.expenseDate,
          categoryId: expense.category,
          amount: expense.amount,
          currencyCode: expense.currencyCode,
          title: expense.title,
          vendor: expense.vendor || null,
          paidById: persistedIds.get(expense.paidBy)!,
          splitMode: expense.splitMode,
          recurrenceRule: 'NONE',
          isReimbursement: false,
          notes: expense.notes,
          paidFor: {
            create: expense.paidFor.map((p) => ({
              participantId: persistedIds.get(p.participant)!,
              shares: p.shares,
            })),
          },
        },
        { actor },
      )
      await tx.ungroupedExpense.create({
        data: {
          groupId,
          expenseId: input.expenseId,
          people: {
            create: people.map((p) => ({
              participantId: p.id,
              email: p.email,
            })),
          },
        },
      })
      const invitations = []
      for (const person of people.filter((p) => !p.userId)) {
        const secret = randomBytes(32).toString('base64url')
        const expiresAt = new Date(Date.now() + 7 * 86400000)
        await tx.groupInvitation.create({
          data: {
            id: randomId(),
            groupId,
            email: person.email,
            participantId: person.id,
            participantName: person.name,
            tokenHash: createHash('sha256').update(secret).digest('hex'),
            createdBy: actor.userId,
            expiresAt,
          },
        })
        invitations.push({
          email: person.email,
          url: new URL(`/invite/${secret}`, baseUrl).href,
          expiresAt: expiresAt.toISOString(),
        })
      }
      return {
        expenseId: input.expenseId,
        groupId,
        revision: 1,
        invitations,
        participants: people.map((p) => ({
          localId: p.localId,
          participantId: p.id,
          name: p.name,
        })),
      }
    },
    { timeout: 15000 },
  )
}
