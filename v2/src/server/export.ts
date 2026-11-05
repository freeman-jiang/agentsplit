// CSV and JSON exports of a group's live expenses (and, in JSON, its history).
// Formats follow the current app (src/lib/export-csv.ts, src/lib/export-json.ts)
// with the DECISIONS.md changes: no user IDs, connection IDs or email
// addresses (P-EXPORT-14), rows in a defined order (P-EXPORT-29), and the group
// name in both file names (P-EXPORT-15).
import { sql } from 'drizzle-orm'
import { Forbidden } from '../shared/api'
import { CURRENCIES, type CurrencyCode } from '../shared/currencies'
import { formatMinor, minor } from '../shared/money'
import { preferredPayer, type SplitMode } from '../shared/split'
import type { Db } from './db'
import { publicData, type ActivityType } from './history'
import type { Principal } from './ledger'

type ExpenseRow = {
  id: string
  createdAt: string
  expenseDate: string
  title: string
  vendor: string | null
  grouping: string
  categoryName: string
  kind: 'expense' | 'payment'
  currency: CurrencyCode
  amount: string
  originalAmount: string | null
  originalCurrency: string | null
  conversionRate: string | null
  splitMode: SplitMode
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
  notes: string
  revision: number
  payers: { participantId: string; amount: string }[] | null
  shares: { participantId: string; amount: string; weight: string }[] | null
  documents: { id: string; url: string; width: number; height: number }[] | null
}
type ActivityRow = {
  id: string
  time: string
  type: ActivityType
  participantId: string | null
  expenseId: string | null
  data: string | null
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
async function load(db: Db, data: { principal: Principal; group: string; activities: boolean }) {
  const result = await db.execute<Head>(sql`
    WITH g AS (
      SELECT g.*, m.active FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
      WHERE g.id = ${data.group} OR g.slug = ${data.group}
      LIMIT 1
    )
    SELECT g.active, g.id, g.name, g.slug, g.information, g.default_currency,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id) FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
      coalesce((SELECT json_agg(json_build_object(
          'id', e.id, 'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'expenseDate', e.expense_date::text,
          'title', e.title, 'vendor', e.vendor, 'grouping', c.grouping, 'categoryName', c.name, 'kind', e.kind,
          'currency', e.currency, 'amount', e.amount::text, 'originalAmount', e.original_amount::text,
          'originalCurrency', e.original_currency, 'conversionRate', e.conversion_rate, 'splitMode', e.split_mode,
          'recurrence', e.recurrence, 'notes', e.notes, 'revision', e.revision,
          'payers', (SELECT json_agg(json_build_object('participantId', x.participant_id, 'amount', x.amount::text) ORDER BY x.participant_id) FROM expense_payers x WHERE x.expense_id = e.id),
          'shares', (SELECT json_agg(json_build_object('participantId', x.participant_id, 'amount', x.amount::text, 'weight', x.weight) ORDER BY x.participant_id) FROM expense_shares x WHERE x.expense_id = e.id),
          'documents', (SELECT json_agg(json_build_object('id', d.id, 'url', d.url, 'width', d.width, 'height', d.height) ORDER BY d.id) FROM expense_documents d WHERE d.expense_id = e.id)
        ) ORDER BY e.expense_date, e.created_at, e.id)
        FROM expenses e JOIN categories c ON c.id = e.category_id
        WHERE e.group_id = g.id AND e.deleted_at IS NULL), '[]') AS expenses,
      ${
        data.activities
          ? sql`coalesce((SELECT json_agg(json_build_object(
              'id', a.id, 'time', to_char(a.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'type', a.type,
              'participantId', a.participant_id, 'expenseId', a.expense_id, 'data', a.data, 'expenseRevision', a.expense_revision,
              'snapshot', a.snapshot, 'source', a.source, 'actorName', a.actor_name
            ) ORDER BY a.sequence) FROM activities a WHERE a.group_id = g.id), '[]')`
          : sql`NULL`
      } AS activities
    FROM g
  `)
  const head = result.rows[0]
  if (!head?.active) throw new Forbidden({ message: 'Group access denied' })
  return head
}

const money = (amount: string, currency: CurrencyCode) => formatMinor({ amount: minor(BigInt(amount)), currency })

/** The split input in the current app's units: amount-split weights are major units there, minor units here. */
const weightText = (e: ExpenseRow, weight: string) => (e.splitMode === 'amount' ? money(weight, e.currency) : weight)

const V1_SPLIT: Record<SplitMode, string> = { evenly: 'EVENLY', shares: 'BY_SHARES', percentage: 'BY_PERCENTAGE', amount: 'BY_AMOUNT' }
const V1_RECURRENCE = { none: 'NONE', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const
const SPLIT_LABEL: Record<SplitMode, string> = {
  evenly: 'Evenly',
  shares: 'Unevenly – By shares',
  percentage: 'Unevenly – By percentage',
  amount: 'Unevenly – By amount',
}

// ---------- file names ----------

/** RFC 6266 Content-Disposition, as the `content-disposition` package writes it. */
export function contentDisposition(name: string): string {
  // A path separator in a group name would make some clients drop the part before it.
  const safe = name.replace(/[/\\]/g, '_')
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_')
  const quoted = `"${fallback.replace(/([\\"])/g, '\\$1')}"`
  if (fallback === safe) return `attachment; filename=${quoted}`
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename=${quoted}; filename*=UTF-8''${encoded}`
}

const today = () => new Date().toISOString().slice(0, 10)
export const exportFileName = (data: { group: string; format: 'csv' | 'json'; date: string }) => `AgentSplit Export - ${data.group} - ${data.date}.${data.format}`

// ---------- JSON ----------

export async function exportJson(db: Db, data: { principal: Principal; group: string }) {
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
      expenseDate: `${e.expenseDate}T00:00:00.000Z`,
      title: e.title,
      vendor: e.vendor,
      category: { grouping: e.grouping, name: e.categoryName },
      amount: money(e.amount, e.currency),
      currencyCode: e.currency,
      originalAmount: e.originalAmount === null || e.originalCurrency === null ? null : money(e.originalAmount, e.originalCurrency as CurrencyCode),
      originalCurrency: e.originalCurrency,
      conversionRate: e.conversionRate,
      // The payer of the whole amount; with several payers, the one who paid most.
      paidById: e.payers?.length ? preferredPayer(e.payers.map((p) => ({ participantId: p.participantId, amount: minor(BigInt(p.amount)) }))) : null,
      payers: (e.payers ?? []).map((p) => ({ participantId: p.participantId, amount: money(p.amount, e.currency) })),
      paidFor: (e.shares ?? []).map((s) => ({ participantId: s.participantId, shares: weightText(e, s.weight), amount: money(s.amount, e.currency) })),
      isReimbursement: e.kind === 'payment',
      splitMode: V1_SPLIT[e.splitMode],
      recurrenceRule: V1_RECURRENCE[e.recurrence],
      notes: e.notes,
      revision: e.revision,
      documents: e.documents ?? [],
    })),
    participants: g.participants,
    // Snapshots exactly as stored, in either format. No actor user IDs or connection IDs.
    activities: (g.activities ?? []).map((a) => ({
      id: a.id,
      time: a.time,
      activityType: a.type.toUpperCase(),
      participantId: a.participantId,
      expenseId: a.expenseId,
      data: publicData(a),
      expenseRevision: a.expenseRevision,
      snapshot: a.snapshot,
      source: a.source,
      actorName: a.actorName,
    })),
  }
  return { groupId: g.id, filename: exportFileName({ group: g.name, format: 'json', date: today() }), contentType: 'application/json', content: JSON.stringify(body) }
}

// ---------- CSV ----------

/** Spreadsheets run a cell that starts with = + - @ tab or CR as a formula (CWE-1236); a leading ' stops that. */
export const escapeFormula = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value)
/** json2csv's default: every value quoted, quotes doubled, empty for null. */
const cell = (value: string | null) => (value === null ? '' : `"${value.replace(/"/g, '""')}"`)

export async function exportCsv(db: Db, data: { principal: Principal; group: string }) {
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
    const paid = new Map((e.payers ?? []).map((p) => [p.participantId, BigInt(p.amount)]))
    const owed = new Map((e.shares ?? []).map((s) => [s.participantId, BigInt(s.amount)]))
    return [
      e.expenseDate,
      escapeFormula(e.title),
      escapeFormula(e.vendor ?? ''),
      escapeFormula(e.categoryName),
      e.currency,
      money(e.amount, e.currency),
      e.originalAmount === null || e.originalCurrency === null ? null : money(e.originalAmount, e.originalCurrency as CurrencyCode),
      e.originalCurrency,
      e.conversionRate,
      e.kind === 'payment' ? 'Yes' : 'No',
      SPLIT_LABEL[e.splitMode],
      // Each person's net change, as the balances tab counts it: paid minus share.
      ...g.participants.map((p) => formatMinor({ amount: minor((paid.get(p.id) ?? 0n) - (owed.get(p.id) ?? 0n)), currency: e.currency })),
    ]
  })
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  return {
    groupId: g.id,
    filename: exportFileName({ group: g.name, format: 'csv', date: today() }),
    contentType: 'text/csv; charset=utf-8',
    // The byte order mark tells spreadsheets the file is UTF-8.
    content: `﻿${csv}`,
  }
}

/** The HTTP response of an export route. */
export function exportResponse(file: { filename: string; contentType: string; content: string }) {
  return new Response(file.content, {
    headers: { 'Cache-Control': 'private, no-store', 'Content-Type': file.contentType, 'Content-Disposition': contentDisposition(file.filename) },
  })
}
