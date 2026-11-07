// Test-only seeding for the e2e suite: synthetic people and expenses written
// through the ledger, and a signed session cookie. Refuses anything but the
// disposable loopback database that scripts/e2e.sh creates.
import { randomBytes } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import pg from 'pg'
import type { ExpenseDraft } from '../src/shared/expense-rules'
import { randomId } from '../src/shared/ids'
import { createAuth } from '../src/server/auth/auth'
import { makeDb, serializable, type Db } from '../src/server/core/db'
import { createExpense, updateExpense } from '../src/server/ledger'
import { draft as evenDraft } from '../test/kit/drafts'
import { testSettings } from '../test/kit/config'
import { seedGroup, seedHousehold as seedHouseholdRows, type Household } from '../test/kit/seed'
import { signIn } from '../test/kit/session'

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

const tx = <A>(work: (db: Db) => Promise<A>) => withDb((db) => serializable(db, work))

/** The Google client that scripts/e2e.sh gives the server. */
export const E2E_GOOGLE_CLIENT_ID = 'e2e-client'
const e2eSettings = (baseUrl: string) => testSettings({ baseUrl, secret, googleClientId: E2E_GOOGLE_CLIENT_ID, googleClientSecret: 'e2e-secret' })

export type { Household }

/** A group with three people; the first is the signed-in owner, the others have no account. */
export async function seedHousehold(context: BrowserContext, baseURL: string): Promise<Household> {
  const suffix = randomBytes(5).toString('hex')
  const [alice, bob, cara] = ['Alice', 'Bob', 'Cara'].map((name) => ({ id: `${name.toLowerCase()}-${suffix}`, name: `${name} Example` }))
  if (!alice || !bob || !cara) throw new Error('three people')
  const { household, cookie } = await withDb(async (db) => {
    const household = await seedHouseholdRows(db, { groupId: `g-${suffix}`, slug: `home-${suffix}`, name: `Household ${suffix}`, people: [{ ...alice, userId: `u-${alice.id}` }, bob, cara] })
    return { household, cookie: await signIn(db, { userId: household.owner.userId, secret, baseUrl: baseURL }) }
  })
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  return household
}

/** A second group of the household's owner, without a slug, with an ID as the app makes them. Returns its ID. */
export async function seedUnsluggedGroup(household: Household): Promise<string> {
  const groupId = randomId()
  const participantId = randomId()
  await tx((db) =>
    seedGroup(db, {
      groupId,
      slug: null,
      name: `Trip ${groupId}`,
      people: [{ id: participantId, name: household.owner.name }],
      creator: household.owner,
      members: [{ userId: household.owner.userId, participantId, role: 'admin' }],
    }),
  )
  return groupId
}

/** An even split of `amount` among everyone, paid by person `payer` (the owner by default). */
export function draft(household: Household, data: { title: string; amount: string; date: string; payer?: number; vendor?: string }): ExpenseDraft {
  return evenDraft({
    payer: household.people[data.payer ?? 0]?.id ?? '',
    people: household.people.map((p) => p.id),
    title: data.title,
    vendor: data.vendor ?? null,
    amount: data.amount,
    expenseDate: data.date,
  })
}

export const addExpense = (household: Household, expenseId: string, expense: ExpenseDraft) =>
  tx((db) => createExpense(db, { principal: household.owner, groupId: household.groupId, expenseId, idempotencyKey: `e2e-${expenseId}`, expense }))

export const editExpense = (household: Household, expenseId: string, expectedRevision: number, expense: ExpenseDraft) =>
  tx((db) => updateExpense(db, { principal: household.owner, groupId: household.groupId, expenseId, expectedRevision, idempotencyKey: `e2e-edit-${expenseId}-${expectedRevision}`, expense }))

/** A raw agent API key for a seeded account, from Better Auth's own createApiKey, as Settings creates it. */
export const agentKey = (userId: string, baseURL: string) =>
  withDb(async (db) => {
    const auth = createAuth({ ...e2eSettings(baseURL), db })
    return (await auth.api.createApiKey({ body: { userId } })).key
  })
