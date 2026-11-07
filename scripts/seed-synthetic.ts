// Seeds a preview or test database with synthetic people and a year of
// expenses, written through the ledger like real writes. Never production.
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area> bun scripts/seed-synthetic.ts <token-file>
// Writes a session token for alice@example.com to <token-file> (mode 600).
import { writeFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { groups, memberships, participants } from '../db/schema/app'
import { session, user } from '../db/schema/auth'
import { makeDb } from '../src/server/db'
import type { Principal } from '../src/server/access'
import { createExpense } from '../src/server/ledger'

const url = process.env['DATABASE_URL']
const tokenFile = process.argv[2]
if (!url || !tokenFile) throw new Error('Usage: DATABASE_URL=... bun scripts/seed-synthetic.ts <token-file>')
const database = new URL(url).pathname.slice(1)
if (!/(_preview$|test|_dev($|_))/.test(database)) throw new Error(`Refusing to seed ${database}: synthetic data goes only to preview, test or dev`)

const pool = new pg.Pool({ connectionString: url, max: 1 })
const client = await pool.connect()
const db = makeDb(client)

const people = [
  { id: 'syn-alice', name: 'Alice Example', email: 'alice@example.com' },
  { id: 'syn-bob', name: 'Bob Example', email: 'bob@example.com' },
  { id: 'syn-cara', name: 'Cara Example', email: 'cara@example.com' },
]
const now = new Date()
await db.insert(user).values(people.map((p) => ({ ...p, emailVerified: true, createdAt: now, updatedAt: now }))).onConflictDoNothing()
const groupId = 'syn-household'
await db.insert(groups).values({ id: groupId, kind: 'named', slug: 'synthetic', name: 'Synthetic household', defaultCurrency: 'USD' }).onConflictDoNothing()
await db.insert(participants).values(people.map((p) => ({ id: `${p.id}-p`, groupId, name: p.name }))).onConflictDoNothing()
await db
  .insert(memberships)
  .values(people.map((p, i) => ({ userId: p.id, groupId, role: i === 0 ? ('admin' as const) : ('member' as const), participantId: `${p.id}-p` })))
  .onConflictDoNothing()

// A deterministic year of expenses: rent, utilities, groceries, and some repayments.
let seed = 42
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const alice: Principal = { userId: 'syn-alice', name: 'Alice Example', email: 'alice@example.com', source: 'web', agentKeyId: null }
const vendors = ['Costco', "Trader Joe's", 'Amazon', 'PG&E', 'Safeway', 'IKEA', null]
let created = 0
for (let day = 0; day < 365; day += 1 + Math.floor(random() * 3)) {
  const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)
  const payer = people[Math.floor(random() * 3)]!
  const cents = 500 + Math.floor(random() * 20000)
  const amount = (cents / 100).toFixed(2)
  const expenseId = `syn-${date}-${created}`
  const [exists] = await db.select({ id: participants.id }).from(participants).where(and(eq(participants.groupId, groupId), eq(participants.id, `${payer.id}-p`)))
  if (!exists) throw new Error('Seed participants are missing')
  await db.transaction(
    (tx) =>
      createExpense(tx, {
        principal: alice,
        group: groupId,
        expenseId,
        idempotencyKey: `seed-${expenseId}`,
        expense: {
          kind: 'expense',
          title: `Shared purchase ${created + 1}`,
          vendor: vendors[Math.floor(random() * vendors.length)] ?? null,
          notes: '',
          categoryId: 0,
          expenseDate: date,
          currency: 'USD',
          amount,
          payers: [{ participantId: `${payer.id}-p`, amount }],
          splitMode: 'evenly',
          shares: people.map((p) => ({ participantId: `${p.id}-p`, weight: '1' })),
          recurrence: 'none',
        },
      }),
    { isolationLevel: 'serializable' },
  ).catch((error: unknown) => {
    // Re-running the seed reuses expense IDs; skip those that exist.
    if (!(error instanceof Error && /already exists/.test(error.message))) throw error
  })
  created++
}

const token = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')
await db.insert(session).values({ id: `syn-session-${Date.now()}`, token, userId: 'syn-alice', expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now })
writeFileSync(tokenFile, token, { mode: 0o600 })
client.release()
await pool.end()
console.log(`Seeded ${created} synthetic expenses in ${database}`)
