import { prisma } from './prisma'

export type ExpenseAttribution = {
  createdBy: { userId: string | null; name: string; source: string } | null
  updatedBy: { userId: string | null; name: string; source: string } | null
}

/** Batch audit attribution, never infer an author from the payer or a legacy baseline. */
export async function expenseAttributions(
  groupId: string,
  expenseIds: string[],
  throughSequence?: number,
) {
  if (!expenseIds.length) return new Map<string, ExpenseAttribution>()
  const events = await prisma.activity.findMany({
    where: {
      groupId,
      sequence:
        throughSequence === undefined ? undefined : { lte: throughSequence },
      expenseId: { in: expenseIds },
      activityType: { in: ['CREATE_EXPENSE', 'UPDATE_EXPENSE'] },
      source: { not: 'baseline' },
    },
    select: {
      expenseId: true,
      activityType: true,
      actorUserId: true,
      actorName: true,
      source: true,
    },
    orderBy: { sequence: 'asc' },
  })
  const result = new Map<string, ExpenseAttribution>()
  for (const event of events) {
    const row = result.get(event.expenseId!) ?? {
      createdBy: null,
      updatedBy: null,
    }
    const actor =
      event.actorUserId || event.source === 'system'
        ? {
            userId: event.actorUserId,
            name:
              event.actorName ??
              (event.source === 'system' ? 'Automatic recurrence' : 'Member'),
            source: event.source,
          }
        : null
    if (event.activityType === 'CREATE_EXPENSE') row.createdBy ??= actor
    else row.updatedBy = actor
    result.set(event.expenseId!, row)
  }
  return result
}
