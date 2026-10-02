import { Prisma, type Activity } from '@/generated/prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { getGroupExpenses } from './api'
import { expenseSnapshotSchema, type ExpenseSnapshot } from './expense-history'
import { prisma } from './prisma'

export const recordedTimeSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => !/\.\d{4}/.test(value),
    'Use timestamps with at most millisecond precision',
  )
  .describe(
    'Recorded-change timestamp with timezone, e.g. 2026-10-01T15:00:00Z; not the expense date.',
  )
export const historicalFields = {
  asOf: recordedTimeSchema.optional(),
  atActivityId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Exact inclusive history boundary from this group. Reuse the returned boundary for stable pagination.',
    ),
}
export function exclusiveHistorySelection(input: {
  asOf?: string
  atActivityId?: string
  revision?: number
}) {
  return (
    [input.asOf, input.atActivityId, input.revision].filter(
      (value) => value !== undefined,
    ).length <= 1
  )
}
export const historicalViewSchema = z.object({
  asOf: recordedTimeSchema,
  atActivityId: z.string().nullable(),
  complete: z.boolean(),
  unavailableExpenseIds: z.array(z.string()),
})
export type HistoricalView = z.infer<typeof historicalViewSchema>
export type HistorySelection = { asOf?: string; atActivityId?: string }
export type HistoryBoundary = {
  asOf: string
  atActivityId: string | null
  sequence: number
  timestampCutoff?: Date
}

export async function historyBoundary(
  groupId: string,
  selection: HistorySelection,
): Promise<HistoryBoundary> {
  if (!exclusiveHistorySelection(selection))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose asOf or atActivityId, not both',
    })
  let timestamp: Date | undefined
  if (selection.asOf) {
    timestamp = new Date(recordedTimeSchema.parse(selection.asOf))
    if (timestamp.getTime() > Date.now())
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'asOf cannot be in the future',
      })
  }
  const event = selection.atActivityId
    ? await prisma.activity.findFirst({
        where: { id: selection.atActivityId, groupId },
      })
    : await prisma.activity.findFirst({
        where: { groupId, ...(timestamp ? { time: { lte: timestamp } } : {}) },
        orderBy: { sequence: 'desc' },
      })
  if (selection.atActivityId && !event)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'History boundary not found in this group',
    })
  return {
    asOf: (timestamp ?? event?.time ?? new Date()).toISOString(),
    atActivityId: event?.id ?? null,
    sequence: event?.sequence ?? 0,
    ...(timestamp ? { timestampCutoff: timestamp } : {}),
  }
}

/** Reconstruct persisted snapshots, never current expense fields or current names. */
export function latestExpenseSnapshots(events: readonly Activity[]) {
  const latest = new Map<string, Activity>()
  for (const event of events)
    if (event.expenseId && event.expenseRevision !== null) {
      const prior = latest.get(event.expenseId)
      if (!prior || event.sequence > prior.sequence)
        latest.set(event.expenseId, event)
    }
  return [...latest.values()]
    .filter((event) => event.activityType !== 'DELETE_EXPENSE')
    .map((event) => {
      const snapshot = expenseSnapshotSchema.parse(event.snapshot)
      return { event, snapshot }
    })
}

export type HistoricalExpense = Awaited<
  ReturnType<typeof getGroupExpenses>
>[number]
export function historicalExpenseSummary(
  snapshot: ExpenseSnapshot,
): HistoricalExpense {
  const expense = snapshot.expense
  return {
    id: expense.id,
    title: expense.title,
    amount: expense.amount,
    currencyCode: expense.currencyCode,
    createdAt: new Date(expense.createdAt),
    expenseDate: new Date(expense.expenseDate),
    category: expense.category,
    originalAmount: expense.originalAmount,
    originalCurrency: expense.originalCurrency,
    paidBy: expense.paidBy,
    paidFor: expense.paidFor.map((p) => ({
      participant: { id: p.participantId, name: p.name },
      shares: p.shares,
    })),
    isReimbursement: expense.isReimbursement,
    splitMode: expense.splitMode,
    recurrenceRule: expense.recurrenceRule,
    _count: { documents: expense.documents.length },
  }
}

export async function historicalLedger(
  groupId: string,
  selection: HistorySelection,
) {
  const boundary = await historyBoundary(groupId, selection)
  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    select: { createdAt: true },
  })
  if (group.createdAt > new Date(boundary.asOf))
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'The group did not exist at this time',
    })
  // One query takes the last recorded revision of each expense at the boundary.
  const rows = await prisma.$queryRaw<Activity[]>`
  SELECT DISTINCT ON ("expenseId") * FROM "Activity"
  WHERE "groupId"=${groupId} AND "expenseId" IS NOT NULL AND "expenseRevision" IS NOT NULL
    AND "sequence"<=${boundary.sequence}
    AND (${boundary.timestampCutoff ?? null}::timestamp IS NULL OR "time"<=${boundary.timestampCutoff ?? null}::timestamp)
  ORDER BY "expenseId", "sequence" DESC`
  const snapshots = latestExpenseSnapshots(rows)
  // A baseline is evidence only from its recording time onward. Never infer earlier edits.
  const missing = await prisma.$queryRaw<{ id: string }[]>`
  SELECT e.id FROM "Expense" e
  WHERE e."groupId"=${groupId} AND e."createdAt"<=${new Date(boundary.asOf)}
    AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."groupId"=${groupId} AND a."expenseId"=e.id AND a."expenseRevision" IS NOT NULL AND a."sequence"<=${boundary.sequence} AND (${boundary.timestampCutoff ?? null}::timestamp IS NULL OR a.time<=${boundary.timestampCutoff ?? null}::timestamp))
    AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."groupId"=${groupId} AND a."expenseId"=e.id AND a."activityType"='CREATE_EXPENSE' AND a."expenseRevision"=1 AND a.source<>'baseline')
  ORDER BY e.id`
  const history: HistoricalView = {
    asOf: boundary.asOf,
    atActivityId: boundary.atActivityId,
    complete: missing.length === 0,
    unavailableExpenseIds: missing.map((e) => e.id),
  }
  return {
    history,
    snapshots,
    expenses: snapshots.map(({ snapshot }) =>
      historicalExpenseSummary(snapshot),
    ),
  }
}

export function filterHistoricalExpenses(
  entries: { snapshot: ExpenseSnapshot; event: Activity }[],
  filters: {
    filter?: string
    currencyCode?: string
    categoryId?: number
    paidById?: string
    participantId?: string
    isReimbursement?: boolean
    recurrenceRule?: string
    from?: string
    to?: string
  },
) {
  return entries
    .filter(
      ({ snapshot: { expense: e } }) =>
        (!filters.filter ||
          e.title
            .toLocaleLowerCase()
            .includes(filters.filter.toLocaleLowerCase())) &&
        (!filters.currencyCode || e.currencyCode === filters.currencyCode) &&
        (filters.categoryId === undefined ||
          e.categoryId === filters.categoryId) &&
        (!filters.paidById || e.paidBy.id === filters.paidById) &&
        (!filters.participantId ||
          e.paidBy.id === filters.participantId ||
          e.paidFor.some((p) => p.participantId === filters.participantId)) &&
        (filters.isReimbursement === undefined ||
          e.isReimbursement === filters.isReimbursement) &&
        (!filters.recurrenceRule ||
          e.recurrenceRule === filters.recurrenceRule) &&
        (!filters.from || e.expenseDate.slice(0, 10) >= filters.from) &&
        (!filters.to || e.expenseDate.slice(0, 10) <= filters.to),
    )
    .sort(
      (a, b) =>
        b.snapshot.expense.expenseDate.localeCompare(
          a.snapshot.expense.expenseDate,
        ) ||
        b.snapshot.expense.createdAt.localeCompare(
          a.snapshot.expense.createdAt,
        ) ||
        b.snapshot.expense.id.localeCompare(a.snapshot.expense.id),
    )
}

export async function historicalExpense(
  groupId: string,
  expenseId: string,
  selection: HistorySelection & { revision?: number },
) {
  const boundary =
    selection.revision === undefined
      ? await historyBoundary(groupId, selection)
      : undefined
  const event = await prisma.activity.findFirst({
    where: {
      groupId,
      expenseId,
      expenseRevision:
        selection.revision === undefined ? { not: null } : selection.revision,
      ...(boundary
        ? {
            sequence: { lte: boundary.sequence },
            ...(boundary.timestampCutoff
              ? { time: { lte: boundary.timestampCutoff } }
              : {}),
          }
        : {}),
    },
    orderBy: { sequence: 'desc' },
  })
  if (!event)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No saved expense revision is available at this point',
    })
  const saved =
    event.snapshot !== null
      ? event
      : await prisma.activity.findFirst({
          where: {
            groupId,
            expenseId,
            expenseRevision: { not: null },
            sequence: { lt: event.sequence },
            snapshot: { not: Prisma.DbNull },
          },
          orderBy: { sequence: 'desc' },
        })
  if (!saved?.snapshot)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This older revision has no complete saved snapshot',
    })
  const snapshot = expenseSnapshotSchema.parse(saved.snapshot)
  return { event, snapshot, boundary }
}
