// Verifies an import: row counts, IDs, and every group's balance per currency
// to the cent, computed by the current app's own code on the source rows and by
// v2 from the imported tables.
//
//   TZ=UTC SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... bun test/legacy/verify-import.ts
import pg from 'pg'
import { getCurrency } from '../../../src/lib/currency'
import { getExpenseShares } from '../../../src/lib/shares'
import { computeBalances, type LedgerEntry } from '../../src/shared/balances'
import type { CurrencyCode } from '../../src/shared/currencies'
import { formatMinor, minor, type Minor } from '../../src/shared/money'

if (process.env['TZ'] !== 'UTC') throw new Error('Run with TZ=UTC')
const source = new pg.Pool({ connectionString: process.env['SOURCE_DATABASE_URL'], max: 1 })
const target = new pg.Pool({ connectionString: process.env['TARGET_DATABASE_URL'], max: 1 })
const problems: string[] = []
const q = async (pool: pg.Pool, sql: string) => (await pool.query(sql)).rows

// 1. Row counts and IDs.
const PAIRS: [string, string, string][] = [
  ['User', 'user', 'id'],
  ['Session', 'session', 'id'],
  ['Account', 'account', 'id'],
  ['Jwks', 'jwks', 'id'],
  ['OauthClient', 'oauth_client', 'id'],
  ['OauthRefreshToken', 'oauth_refresh_token', 'id'],
  ['OauthConsent', 'oauth_consent', 'id'],
  ['Apikey', 'apikey', 'id'],
  ['OauthConnection', 'oauth_connections', 'id'],
  ['Group', 'groups', 'id'],
  ['Participant', 'participants', 'id'],
  ['UserGroupAccess', 'memberships', `"userId" || '/' || "groupId"`],
  ['GroupInvitation', 'invitations', 'id'],
  ['Expense', 'expenses', 'id'],
  ['Activity', 'activities', 'id'],
  ['ReceiptObject', 'receipts', 'id'],
  ['ExpenseDocument', 'expense_documents', 'id'],
]
for (const [from, to, key] of PAIRS) {
  const a = new Set((await q(source, `SELECT ${key} AS k FROM "${from}"`)).map((r) => r.k))
  const targetKey = key.replace('"userId"', 'user_id').replace('"groupId"', 'group_id')
  const b = new Set((await q(target, `SELECT ${targetKey} AS k FROM "${to}"`)).map((r) => r.k))
  const missing = [...a].filter((k) => !b.has(k))
  const extra = [...b].filter((k) => !a.has(k))
  if (missing.length || extra.length) problems.push(`${from} → ${to}: ${missing.length} missing, ${extra.length} extra`)
  else console.log(`ok  ${from} → ${to}: ${a.size} rows, same IDs`)
}

// 2. Balances per group and currency, to the cent.
const oldExpenses = await q(source, `SELECT * FROM "Expense" WHERE "deletedAt" IS NULL`)
const oldPaidFor = Map.groupBy(await q(source, `SELECT * FROM "ExpensePaidFor"`), (r) => r.expenseId as string)
const oldBalances = new Map<string, Map<string, bigint>>() // "group|currency" → participant → net cents
const toUnits = (text: string, currency: string) => {
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.')
  const digits = getCurrency(currency).decimal_digits
  const units = BigInt(whole + fraction.padEnd(digits, '0').slice(0, digits))
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) throw new Error(`Sub-unit value ${text}`)
  return text.startsWith('-') ? -units : units
}
for (const e of oldExpenses) {
  const key = `${e.groupId}|${e.currencyCode}`
  const nets = oldBalances.get(key) ?? new Map<string, bigint>()
  oldBalances.set(key, nets)
  const amount = String(e.amount).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  nets.set(e.paidById, (nets.get(e.paidById) ?? 0n) + toUnits(amount, e.currencyCode))
  const shares = getExpenseShares({
    amount,
    currencyCode: e.currencyCode,
    paidById: e.paidById,
    splitMode: e.splitMode,
    paidFor: (oldPaidFor.get(e.id) ?? []).map((r) => ({ participantId: r.participantId, shares: String(r.shares) })),
  })
  for (const [id, share] of shares) nets.set(id, (nets.get(id) ?? 0n) - toUnits(share, e.currencyCode))
}

const entries = new Map<string, LedgerEntry[]>()
const payers = Map.groupBy(await q(target, `SELECT * FROM expense_payers`), (r) => r.expense_id as string)
const shares = Map.groupBy(await q(target, `SELECT * FROM expense_shares`), (r) => r.expense_id as string)
for (const e of await q(target, `SELECT * FROM expenses WHERE deleted_at IS NULL`)) {
  const list = entries.get(e.group_id) ?? []
  entries.set(e.group_id, list)
  const parts = (rows: pg.QueryResultRow[] | undefined) => new Map<string, Minor>((rows ?? []).map((r) => [r.participant_id, minor(BigInt(r.amount))]))
  list.push({ currency: e.currency as CurrencyCode, payers: parts(payers.get(e.id)), shares: parts(shares.get(e.id)) })
}
let compared = 0
for (const [groupId, list] of entries) {
  for (const [currency, balances] of computeBalances(list)) {
    const expected = oldBalances.get(`${groupId}|${currency}`) ?? new Map<string, bigint>()
    for (const id of new Set([...expected.keys(), ...balances.keys()])) {
      const want = expected.get(id) ?? 0n
      const got = balances.get(id)?.net ?? 0n
      compared++
      if (want !== got)
        problems.push(`balance ${groupId} ${currency} ${id}: current app ${formatMinor({ amount: minor(want), currency })}, v2 ${formatMinor({ amount: minor(got), currency })}`)
    }
  }
}
for (const key of oldBalances.keys()) if (!entries.has(key.split('|')[0] ?? '')) problems.push(`balances for ${key} missing in v2`)
console.log(`ok  ${compared} participant balances compared across ${entries.size} groups`)

// 3. Every expense, deleted ones included, field by field and share by share.
const allOld = await q(source, `SELECT *, "expenseDate"::text AS date_text FROM "Expense"`)
const allNew = new Map((await q(target, `SELECT *, expense_date::text AS date_text FROM expenses`)).map((r) => [r.id, r]))
for (const e of allOld) {
  const n = allNew.get(e.id)
  if (!n) continue // already reported as missing
  const amount = String(e.amount).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const same = (field: string, a: unknown, b: unknown) => {
    if (String(a ?? '') !== String(b ?? '')) problems.push(`expense ${e.id} ${field}: current ${JSON.stringify(a)}, v2 ${JSON.stringify(b)}`)
  }
  same('title', e.title, n.title)
  same('vendor', e.vendor, n.vendor)
  same('notes', e.notes ?? '', n.notes)
  same('date', e.date_text, n.date_text)
  same('currency', e.currencyCode, n.currency)
  same('amount', toUnits(amount, e.currencyCode), n.amount)
  same('revision', e.revision, n.revision)
  same('deleted', e.deletedAt?.toISOString(), n.deleted_at?.toISOString())
  same('created', e.createdAt.toISOString(), n.created_at.toISOString())
  same('kind', e.isReimbursement ? 'payment' : 'expense', n.kind)
  same('category', e.categoryId, n.category_id)
  const newPayers = payers.get(e.id) ?? []
  same('payer', e.paidById, newPayers.length === 1 ? newPayers[0]?.participant_id : `${newPayers.length} payers`)
  const oldShares = getExpenseShares({
    amount,
    currencyCode: e.currencyCode,
    paidById: e.paidById,
    splitMode: e.splitMode,
    paidFor: (oldPaidFor.get(e.id) ?? []).map((r) => ({ participantId: r.participantId, shares: String(r.shares) })),
  })
  const newShares = new Map((shares.get(e.id) ?? []).map((r) => [r.participant_id as string, BigInt(r.amount)]))
  for (const id of new Set([...oldShares.keys(), ...newShares.keys()]))
    same(`share ${id}`, toUnits(oldShares.get(id) ?? '0', e.currencyCode), newShares.get(id) ?? 0n)
}
console.log(`ok  ${allOld.length} expenses compared field by field and share by share`)

await source.end()
await target.end()
if (problems.length) {
  console.error(`FAILED with ${problems.length} problems:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('Import verified')
