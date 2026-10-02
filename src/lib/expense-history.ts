import { RecurrenceRule, SplitMode } from '@/generated/prisma/browser'
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { randomId } from '@/lib/random'
import { TRPCError } from '@trpc/server'
import * as z from 'zod'
import { expenseCurrencySchema } from './currency'
import { decimalStrings, decimalTextSchema } from './money'

const person = z.object({ id: z.string(), name: z.string() })
const group = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string(),
  currencyCode: z.string().nullable(),
})
export const expenseSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('expense'),
  group,
  expense: z.object({
    id: z.string(),
    groupId: z.string(),
    revision: z.number().int().nonnegative(),
    title: z.string(),
    amount: decimalTextSchema,
    currencyCode: expenseCurrencySchema,
    expenseDate: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    categoryId: z.number().int(),
    category: z
      .object({ id: z.number().int(), name: z.string(), grouping: z.string() })
      .nullable(),
    originalAmount: decimalTextSchema.nullable(),
    originalCurrency: z.string().nullable(),
    conversionRate: z.string().nullable(),
    paidBy: person,
    paidFor: z.array(
      z.object({
        participantId: z.string(),
        name: z.string(),
        shares: decimalTextSchema,
      }),
    ),
    splitMode: z.enum(SplitMode),
    isReimbursement: z.boolean(),
    notes: z.string().nullable(),
    recurrenceRule: z.enum(RecurrenceRule).nullable(),
    documents: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        width: z.number().int(),
        height: z.number().int(),
      }),
    ),
  }),
})
export const groupSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('group'),
  group: group.extend({
    information: z.string().nullable(),
    revision: z.number().int().nonnegative().default(0),
    participants: z.array(person),
  }),
})
export const activitySnapshotSchema = z.discriminatedUnion('kind', [
  expenseSnapshotSchema,
  groupSnapshotSchema,
])
export type ExpenseSnapshot = z.infer<typeof expenseSnapshotSchema>
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>
export type AuditActor = {
  userId: string
  name?: string
  source?: 'web' | 'agent'
  connectionId: string
  groupIds?: string[]
}

export async function assertActorWriteAccess(
  tx: Prisma.TransactionClient,
  groupId: string,
  actor?: AuditActor,
) {
  if (!actor) return
  const access = await tx.userGroupAccess.findUnique({
    where: { userId_groupId: { userId: actor.userId, groupId } },
  })
  if (!access?.active)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This connection cannot access the requested group',
    })
}

export const snapshotInclude = {
  group: true,
  paidBy: true,
  paidFor: { include: { participant: true } },
  category: true,
  documents: true,
} satisfies Prisma.ExpenseInclude
type SnapshotExpense = Prisma.ExpenseGetPayload<{
  include: typeof snapshotInclude
}>

/** One lock order for every group write, including scheduled expense creation. */
export function withGroupWrite<T>(
  groupId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  actor?: AuditActor,
) {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Group" WHERE "id" = ${groupId} FOR UPDATE`
      if (!rows.length)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
      await assertActorWriteAccess(tx, groupId, actor)
      return write(tx)
    },
    { maxWait: 10_000, timeout: 15_000 },
  )
}

export function makeExpenseSnapshot(expense: SnapshotExpense): ExpenseSnapshot {
  return expenseSnapshotSchema.parse(
    decimalStrings({
      schemaVersion: 1,
      kind: 'expense',
      group: expense.group,
      expense: {
        ...expense,
        expenseDate: expense.expenseDate.toISOString(),
        createdAt: expense.createdAt.toISOString(),
        conversionRate: expense.conversionRate?.toString() ?? null,
        paidFor: expense.paidFor
          .map(({ participant, shares }) => ({
            participantId: participant.id,
            name: participant.name,
            shares,
          }))
          .sort((a, b) => a.participantId.localeCompare(b.participantId)),
      },
    }),
  )
}

export async function recordExpenseSnapshot(
  tx: Prisma.TransactionClient,
  expenseId: string,
  type: 'CREATE_EXPENSE' | 'UPDATE_EXPENSE',
  options: {
    participantId?: string
    actor?: AuditActor
    source?: 'baseline' | 'system'
  } = {},
) {
  const expense = await tx.expense.findUniqueOrThrow({
    where: { id: expenseId },
    include: snapshotInclude,
  })
  const snapshot = makeExpenseSnapshot(expense)
  const claimedActor = options.participantId
    ? await tx.participant.findFirst({
        where: { id: options.participantId, groupId: expense.groupId },
      })
    : null
  await tx.activity.create({
    data: {
      id: randomId(),
      groupId: expense.groupId,
      expenseId,
      expenseRevision: expense.revision,
      activityType: type,
      data: expense.title,
      snapshot,
      participantId: options.actor ? undefined : claimedActor?.id,
      actorName:
        options.actor?.name ?? options.actor?.userId ?? claimedActor?.name,
      actorUserId: options.actor?.userId,
      agentKeyId: options.actor?.connectionId || undefined,
      source:
        options.source ??
        options.actor?.source ??
        (options.actor ? 'agent' : 'web'),
    },
  })
}

/** All expense creation, including recurrence, persists and audits here. */
export async function createExpenseRevision(
  tx: Prisma.TransactionClient,
  data: Prisma.ExpenseUncheckedCreateInput,
  options: Parameters<typeof recordExpenseSnapshot>[3] = {},
) {
  const expense = await tx.expense.create({
    data: { ...data, revision: 1, deletedAt: null, createdAt: new Date() },
  })
  await recordExpenseSnapshot(tx, expense.id, 'CREATE_EXPENSE', options)
  return expense
}

export async function baselineExpense(
  tx: Prisma.TransactionClient,
  expense: { id: string; revision: number },
) {
  if (expense.revision === 0)
    await recordExpenseSnapshot(tx, expense.id, 'CREATE_EXPENSE', {
      source: 'baseline',
    })
}
