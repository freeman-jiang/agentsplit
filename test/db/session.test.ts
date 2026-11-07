// The RPC session check must accept exactly the sessions Better Auth accepts.
import { serializeSignedCookie } from 'better-call'
import type { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { session, user } from '../../db/schema/auth'
import { createAuth } from '~/server/auth/auth'
import { makeDb, type Db } from '~/server/core/db'
import { sessionPrincipal } from '~/server/auth/session'
import { resetTestDatabase } from './setup'

const secret = 'test-secret-0123456789-0123456789-0123456789'
let pool: Pool
let db: Db
let release: () => void

beforeAll(async () => {
  pool = await resetTestDatabase()
  const client = await pool.connect()
  release = () => client.release()
  db = makeDb(client)
  const now = new Date()
  await db.insert(user).values([
    { id: 'verified', name: 'V', email: 'v@example.com', emailVerified: true, createdAt: now, updatedAt: now },
    { id: 'unverified', name: 'U', email: 'u@example.com', emailVerified: false, createdAt: now, updatedAt: now },
  ])
  const later = new Date(Date.now() + 3_600_000)
  await db.insert(session).values([
    { id: 's1', token: 'token-valid', userId: 'verified', expiresAt: later, createdAt: now, updatedAt: now },
    { id: 's2', token: 'token-expired', userId: 'verified', expiresAt: new Date(Date.now() - 1000), createdAt: now, updatedAt: now },
    { id: 's3', token: 'token-unverified', userId: 'unverified', expiresAt: later, createdAt: now, updatedAt: now },
  ])
})
afterAll(async () => {
  release()
  await pool.end()
})

const signed = async (token: string, key = secret, name = 'better-auth.session_token') =>
  (await serializeSignedCookie(name, token, key)).split(';')[0] ?? ''

it.each(['http://localhost', 'https://agentsplit.example'])('accepts and rejects the same cookies as Better Auth on %s', async (baseUrl) => {
  const auth = createAuth({ db, baseUrl, secret, googleClientId: 'a', googleClientSecret: 'b', bootstrapEmail: undefined, signUpDailyLimit: 200 })
  const cases: Record<string, string | null> = {
    valid: await signed('token-valid'),
    secureName: await signed('token-valid', secret, '__Secure-better-auth.session_token'),
    expired: await signed('token-expired'),
    unverified: await signed('token-unverified'),
    wrongSecret: await signed('token-valid', 'another-secret-0123456789-0123456789-0123'),
    tampered: (await signed('token-valid')).replace('token-valid', 'token-expired'),
    unknownToken: await signed('token-unknown'),
    unsigned: 'better-auth.session_token=token-valid',
    none: null,
  }
  for (const [name, cookie] of Object.entries(cases)) {
    const theirs = await auth.api.getSession({ headers: new Headers(cookie ? { cookie } : {}) })
    const ours = await sessionPrincipal(db, { cookie, secret, baseUrl })
    // Better Auth returns unverified accounts too; AgentSplit then refuses them, as the current app does.
    const expected = theirs?.user.emailVerified ? theirs.user.id : null
    expect({ name, user: ours?.userId ?? null }).toEqual({ name, user: expected })
  }
})
