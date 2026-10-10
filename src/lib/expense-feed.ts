import type { Prisma } from '@/generated/prisma/client'
import { expenseAttributions } from '@/lib/expense-attribution'
import { decimalStrings } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { participantDisplayNames } from './display-names'
import { expenseFeedInput } from './expense-feed-input'

export { expenseFeedInput } from './expense-feed-input'

export function expenseFeedWhere({
  userId,
  input,
}: {
  userId: string
  input: z.output<typeof expenseFeedInput>
}): Prisma.ExpenseWhereInput {
  const conditions: Prisma.ExpenseWhereInput[] = [
    {
      deletedAt: null,
      group: { userAccess: { some: { userId, active: true } } },
    },
  ]
  if (input.scope === 'grouped')
    conditions.push({ group: { ungroupedContext: null } })
  if (input.scope === 'ungrouped')
    conditions.push({ group: { ungroupedContext: { isNot: null } } })
  if (input.groupId)
    conditions.push({
      groupId: input.groupId,
      group: { ungroupedContext: null },
    })
  if (input.currencyCode) conditions.push({ currencyCode: input.currencyCode })
  if (input.categoryId !== undefined)
    conditions.push({ categoryId: input.categoryId })
  if (input.isReimbursement !== undefined)
    conditions.push({ isReimbursement: input.isReimbursement })
  if (input.from || input.to)
    conditions.push({
      expenseDate: {
        ...(input.from ? { gte: new Date(input.from) } : {}),
        ...(input.to ? { lte: new Date(input.to) } : {}),
      },
    })
  if (input.filter)
    conditions.push({
      OR: [
        { title: { contains: input.filter, mode: 'insensitive' } },
        { vendor: { contains: input.filter, mode: 'insensitive' } },
      ],
    })
  for (const personId of [
    input.involvingMe ? userId : undefined,
    input.personId,
  ]) {
    if (personId)
      conditions.push({
        OR: [
          { paidBy: { memberships: { some: { userId: personId } } } },
          {
            paidFor: {
              some: {
                participant: { memberships: { some: { userId: personId } } },
              },
            },
          },
        ],
      })
  }
  if (input.paidByUserId)
    conditions.push({
      paidBy: { memberships: { some: { userId: input.paidByUserId } } },
    })
  if (input.cursor) {
    const { date, createdAt, id } = input.cursor
    conditions.push({
      OR: [
        { expenseDate: { lt: new Date(date) } },
        { expenseDate: new Date(date), createdAt: { lt: new Date(createdAt) } },
        {
          expenseDate: new Date(date),
          createdAt: new Date(createdAt),
          id: { lt: id },
        },
      ],
    })
  }
  return { AND: conditions }
}

export async function listExpenseFeed({
  userId,
  input,
}: {
  userId: string
  input: z.output<typeof expenseFeedInput>
}) {
  const rows = await prisma.expense.findMany({
    where: expenseFeedWhere({ userId, input }),
    orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    include: {
      paidBy: { select: { id: true, name: true } },
      paidFor: {
        select: {
          participant: { select: { id: true, name: true } },
          shares: true,
        },
      },
      category: true,
      _count: { select: { documents: true } },
      group: {
        select: {
          id: true,
          name: true,
          slug: true,
          ungroupedContext: {
            select: { expenseId: true, expense: { select: { title: true } } },
          },
          userAccess: {
            where: { userId, active: true },
            select: { participantId: true },
          },
        },
      },
    },
  })
  const page = rows.slice(0, input.limit)
  const attribution = await expenseAttributions(
    [...new Set(page.map((e) => e.groupId))],
    page.map((e) => e.id),
    undefined,
    userId,
  )
  const names = await participantDisplayNames({
    participantIds: page.flatMap((e) => [
      e.paidBy.id,
      ...e.paidFor.map((p) => p.participant.id),
    ]),
  })
  const expenses = decimalStrings(
    page.map(({ group, ...expense }) => ({
      ...expense,
      paidBy: {
        ...expense.paidBy,
        name: names.get(expense.paidBy.id) ?? expense.paidBy.name,
      },
      paidFor: expense.paidFor.map((p) => ({
        ...p,
        participant: {
          ...p.participant,
          name: names.get(p.participant.id) ?? p.participant.name,
        },
      })),
      group: group.ungroupedContext
        ? null
        : { id: group.id, name: group.name, slug: group.slug },
      contextExpenseId: group.ungroupedContext?.expenseId ?? null,
      contextExpenseTitle: group.ungroupedContext?.expense.title ?? null,
      participantId: group.userAccess[0]?.participantId ?? null,
      attribution: attribution.get(expense.id),
    })),
  )
  const last = page.at(-1)
  return {
    expenses,
    nextCursor:
      rows.length > input.limit && last
        ? {
            date: last.expenseDate.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          }
        : null,
  }
}

/** Existing verified members are discoverable only through shared active access. */
export async function expenseOptions({ userId }: { userId: string }) {
  const memberships = await prisma.userGroupAccess.findMany({
    where: { userId, active: true },
    select: { groupId: true },
  })
  const groupIds = memberships.map((m) => m.groupId)
  const peers = await prisma.userGroupAccess.findMany({
    where: {
      groupId: { in: groupIds },
      active: true,
      participantId: { not: null },
    },
    select: { userId: true },
  })
  const [groups, people] = await Promise.all([
    prisma.group.findMany({
      where: { id: { in: groupIds }, ungroupedContext: null },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: {
        id: { in: [userId, ...peers.map((p) => p.userId)] },
        emailVerified: true,
      },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  ])
  return { groups, people, userId }
}
