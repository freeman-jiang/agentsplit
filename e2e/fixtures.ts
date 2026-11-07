// Test-only seeding for the e2e suite: synthetic people and expenses written
// through the ledger, and a signed session cookie. Refuses anything but the
// disposable loopback database that scripts/e2e.sh creates.
import { randomBytes } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import { serializeSignedCookie } from 'better-call'
import pg from 'pg'
import { groups, memberships, participants } from '../db/schema/app'
import { session, user } from '../db/schema/auth'
import type { ExpenseDraft } from '../src/shared/expense-rules'
import { randomId } from '../src/shared/ids'
import { createAuth } from '../src/server/auth'
import { makeDb, type Db } from '../src/server/db'
import type { Principal } from '../src/server/access'
import { createExpense, updateExpense } from '../src/server/ledger'

const url = new URL(process.env['E2E_DATABASE_URL'] ?? '')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/e2e/.test(url.pathname)) throw new Error('E2E needs the disposable loopback database from scripts/e2e.sh')
const secret = process.env['E2E_SECRET'] ?? ''
if (secret.length < 32) throw new Error('Set E2E_SECRET (scripts/e2e.sh does)')

export async function withDb<A>(work: (db: Db) => Promise<A>): Promise<A> {
  const client = new pg.Client({ connectionString: url.href })
  await client.connect()
  try {
    return await work(makeDb(client))
  } finally {
    await client.end()
  }
}

const tx = <A>(work: (db: Db) => Promise<A>) => withDb((db) => db.transaction(work, { isolationLevel: 'serializable' }))

export type Household = { slug: string; groupId: string; owner: Principal; people: { id: string; name: string }[] }

/** A group with three people; the first is the signed-in owner. */
export async function seedHousehold(context: BrowserContext, baseURL: string): Promise<Household> {
  const suffix = randomBytes(5).toString('hex')
  const people = ['Alice', 'Bob', 'Cara'].map((name) => ({ id: `${name.toLowerCase()}-${suffix}`, name: `${name} Example` }))
  const owner: Principal = { userId: `u-${people[0]?.id}`, name: people[0]?.name ?? '', email: `alice-${suffix}@example.com`, source: 'web', agentKeyId: null }
  const groupId = `g-${suffix}`
  const slug = `home-${suffix}`
  const token = randomBytes(32).toString('hex')
  await withDb(async (db) => {
    const now = new Date()
    await db.insert(user).values({ id: owner.userId, name: owner.name, email: owner.email, emailVerified: true, createdAt: now, updatedAt: now })
    await db.insert(groups).values({ id: groupId, kind: 'named', slug, name: `Household ${suffix}`, defaultCurrency: 'USD' })
    await db.insert(participants).values(people.map((p) => ({ id: p.id, groupId, name: p.name })))
    await db.insert(memberships).values({ userId: owner.userId, groupId, role: 'admin', participantId: people[0]?.id ?? null })
    await db.insert(session).values({ id: `s-${suffix}`, token, userId: owner.userId, expiresAt: new Date(Date.now() + 3_600_000), createdAt: now, updatedAt: now })
  })
  const signed = (await serializeSignedCookie('better-auth.session_token', token, secret)).split(';')[0] ?? ''
  await context.addCookies([{ name: 'better-auth.session_token', value: signed.slice('better-auth.session_token='.length), url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  return { slug, groupId, owner, people }
}

/** A second group of the household's owner, without a slug, with an ID as the app makes them. Returns its ID. */
export async function seedUnsluggedGroup(household: Household): Promise<string> {
  const groupId = randomId()
  const participantId = randomId()
  await withDb(async (db) => {
    await db.insert(groups).values({ id: groupId, kind: 'named', slug: null, name: `Trip ${groupId}`, defaultCurrency: 'USD' })
    await db.insert(participants).values({ id: participantId, groupId, name: household.owner.name })
    await db.insert(memberships).values({ userId: household.owner.userId, groupId, role: 'admin', participantId })
  })
  return groupId
}

/** An even split of `amount` among everyone, paid by `payer`. */
export function draft(household: Household, data: { title: string; amount: string; date: string; payer?: number; vendor?: string }): ExpenseDraft {
  const payer = household.people[data.payer ?? 0]?.id ?? ''
  return {
    kind: 'expense',
    title: data.title,
    vendor: data.vendor ?? null,
    notes: '',
    categoryId: 0,
    expenseDate: data.date,
    currency: 'USD',
    amount: data.amount,
    payers: [{ participantId: payer, amount: data.amount }],
    splitMode: 'evenly',
    shares: household.people.map((p) => ({ participantId: p.id, weight: '1' })),
    recurrence: 'none',
  }
}

export const addExpense = (household: Household, expenseId: string, expense: ExpenseDraft) =>
  tx((db) => createExpense(db, { principal: household.owner, group: household.groupId, expenseId, idempotencyKey: `e2e-${expenseId}`, expense }))

export const editExpense = (household: Household, expenseId: string, expectedRevision: number, expense: ExpenseDraft) =>
  tx((db) => updateExpense(db, { principal: household.owner, group: household.groupId, expenseId, expectedRevision, idempotencyKey: `e2e-edit-${expenseId}-${expectedRevision}`, expense }))

/** A raw agent API key for a seeded account, from Better Auth's own createApiKey, as Settings creates it. */
export const agentKey = (userId: string, baseURL: string) =>
  withDb(async (db) => {
    const auth = createAuth({ db, baseUrl: baseURL, secret, googleClientId: 'e2e-client', googleClientSecret: 'e2e-secret' })
    return (await auth.api.createApiKey({ body: { userId } })).key
  })
