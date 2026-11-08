// 0020 on a database with rows, as production has them. The test template is
// migrated empty, so a migration that fails on existing rows passes every other
// test, and then stops the production server at its start.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from '../../db/migrate'
import { user } from '../../db/schema/auth'
import { balanceDrift, listBalances } from '~/server/balances'
import { makeDb } from '~/server/core/db'
import { emptyDatabase } from '../kit/database'
import { principal, userRows } from '../kit/people'
import { seedGroup } from '../kit/seed'

let database: Awaited<ReturnType<typeof emptyDatabase>>
let before = ''
const alice = principal('mig-alice', { name: 'Alice' })

/** A copy of the migrations up to and including `last`. */
function migrationsUpTo(last: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsplit-migrations-'))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= last) }))
  return dir
}

beforeAll(async () => {
  database = await emptyDatabase()
  before = migrationsUpTo(19)
  await runMigrations({ pool: database.pool, dir: before })
})
afterAll(async () => {
  rmSync(before, { recursive: true, force: true })
  await database.close()
})

describe('migration 0020', () => {
  it('backfills the copies and the totals of live and deleted expenses, and keeps every balance', async () => {
    const client = await database.pool.connect()
    try {
      const db = makeDb(client)
      await db.insert(user).values(userRows([alice]))
      await db.transaction((tx) =>
        seedGroup(tx, { groupId: 'mg', slug: null, name: 'Home', people: [{ id: 'mg-a', name: 'Alice' }, { id: 'mg-b', name: 'Bob' }], creator: alice, members: [{ userId: alice.userId, participantId: 'mg-a', role: 'admin' }] }),
      )
      // Expenses from before history (revision 0), as imported rows are: live in two currencies, and one deleted.
      await db.transaction(async (tx) => {
        for (const [id, currency, amount, deleted] of [['mg-1', 'USD', 9000, false], ['mg-2', 'EUR', 500, false], ['mg-3', 'USD', 7000, true]] as const) {
          await tx.execute(sql`INSERT INTO expenses (id, group_id, revision, kind, title, expense_date, currency, amount, split_mode, deleted_at)
            VALUES (${id}, 'mg', 0, 'expense', 'Dinner', '2026-01-01', ${currency}, ${amount}, 'evenly', ${deleted ? sql`now()` : sql`NULL`})`)
          await tx.execute(sql`INSERT INTO expense_payers (expense_id, group_id, participant_id, amount) VALUES (${id}, 'mg', 'mg-a', ${amount})`)
          await tx.execute(sql`INSERT INTO expense_shares (expense_id, group_id, participant_id, amount) VALUES (${id}, 'mg', 'mg-a', ${amount / 2}), (${id}, 'mg', 'mg-b', ${amount / 2})`)
        }
      })
      await runMigrations({ pool: database.pool })
      expect(await balanceDrift(db)).toEqual([])
      const copies = await db.execute(sql`SELECT expense_id, currency, live FROM expense_payers ORDER BY 1`).then((r) => r.rows)
      expect(copies).toEqual([
        { expense_id: 'mg-1', currency: 'USD', live: true },
        { expense_id: 'mg-2', currency: 'EUR', live: true },
        { expense_id: 'mg-3', currency: 'USD', live: false },
      ])
      // What the sums of the rows give, as balances read them before 0020; the deleted expense counts nothing.
      const balances = await listBalances(db, { principal: alice, groupId: 'mg' })
      expect(balances.currencies.map((c) => [c.currency, c.balances.map((b) => [b.participantId, b.paid, b.owed, b.net])])).toEqual([
        ['EUR', [['mg-a', '5.00', '2.50', '2.50'], ['mg-b', '0.00', '2.50', '-2.50']]],
        ['USD', [['mg-a', '90.00', '45.00', '45.00'], ['mg-b', '0.00', '45.00', '-45.00']]],
      ])
    } finally {
      client.release()
    }
  })
})
