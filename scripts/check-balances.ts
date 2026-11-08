// Checks that the running balances (balance_totals) equal a full recount of
// the payer and share rows of live expenses, in one read-only snapshot. It
// writes nothing, so it may run against any database, production included.
//   DATABASE_URL=postgresql://... bun scripts/check-balances.ts [<group-id>]
// It prints each sum that differs and exits with 1, or prints "balances match"
// and exits with 0. A difference means a write changed payers or shares
// without the triggers of db/migrations/0020: stop and find that write.
import pg from 'pg'
import { balanceDrift } from '../src/server/balances'
import { makeDb } from '../src/server/core/db'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('Usage: DATABASE_URL=... bun scripts/check-balances.ts [<group-id>]')
const groupId = process.argv[2]

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const drift = await balanceDrift(makeDb(client), groupId === undefined ? {} : { groupId })
  await client.query('COMMIT')
  if (drift.length === 0) {
    console.log(`balances match${groupId === undefined ? ' in every group' : ` in group ${groupId}`}`)
  } else {
    console.error(`${drift.length} sums differ (stored in balance_totals, counted from the rows):`)
    for (const d of drift) console.error(JSON.stringify(d))
    process.exitCode = 1
  }
} finally {
  await client.end()
}
