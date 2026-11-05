// Recurring expenses. Each live expense of a series may hold one open link
// with the date of its next occurrence. The hourly job (app.ts
// `scheduled`) creates due occurrences; reads never write (DECISIONS.md,
// P-BAL-30 and P-RECUR-08).
import { and, eq, isNull, sql } from 'drizzle-orm'
import { activities, expenseDocuments, groups, participants, recurringLinks } from '../../db/schema/app'
import { titleWithVendor } from '../shared/history'
import type { Db } from './db'
import { randomId } from './ids'
import { actor, expenseDocumentsOf, loadExpenses, requireMember, snapshot, type Principal } from './ledger'

export type Rule = 'none' | 'daily' | 'weekly' | 'monthly'

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/**
 * The date after `from` in a series. A monthly series keeps its anchor day
 * where the month has it, and the month's last day otherwise, so Jan 31 gives
 * Feb 28 and then Mar 31 (P-RECUR-07).
 */
export function nextDate(data: { from: string; rule: Exclude<Rule, 'none'>; anchorDay: number }): string {
  const [year = 0, month = 1, day = 1] = data.from.split('-').map(Number)
  const date =
    data.rule === 'monthly'
      ? new Date(Date.UTC(year, month, Math.min(data.anchorDay, daysIn(year, month))))
      : new Date(Date.UTC(year, month - 1, day + (data.rule === 'daily' ? 1 : 7)))
  return date.toISOString().slice(0, 10)
}

const dayOf = (date: string) => Number(date.slice(8, 10))

/** The recurring link of an expense, as the expense write context (ledger.ts) reads it. */
export type LinkState = { readonly id: string; readonly actedOn: boolean }

/**
 * Keeps an expense's open link in step with its rule and date. Called in the
 * same transaction as the expense write, with the link that the write read
 * before it changed anything. An older occurrence (its link already acted on)
 * never restarts the series (P-RECUR-23).
 */
export async function syncRecurrence(
  tx: Db,
  data: { groupId: string; expenseId: string; rule: Rule; expenseDate: string; previous: { rule: Rule; expenseDate: string } | null; link: LinkState | null },
) {
  const { link } = data
  if (link?.actedOn) return
  if (data.rule === 'none') {
    if (link) await tx.delete(recurringLinks).where(eq(recurringLinks.id, link.id))
    return
  }
  const next = { nextExpenseDate: nextDate({ from: data.expenseDate, rule: data.rule, anchorDay: dayOf(data.expenseDate) }), anchorDay: dayOf(data.expenseDate) }
  if (!link) {
    await tx.insert(recurringLinks).values({ id: randomId(), groupId: data.groupId, currentFrameExpenseId: data.expenseId, ...next })
    return
  }
  // A new rule or date counts from the date being saved, not the old one (P-RECUR-20).
  if (data.previous && (data.previous.rule !== data.rule || data.previous.expenseDate !== data.expenseDate))
    await tx.update(recurringLinks).set(next).where(eq(recurringLinks.id, link.id))
}

/** Deleting the newest occurrence stops the series (P-RECUR-19). */
export async function stopRecurrence(tx: Db, data: { expenseId: string }) {
  await tx.delete(recurringLinks).where(and(eq(recurringLinks.currentFrameExpenseId, data.expenseId), isNull(recurringLinks.nextExpenseCreatedAt)))
}

/**
 * The ID of the occurrence a link creates. It depends only on the link, so a
 * second run that somehow reaches the same link fails on the primary key
 * instead of creating a duplicate.
 */
async function occurrenceId(linkId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agentsplit-recurrence:${linkId}`)))
  const alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
  return [...digest.slice(0, 21)].map((b) => alphabet[b & 63]).join('')
}

type DueLink = { id: string; group_id: string; current_frame_expense_id: string; next_expense_date: string; anchor_day: number }

/**
 * Creates the next due occurrence, if any, and returns its ID. Run it in its
 * own SERIALIZABLE transaction and repeat until it returns null: each
 * occurrence opens the next link, so missed periods are caught up one by one
 * (P-RECUR-09). The link row is locked and closed in the same transaction, so a
 * rerun or a concurrent run never creates the same occurrence twice.
 */
export async function materializeNext(tx: Db, data: { today: string; groupId?: string; principal?: Principal }): Promise<string | null> {
  const due = await tx.execute<DueLink>(sql`
    SELECT l.id, l.group_id, l.current_frame_expense_id, l.next_expense_date::text AS next_expense_date, l.anchor_day
    FROM recurring_links l
    WHERE l.next_expense_created_at IS NULL AND l.next_expense_date <= ${data.today}::date
      ${data.groupId ? sql`AND l.group_id = ${data.groupId}` : sql``}
    ORDER BY l.next_expense_date, l.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `)
  const [link] = due.rows
  if (!link) return null
  const [frame] = await loadExpenses(tx, [link.current_frame_expense_id])
  const [live] = frame
    ? await tx.execute<{ deleted: boolean }>(sql`SELECT deleted_at IS NOT NULL AS deleted FROM expenses WHERE id = ${frame.id}`).then((r) => r.rows)
    : []
  if (!frame || !live || live.deleted || frame.recurrence === 'none') {
    // The series ended without its link being removed (legacy data): drop the link.
    await tx.delete(recurringLinks).where(eq(recurringLinks.id, link.id))
    return materializeNext(tx, data)
  }
  const id = await occurrenceId(link.id)
  const date = link.next_expense_date
  // The copy keeps every stored part exactly, so its sums hold as the frame's do (P-RECUR-15).
  await tx.execute(sql`
    INSERT INTO expenses (id, group_id, revision, kind, title, vendor, notes, category_id, expense_date, currency, amount, split_mode, recurrence)
    SELECT ${id}, group_id, 1, kind, title, vendor, notes, category_id, ${date}::date, currency, amount, split_mode, recurrence FROM expenses WHERE id = ${frame.id}
  `)
  await tx.execute(sql`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount, weight)
    SELECT ${id}, group_id, participant_id, amount, weight FROM expense_payers WHERE expense_id = ${frame.id}`)
  await tx.execute(sql`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount, weight)
    SELECT ${id}, group_id, participant_id, amount, weight FROM expense_shares WHERE expense_id = ${frame.id}`)
  // Receipt pointers are copied as new rows; the frame keeps its own (P-RECUR-16).
  const documents = await expenseDocumentsOf(tx, frame.id)
  if (documents.length) await tx.insert(expenseDocuments).values(documents.map((d, position) => ({ ...d, id: randomId(), expenseId: id, position })))
  await tx.update(recurringLinks).set({ nextExpenseCreatedAt: new Date() }).where(eq(recurringLinks.id, link.id))
  const rule = frame.recurrence
  await tx.insert(recurringLinks).values({
    id: randomId(),
    groupId: link.group_id,
    currentFrameExpenseId: id,
    nextExpenseDate: nextDate({ from: date, rule, anchorDay: link.anchor_day }),
    anchorDay: link.anchor_day,
  })
  const [stored] = await loadExpenses(tx, [id])
  const [group] = await tx.select().from(groups).where(eq(groups.id, link.group_id))
  if (!stored || !group) throw new Error(`Recurring occurrence ${id} was not stored`)
  const people = await tx.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.groupId, link.group_id))
  await tx.insert(activities).values({
    id: randomId(),
    groupId: link.group_id,
    type: 'create_expense',
    expenseId: id,
    expenseRevision: 1,
    data: titleWithVendor(stored),
    snapshot: snapshot({ group, expense: stored, names: new Map(people.map((p) => [p.id, p.name])), documents: await expenseDocumentsOf(tx, id) }),
    // Without a user it shows as "Automatic recurrence" (P-RECUR-17).
    ...(data.principal ? actor(data.principal) : { source: 'system', actorName: null, actorUserId: null, agentKeyId: null }),
  })
  return id
}

/** The scheduled job's bound per run; the next run continues where this one stopped. */
export const MAX_OCCURRENCES_PER_RUN = 50

/**
 * Creates every due occurrence, one transaction each. A failed occurrence is
 * logged and skipped by the scheduled job (P-RECUR-24); `transaction` must
 * open a SERIALIZABLE transaction.
 */
export async function materializeDue(data: {
  today: string
  groupId?: string
  principal?: Principal
  transaction: <A>(work: (tx: Db) => Promise<A>) => Promise<A>
  onError?: (error: unknown) => void
}): Promise<string[]> {
  const created: string[] = []
  while (created.length < MAX_OCCURRENCES_PER_RUN) {
    let id: string | null
    try {
      id = await data.transaction((tx) =>
        materializeNext(tx, { today: data.today, ...(data.groupId ? { groupId: data.groupId } : {}), ...(data.principal ? { principal: data.principal } : {}) }),
      )
    } catch (error) {
      if (!data.onError) throw error
      data.onError(error)
      break
    }
    if (!id) break
    created.push(id)
  }
  return created
}

/** A member's explicit request to create the due occurrences of one group (P-RECUR-12). */
export async function processGroup(
  db: Db,
  data: { principal: Principal; group: string; today: string; transaction: <A>(work: (tx: Db) => Promise<A>) => Promise<A> },
) {
  const { groupId } = await requireMember(db, data)
  return { createdExpenseIds: await materializeDue({ today: data.today, groupId, principal: data.principal, transaction: data.transaction }) }
}

/** Active series in a group: expenses with an open link, largest first (P-RECUR-25). */
export async function listRecurring(db: Db, data: { principal: Principal; group: string }) {
  const { groupId } = await requireMember(db, data)
  const rows = await db.execute<{ id: string; next: string }>(sql`
    SELECT e.id, l.next_expense_date::text AS next
    FROM recurring_links l JOIN expenses e ON e.id = l.current_frame_expense_id
    WHERE l.group_id = ${groupId} AND l.next_expense_created_at IS NULL AND e.deleted_at IS NULL AND e.kind = 'expense'
    ORDER BY e.amount DESC, e.id
  `)
  const expenses = await loadExpenses(db, rows.rows.map((r) => r.id))
  const next = new Map(rows.rows.map((r) => [r.id, r.next]))
  return expenses.map((expense) => ({ expense, nextDate: next.get(expense.id) ?? '' }))
}
