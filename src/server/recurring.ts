// Recurring expenses. Each live expense of a series may hold one open link
// with the date of its next occurrence. The hourly job (app.ts
// `scheduled`) creates due occurrences; reads never write (DECISIONS.md,
// P-BAL-30 and P-RECUR-08).
import { and, eq, isNull, sql } from 'drizzle-orm'
import { expenseDocuments, groups, participants, recurringLinks } from '../../db/schema/app'
import { todayUtc } from '../shared/dates'
import { idOfBytes } from '../shared/ids'
import type { Recurrence } from '../shared/vocabulary'
import { requireMember, type Principal } from './access'
import { recordExpenseEvent } from './activity'
import { serializable, type Db } from './db'
import { isActiveSeries, loadExpenses } from './expense-read'
import { randomId } from './ids'
import { textList } from './sql'

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/**
 * The date after `from` in a series. A monthly series keeps its anchor day
 * where the month has it, and the month's last day otherwise, so Jan 31 gives
 * Feb 28 and then Mar 31 (P-RECUR-07).
 */
export function nextDate(data: { from: string; rule: Exclude<Recurrence, 'none'>; anchorDay: number }): string {
  const [year = 0, month = 1, day = 1] = data.from.split('-').map(Number)
  const date =
    data.rule === 'monthly'
      ? new Date(Date.UTC(year, month, Math.min(data.anchorDay, daysIn(year, month))))
      : new Date(Date.UTC(year, month - 1, day + (data.rule === 'daily' ? 1 : 7)))
  return todayUtc(date)
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
  data: { groupId: string; expenseId: string; rule: Recurrence; expenseDate: string; previous: { rule: Recurrence; expenseDate: string } | null; link: LinkState | null },
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
export async function occurrenceId(linkId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agentsplit-recurrence:${linkId}`)))
  return idOfBytes(digest.slice(0, 21))
}

type DueLink = { id: string; group_id: string; current_frame_expense_id: string; next_expense_date: string; anchor_day: number }

/** The next due link, if any, locked for this transaction. Links in `skip` failed earlier in this run. */
async function nextDueLink(tx: Db, data: { today: string; groupId?: string | undefined; skip: ReadonlySet<string> }) {
  const due = await tx.execute<DueLink>(sql`
    SELECT l.id, l.group_id, l.current_frame_expense_id, l.next_expense_date::text AS next_expense_date, l.anchor_day
    FROM recurring_links l
    WHERE l.next_expense_created_at IS NULL AND l.next_expense_date <= ${data.today}::date
      ${data.groupId ? sql`AND l.group_id = ${data.groupId}` : sql``}
      ${data.skip.size ? sql`AND l.id NOT IN (${textList([...data.skip])})` : sql``}
    ORDER BY l.next_expense_date, l.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `)
  return due.rows[0] ?? null
}

/**
 * Creates the occurrence that `link` is due for and opens the next link. The
 * link row is locked and closed in the same transaction, so a rerun or a
 * concurrent run never creates the same occurrence twice. Returns null when
 * the series ended without its link being removed (legacy data): the link is
 * dropped then.
 */
async function materialize(tx: Db, data: { link: DueLink; principal: Principal | null }): Promise<string | null> {
  const { link } = data
  const [frame] = await loadExpenses(tx, { ids: [link.current_frame_expense_id], parts: { documents: true } })
  if (!frame || frame.deleted || frame.recurrence === 'none') {
    await tx.delete(recurringLinks).where(eq(recurringLinks.id, link.id))
    return null
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
  const documents = frame.documents ?? []
  if (documents.length)
    await tx.insert(expenseDocuments).values(documents.map((d, position) => ({ id: randomId(), expenseId: id, url: d.url, width: d.width, height: d.height, position })))
  await tx.update(recurringLinks).set({ nextExpenseCreatedAt: new Date() }).where(eq(recurringLinks.id, link.id))
  await tx.insert(recurringLinks).values({
    id: randomId(),
    groupId: link.group_id,
    currentFrameExpenseId: id,
    nextExpenseDate: nextDate({ from: date, rule: frame.recurrence, anchorDay: link.anchor_day }),
    anchorDay: link.anchor_day,
  })
  const [stored] = await loadExpenses(tx, { ids: [id], parts: { documents: true } })
  const [group] = await tx.select().from(groups).where(eq(groups.id, link.group_id))
  if (!stored || !group) throw new Error(`Recurring occurrence ${id} was not stored`)
  const people = await tx.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.groupId, link.group_id))
  // Without a user it shows as the system actor (P-RECUR-17).
  await recordExpenseEvent(tx, {
    type: 'create_expense',
    expense: stored,
    revision: 1,
    principal: data.principal,
    snapshot: { group, names: new Map(people.map((p) => [p.id, p.name])) },
  })
  return id
}

/** The scheduled job's bound per run; the next run continues where this one stopped. */
export const MAX_OCCURRENCES_PER_RUN = 50

/**
 * Creates due occurrences one by one, each opening the next link, so missed
 * periods are caught up (P-RECUR-09). `step` runs one occurrence in a
 * transaction. With `onError`, a link that fails is reported, skipped for
 * the rest of the run, and the run goes on with the other links (P-RECUR-24);
 * without it, the first failure fails the call.
 */
async function createDue(data: {
  today: string
  groupId?: string
  principal: Principal | null
  step: <A>(work: (tx: Db) => Promise<A>) => Promise<A>
  onError?: (error: unknown, linkId: string) => void
}): Promise<string[]> {
  const created: string[] = []
  const skip = new Set<string>()
  while (created.length < MAX_OCCURRENCES_PER_RUN) {
    const attempt: { linkId: string | null } = { linkId: null }
    let step: { done: true } | { done: false; id: string | null }
    try {
      step = await data.step(async (tx) => {
        const link = await nextDueLink(tx, { today: data.today, groupId: data.groupId, skip })
        if (!link) return { done: true as const }
        attempt.linkId = link.id
        return { done: false as const, id: await materialize(tx, { link, principal: data.principal }) }
      })
    } catch (error) {
      if (!data.onError || attempt.linkId === null) throw error
      data.onError(error, attempt.linkId)
      skip.add(attempt.linkId)
      continue
    }
    if (step.done) break
    if (step.id) created.push(step.id)
  }
  return created
}

/**
 * The hourly job: every due occurrence, each in its own SERIALIZABLE
 * transaction; `groupId` limits it to one group. A failing link goes to
 * `onError` and is skipped; the next run tries it again.
 */
export const materializeDue = (db: Db, data: { today: string; groupId?: string; onError: (error: unknown, linkId: string) => void }) =>
  createDue({ ...data, principal: null, step: (work) => serializable(db, work) })

/**
 * A member's explicit request to create the due occurrences of one group
 * (P-RECUR-12), in the caller's write transaction, so they commit together.
 */
export async function processGroup(tx: Db, data: { principal: Principal; groupId: string; today: string }) {
  const { groupId } = await requireMember(tx, data)
  return { createdExpenseIds: await createDue({ today: data.today, groupId, principal: data.principal, step: (work) => work(tx) }) }
}

/** Active series in a group: expenses with an open link, largest first (P-RECUR-25). */
export async function listRecurring(db: Db, data: { principal: Principal; groupId: string }) {
  const { groupId } = await requireMember(db, data)
  const rows = await db.execute<{ id: string }>(sql`
    SELECT e.id
    FROM recurring_links l JOIN expenses e ON e.id = l.current_frame_expense_id
    WHERE l.group_id = ${groupId} AND l.next_expense_created_at IS NULL AND e.deleted_at IS NULL
    ORDER BY e.amount DESC, e.id
  `)
  const expenses = await loadExpenses(db, { ids: rows.rows.map((r) => r.id) })
  return expenses.filter(isActiveSeries).map((expense) => ({ expense, nextDate: expense.link?.nextExpenseDate ?? '' }))
}
