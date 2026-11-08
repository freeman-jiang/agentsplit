// CSV and JSON exports of a group's live expenses (and, in JSON, its history).
// Formats follow the current app (src/lib/export-csv.ts, src/lib/export-json.ts)
// with the DECISIONS.md changes: no user IDs, connection IDs or email
// addresses (P-EXPORT-14), rows in a defined order (P-EXPORT-29), and the group
// name in both file names (P-EXPORT-15).
import { sql } from 'drizzle-orm'
import { CURRENCIES, type CurrencyCode } from '../shared/currencies'
import { legacyDateTime, todayUtc } from '../shared/dates'
import type { FileExportFormat } from '../shared/paths'
import { formatMinor, minor, minorOf } from '../shared/minor'
import { mainPayer, weightText } from '../shared/split'
import { RECURRENCE_NAMES, SPLIT_MODE_LABELS, SPLIT_MODE_NAMES, type ActivityType } from '../shared/vocabulary'
import { memberCte, requireActive, type Principal } from './core/access'
import { activitySource, activityText, savedTitle } from './activity'
import type { Db } from './core/db'
import { expenseColumns, toExpense, type ExpenseRow } from './expense-read'
import { participantsJson } from './people'
import { iso } from './sql'

type ActivityRow = {
  id: string
  time: string
  type: ActivityType
  participantId: string | null
  expenseId: string | null
  data: string | null
  saved: { title: string; vendor: string | null } | null
  expenseRevision: number | null
  snapshot: unknown
  source: string
  actorName: string | null
}
type Head = {
  active: boolean | null
  id: string
  name: string
  slug: string | null
  information: string
  default_currency: CurrencyCode
  participants: { id: string; name: string }[]
  expenses: ExpenseRow[]
  activities: ActivityRow[] | null
}

/** The group and its live expenses in the export order: expense date, creation time, then ID, oldest first. */
async function load(db: Db, data: { principal: Principal; groupId: string; activities: boolean }) {
  const result = await db.execute<Head>(sql`
    WITH ${memberCte(data)}
    SELECT g.active, g.id, g.name, g.slug, g.information, g.default_currency,
      ${participantsJson(sql`g.id`)} AS participants,
      coalesce((SELECT json_agg(x ORDER BY x.expense_date, x.created_key, x.id) FROM (
          SELECT ${expenseColumns({ documents: true })}, e.created_at AS created_key FROM expenses e WHERE e.group_id = g.id AND e.deleted_at IS NULL) x), '[]') AS expenses,
      ${
        data.activities
          ? sql`coalesce((SELECT json_agg(json_build_object(
              'id', a.id, 'time', ${iso(sql`a.time`)}, 'type', a.type,
              'participantId', a.participant_id, 'expenseId', a.expense_id, 'data', a.data, 'saved', ${savedTitle(sql`a`)}, 'expenseRevision', a.expense_revision,
              'snapshot', a.snapshot, 'source', ${activitySource(sql`a`)}, 'actorName', a.actor_name
            ) ORDER BY a.sequence) FROM activities a WHERE a.group_id = g.id), '[]')`
          : sql`NULL`
      } AS activities
    FROM g
  `)
  const head = requireActive(result.rows[0])
  return { ...head, expenses: head.expenses.map(toExpense) }
}



// ---------- file names ----------

const exportFileName = (data: { group: string; format: FileExportFormat; date: string }) => `AgentSplit Export - ${data.group} - ${data.date}.${data.format}`

// ---------- JSON ----------

export async function exportJson(db: Db, data: { principal: Principal; groupId: string }) {
  const g = await load(db, { ...data, activities: true })
  const body = {
    id: g.id,
    name: g.name,
    slug: g.slug,
    information: g.information,
    currency: CURRENCIES[g.default_currency].symbol,
    currencyCode: g.default_currency,
    expenses: g.expenses.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      // The current app exported expense dates as UTC midnight timestamps.
      expenseDate: legacyDateTime(e.expenseDate),
      title: e.title,
      vendor: e.vendor,
      category: e.category ? { grouping: e.category.grouping, name: e.category.name } : null,
      amount: e.amount,
      currencyCode: e.currency,
      originalAmount: e.originalAmount,
      originalCurrency: e.originalCurrency,
      conversionRate: e.conversionRate,
      paidById: mainPayer(e),
      payers: e.payers.map((p) => ({ participantId: p.participantId, amount: p.amount })),
      paidFor: e.shares.map((s) => ({ participantId: s.participantId, shares: weightText({ splitMode: e.splitMode, currency: e.currency, weight: s.weight }), amount: s.amount })),
      isReimbursement: e.kind === 'payment',
      splitMode: SPLIT_MODE_NAMES[e.splitMode],
      recurrenceRule: RECURRENCE_NAMES[e.recurrence],
      notes: e.notes,
      revision: e.revision,
      documents: (e.documents ?? []).map((d) => ({ id: d.id, url: d.url, width: d.width, height: d.height })),
    })),
    participants: g.participants,
    // Snapshots exactly as stored, in either format. No actor user IDs or connection IDs.
    activities: (g.activities ?? []).map((a) => ({
      id: a.id,
      time: a.time,
      activityType: a.type.toUpperCase(),
      participantId: a.participantId,
      expenseId: a.expenseId,
      data: activityText(a),
      expenseRevision: a.expenseRevision,
      snapshot: a.snapshot,
      source: a.source,
      actorName: a.actorName,
    })),
  }
  return { groupId: g.id, filename: exportFileName({ group: g.name, format: 'json', date: todayUtc() }), contentType: 'application/json', content: JSON.stringify(body) }
}

// ---------- CSV ----------

/** Spreadsheets run a cell that starts with = + - @ tab or CR as a formula (CWE-1236); a leading ' stops that. */
const escapeFormula = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value)
/** json2csv's default: every value quoted, quotes doubled, empty for null. */
const cell = (value: string | null) => (value === null ? '' : `"${value.replace(/"/g, '""')}"`)

export async function exportCsv(db: Db, data: { principal: Principal; groupId: string }) {
  const g = await load(db, { ...data, activities: false })
  const header = [
    'Date',
    'Description',
    'Vendor',
    'Category',
    'Currency',
    'Cost',
    'Original cost',
    'Original currency',
    'Conversion rate',
    'Is Reimbursement',
    'Split mode',
    ...g.participants.map((p) => escapeFormula(p.name)),
  ]
  const rows = g.expenses.map((e) => {
    const paid = new Map(e.payers.map((p) => [p.participantId, minorOf(p.amount, e.currency)]))
    const owed = new Map(e.shares.map((s) => [s.participantId, minorOf(s.amount, e.currency)]))
    return [
      e.expenseDate,
      escapeFormula(e.title),
      escapeFormula(e.vendor ?? ''),
      escapeFormula(e.category?.name ?? ''),
      e.currency,
      e.amount,
      e.originalAmount,
      e.originalCurrency,
      e.conversionRate,
      e.kind === 'payment' ? 'Yes' : 'No',
      SPLIT_MODE_LABELS[e.splitMode],
      // Each person's net change, as the balances tab counts it: paid minus share.
      ...g.participants.map((p) => formatMinor({ amount: minor((paid.get(p.id) ?? 0n) - (owed.get(p.id) ?? 0n)), currency: e.currency })),
    ]
  })
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  return {
    groupId: g.id,
    filename: exportFileName({ group: g.name, format: 'csv', date: todayUtc() }),
    contentType: 'text/csv; charset=utf-8',
    // The byte order mark tells spreadsheets the file is UTF-8.
    content: `﻿${csv}`,
  }
}

/**
 * The file of the export.group RPC and the export_group MCP tool. Its name and
 * content type are not the ones of the download routes (export-routes.ts).
 */
export async function exportFile(db: Db, data: { principal: Principal; groupId: string; format: FileExportFormat }) {
  const file = await EXPORTS[data.format](db, { principal: data.principal, groupId: data.groupId })
  return { filename: `agentsplit-${file.groupId}.${data.format}`, contentType: RPC_CONTENT_TYPES[data.format], content: file.content }
}

/** The download of each file format. */
export const EXPORTS = { json: exportJson, csv: exportCsv } as const satisfies Record<FileExportFormat, typeof exportJson>

const RPC_CONTENT_TYPES = { json: 'application/json', csv: 'text/csv' } as const satisfies Record<FileExportFormat, string>
