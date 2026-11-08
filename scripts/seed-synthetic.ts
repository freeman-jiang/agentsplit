// Seeds a dev or test database with synthetic people and a year of expenses,
// written through the ledger like real writes. Never production.
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area> bun scripts/seed-synthetic.ts <cookie-file>
// Writes the signed session cookie of alice@example.com to <cookie-file> (mode 600), for the app at
// BASE_URL with BETTER_AUTH_SECRET (Bun reads both from .env.local). Send it as the Cookie header.
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { makeDb, serializable } from '../src/server/core/db'
import { createExpense } from '../src/server/ledger'
import { unsafeDatabase } from '../test/kit/database'
import { draft } from '../test/kit/drafts'
import { seedHousehold } from '../test/kit/seed'
import { signIn } from '../test/kit/session'

const url = process.env['DATABASE_URL']
const baseUrl = process.env['BASE_URL']
const secret = process.env['BETTER_AUTH_SECRET']
const cookieFile = process.argv[2]
if (!url || !baseUrl || !secret || !cookieFile) throw new Error('Usage: DATABASE_URL=... BASE_URL=... BETTER_AUTH_SECRET=... bun scripts/seed-synthetic.ts <cookie-file>')
const database = new URL(url).pathname.slice(1)
const unsafe = unsafeDatabase(database)
if (unsafe) throw new Error(`Refusing to seed ${database}: ${unsafe}`)

const pool = new pg.Pool({ connectionString: url, max: 1 })
const client = await pool.connect()
const db = makeDb(client)

const household = await seedHousehold(db, {
  groupId: 'syn-household',
  slug: 'synthetic',
  name: 'Synthetic household',
  people: [
    { id: 'syn-alice-p', name: 'Alice Example', userId: 'alice' },
    { id: 'syn-bob-p', name: 'Bob Example', userId: 'bob' },
    { id: 'syn-cara-p', name: 'Cara Example', userId: 'cara' },
  ],
})
const people = household.people.map((p) => p.id)

// A deterministic year of expenses. A second run finds them and adds none.
let seed = 42
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const vendors = ['Costco', "Trader Joe's", 'Amazon', 'PG&E', 'Safeway', 'IKEA', null]
let created = 0
for (let day = 0; day < 365; day += 1 + Math.floor(random() * 3)) {
  const expenseDate = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)
  const payer = people[Math.floor(random() * people.length)] ?? 'syn-alice-p'
  const amount = ((500 + Math.floor(random() * 20000)) / 100).toFixed(2)
  const expenseId = `syn-${expenseDate}-${created}`
  const expense = draft({ payer, people, title: `Shared purchase ${created + 1}`, vendor: vendors[Math.floor(random() * vendors.length)] ?? null, amount, expenseDate })
  // The idempotency key makes a second run return the stored expense.
  await serializable(db, (tx) => createExpense(tx, { principal: household.owner, groupId: household.groupId, expenseId, idempotencyKey: `seed-${expenseId}`, expense }))
  created++
}

const cookie = await signIn(db, { userId: household.owner.userId, secret, baseUrl })
writeFileSync(cookieFile, cookie.header, { mode: 0o600 })
client.release()
await pool.end()
console.log(`Seeded ${created} synthetic expenses in ${database}`)
