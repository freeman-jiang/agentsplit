import { accountDisplayNames } from './display-names'
import { prisma } from './prisma'

export type ExpenseAttribution = {
  createdAt?: string | null
  updatedAt?: string | null
  lastEditedByYouAt?: string | null
  createdBy: { userId: string | null; name: string; source: string } | null
  updatedBy: { userId: string | null; name: string; source: string } | null
}

/** Batch audit attribution, never infer an author from the payer or a legacy baseline. */
export async function expenseAttributions(
  groupId: string | string[],
  expenseIds: string[],
  throughSequence?: number,
  viewerUserId?: string,
) {
  if (!expenseIds.length) return new Map<string, ExpenseAttribution>()
  const events = await prisma.activity.findMany({
    where: {
      groupId: typeof groupId === 'string' ? groupId : { in: groupId },
      sequence:
        throughSequence === undefined ? undefined : { lte: throughSequence },
      expenseId: { in: expenseIds },
      activityType: { in: ['CREATE_EXPENSE', 'UPDATE_EXPENSE'] },
      source: { not: 'baseline' },
    },
    select: {
      expenseId: true,
      time: true,
      activityType: true,
      actorUserId: true,
      actorName: true,
      source: true,
    },
    orderBy: { sequence: 'asc' },
  })
  const result = new Map<string, ExpenseAttribution>()
  const currentNames =
    throughSequence === undefined
      ? await accountDisplayNames({
          userIds: events.flatMap((event) =>
            event.actorUserId ? [event.actorUserId] : [],
          ),
        })
      : new Map<string, string>()
  for (const event of events) {
    const row: ExpenseAttribution = result.get(event.expenseId!) ?? {
      createdBy: null,
      updatedBy: null,
    }
    const actor =
      event.actorUserId || event.source === 'system'
        ? {
            userId: event.actorUserId,
            name:
              (event.actorUserId
                ? currentNames.get(event.actorUserId)
                : undefined) ??
              event.actorName ??
              (event.source === 'system' ? 'Automatic recurrence' : 'Member'),
            source: event.source,
          }
        : null
    if (event.activityType === 'CREATE_EXPENSE') {
      row.createdBy ??= actor
      row.createdAt ??= event.time.toISOString()
    } else {
      row.updatedBy = actor
      row.updatedAt = event.time.toISOString()
      if (viewerUserId && event.actorUserId === viewerUserId)
        row.lastEditedByYouAt = event.time.toISOString()
    }
    result.set(event.expenseId!, row)
  }
  return result
}
