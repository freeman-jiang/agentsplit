// Imports the current app's database into an empty, migrated v2 database.
//
//   TZ=UTC SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... bun scripts/import-legacy.ts
//
// The source is read in one REPEATABLE READ, READ ONLY transaction, so the copy
// is one consistent snapshot. The target is written in one transaction: either
// everything imports, or nothing does. Any value that does not convert exactly
// (an amount with more decimals than its currency, an unknown currency, an
// unbalanced split) stops the import with the row ID.
import { Result } from 'effect'
import { toSnakeCase } from 'drizzle-orm/casing'
import pg from 'pg'
import { CURRENCIES, type CurrencyCode } from '../src/shared/currencies'
import { minor, parseMinor, sumMinor, type Minor } from '../src/shared/money'
import { resolveShares, type SplitMode } from '../src/shared/split'

if (process.env['TZ'] !== 'UTC') throw new Error('Run with TZ=UTC: the source stores UTC times without a time zone')
// Expense dates stay calendar dates: never let pg turn a DATE into a local Date.
pg.types.setTypeParser(1082, (value: string) => value)

const sourceUrl = process.env['SOURCE_DATABASE_URL']
const targetUrl = process.env['TARGET_DATABASE_URL']
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL')

type Row = Record<string, unknown>
const snake = toSnakeCase
const str = (v: unknown) => {
  if (typeof v !== 'string') throw new Error(`Expected text, got ${JSON.stringify(v)}`)
  return v
}

class ImportError extends Error {}
const fail = (message: string): never => {
  throw new ImportError(message)
}

function currencyOf(code: unknown, where: string): CurrencyCode {
  if (typeof code === 'string' && code in CURRENCIES) return code as CurrencyCode
  return fail(`${where}: unsupported currency ${JSON.stringify(code)}`)
}

function toMinor(amount: unknown, currency: CurrencyCode, where: string): Minor {
  const text = str(amount).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const parsed = parseMinor({ amount: text, currency })
  return Result.isSuccess(parsed) ? parsed.success : fail(`${where}: ${amount} has more decimals than ${currency} allows`)
}

const decimalText = (value: unknown) => str(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

const SPLIT_MODE: Record<string, SplitMode> = { EVENLY: 'evenly', BY_SHARES: 'shares', BY_PERCENTAGE: 'percentage', BY_AMOUNT: 'amount' }
const RECURRENCE: Record<string, string> = { NONE: 'none', DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }

/** Better Auth tables: same fields, so rows copy unchanged (camelCase → snake_case columns). */
const AUTH_TABLES: [string, string][] = [
  ['User', 'user'],
  ['Session', 'session'],
  ['Account', 'account'],
  ['Verification', 'verification'],
  ['Jwks', 'jwks'],
  ['OauthClient', 'oauth_client'],
  ['OauthResource', 'oauth_resource'],
  ['OauthClientResource', 'oauth_client_resource'],
  ['OauthRefreshToken', 'oauth_refresh_token'],
  ['OauthAccessToken', 'oauth_access_token'],
  ['OauthConsent', 'oauth_consent'],
  ['OauthClientAssertion', 'oauth_client_assertion'],
  ['Apikey', 'apikey'],
  ['RateLimit', 'rate_limit'],
  ['OauthConnection', 'oauth_connections'],
  ['AuthBootstrap', 'auth_bootstrap'],
  ['LegacyGroupClaim', 'legacy_group_claims'],
]

async function insertAll(client: pg.PoolClient, table: string, rows: Row[]) {
  for (const row of rows) {
    const keys = Object.keys(row)
    await client.query(
      `INSERT INTO "${table}" (${keys.map((k) => `"${snake(k)}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => row[k]),
    )
  }
}

export type ImportReport = Record<string, number>

export async function importLegacy(data: { source: pg.PoolClient; target: pg.PoolClient }): Promise<ImportReport> {
  const { source, target } = data
  const report: ImportReport = {}
  const read = async (sql: string) => (await source.query<Row>(sql)).rows
  const copy = async (from: string, to: string, rows?: Row[]) => {
    const list = rows ?? (await read(`SELECT * FROM "${from}"`))
    await insertAll(target, to, list)
    report[to] = list.length
  }

  for (const [from, to] of AUTH_TABLES) await copy(from, to)

  const privateGroups = new Set((await read(`SELECT "groupId" FROM "UngroupedExpense"`)).map((r) => str(r['groupId'])))
  const groups = await read(`SELECT * FROM "Group" ORDER BY "createdAt", id`)
  await copy(
    'Group',
    'groups',
    groups.map((g) => ({
      id: g['id'],
      kind: privateGroups.has(str(g['id'])) ? 'private' : 'named',
      slug: g['slug'],
      name: g['name'],
      information: g['information'] ?? '',
      defaultCurrency: currencyOf(g['currencyCode'], `group ${g['id']}`),
      revision: g['revision'],
      createdAt: g['createdAt'],
    })),
  )
  await copy('Participant', 'participants', (await read(`SELECT id, "groupId", name FROM "Participant"`)))
  await copy('UserGroupAccess', 'memberships')
  await copy('GroupInvitation', 'invitations')

  // Expenses: amounts become minor units; shares are resolved with the current rule.
  const expenses = await read(`SELECT * FROM "Expense" ORDER BY "createdAt", id`)
  const paidFor = await read(`SELECT * FROM "ExpensePaidFor" ORDER BY "expenseId", "participantId"`)
  const lastChange = new Map(
    (await read(`SELECT "expenseId", max(time) AS t FROM "Activity" WHERE "expenseId" IS NOT NULL GROUP BY 1`)).map((r) => [
      str(r['expenseId']),
      r['t'],
    ]),
  )
  const sharesByExpense = Map.groupBy(paidFor, (r) => str(r['expenseId']))
  let payerRows = 0
  let shareRows = 0
  for (const e of expenses) {
    const where = `expense ${e['id']}`
    const currency = currencyOf(e['currencyCode'], where)
    const amount = toMinor(e['amount'], currency, where)
    const mode = SPLIT_MODE[str(e['splitMode'])] ?? fail(`${where}: unknown split mode ${e['splitMode']}`)
    if (e['originalAmount'] !== null || e['originalCurrency'] !== null || e['conversionRate'] !== null)
      fail(`${where}: converted amounts are not supported by the importer yet; none existed when it was written`)
    const people = sharesByExpense.get(str(e['id'])) ?? []
    const weight = (r: Row) =>
      mode === 'amount' ? String(toMinor(r['shares'], currency, `${where} share`)) : decimalText(r['shares'])
    const shares = resolveShares({
      amount,
      mode,
      preferredParticipantId: str(e['paidById']),
      participants: people.map((r) => ({ participantId: str(r['participantId']), weight: weight(r) })),
    })
    if (e['deletedAt'] === null && sumMinor(shares.values()) !== amount)
      fail(`${where}: its shares sum to ${sumMinor(shares.values())}, not ${amount}`)
    await insertAll(target, 'expenses', [
      {
        id: e['id'],
        groupId: e['groupId'],
        revision: e['revision'],
        kind: e['isReimbursement'] ? 'payment' : 'expense',
        title: e['title'],
        vendor: e['vendor'],
        notes: e['notes'] ?? '',
        categoryId: e['categoryId'],
        expenseDate: e['expenseDate'],
        currency,
        amount,
        splitMode: mode,
        recurrence: RECURRENCE[str(e['recurrenceRule'] ?? 'NONE')] ?? fail(`${where}: unknown recurrence`),
        createdAt: e['createdAt'],
        updatedAt: lastChange.get(str(e['id'])) ?? e['createdAt'],
        deletedAt: e['deletedAt'],
      },
    ])
    await insertAll(target, 'expense_payers', [{ expenseId: e['id'], groupId: e['groupId'], participantId: e['paidById'], amount, weight: '1' }])
    payerRows++
    for (const r of people) {
      await insertAll(target, 'expense_shares', [
        {
          expenseId: e['id'],
          groupId: e['groupId'],
          participantId: r['participantId'],
          amount: shares.get(str(r['participantId'])) ?? minor(0n),
          weight: weight(r),
        },
      ])
      shareRows++
    }
  }
  report['expenses'] = expenses.length
  report['expense_payers'] = payerRows
  report['expense_shares'] = shareRows

  // History: copied verbatim. Legacy snapshots keep "schemaVersion": 1.
  const activities = await read(`SELECT * FROM "Activity" ORDER BY sequence`)
  await copy(
    'Activity',
    'activities',
    activities.map((a) => ({
      sequence: a['sequence'],
      id: a['id'],
      groupId: a['groupId'],
      time: a['time'],
      type: str(a['activityType']).toLowerCase(),
      participantId: a['participantId'],
      expenseId: a['expenseId'],
      expenseRevision: a['expenseRevision'],
      data: a['data'],
      snapshot: a['snapshot'] === null ? null : JSON.stringify(a['snapshot']),
      source: a['source'],
      actorName: a['actorName'],
      actorUserId: a['actorUserId'],
      agentKeyId: a['agentKeyId'],
    })),
  )
  await target.query(`SELECT setval(pg_get_serial_sequence('activities', 'sequence'), (SELECT coalesce(max(sequence), 1) FROM activities))`)

  await copy('ReceiptObject', 'receipts')
  // The current app reads an expense's receipts without ORDER BY, so in the
  // table's physical order: the order they were attached. Positions keep it,
  // as migration 0010 numbers them.
  await copy(
    'ExpenseDocument',
    'expense_documents',
    (
      await read(
        `SELECT *, (row_number() OVER (PARTITION BY "expenseId" ORDER BY ctid) - 1)::int AS position FROM "ExpenseDocument" ORDER BY "expenseId", ctid`,
      )
    ).map((d) => {
      if (d['expenseId'] === null) return fail(`document ${d['id']}: no expense; orphan documents are not supported`)
      return d
    }),
  )
  await copy('RecurringExpenseLink', 'recurring_links')
  await copy('UngroupedExpense', 'private_contexts', (await read(`SELECT "groupId", "expenseId" FROM "UngroupedExpense"`)))
  await copy('UngroupedPerson', 'private_people')
  return report
}

if (import.meta.main) {
  const source = await new pg.Pool({ connectionString: sourceUrl, max: 1 }).connect()
  const targetPool = new pg.Pool({ connectionString: targetUrl, max: 1 })
  const target = await targetPool.connect()
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await target.query('BEGIN')
    const existing = await target.query(`SELECT count(*)::int AS n FROM expenses`)
    if (existing.rows[0].n !== 0) fail('The target database already has expenses; import only into an empty database')
    const report = await importLegacy({ source, target })
    await target.query('COMMIT')
    await source.query('COMMIT')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {})
    console.error(error instanceof ImportError ? `Import stopped: ${error.message}` : error)
    process.exitCode = 1
  } finally {
    source.release()
    target.release()
    await targetPool.end()
    process.exit()
  }
}
