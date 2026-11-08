// The account area against a real database: profile, API keys through Better
// Auth, connected apps, consent clients, the owner bootstrap, and the
// security rules that sign-in and the server rely on.
import { and, eq } from 'drizzle-orm'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authBootstrap, groups, legacyGroupClaims, memberships, oauthConnections } from '../../db/schema/app'
import * as auth from '../../db/schema/auth'
import { consentClient, getAccount, revokeApiKey, revokeConnection, updateProfile } from '~/server/account'
import { bootstrapOwner } from '~/server/auth/owner-bootstrap'
import { createAuth } from '~/server/auth/auth'
import type { Principal } from '~/server/core/access'
import { makeDb, type Db } from '~/server/core/db'
import { API_HEADERS, documentHeaders } from '~/server/headers'
import { safeNextPath } from '~/shared/account'
import { LIMITS } from '~/shared/limits'
import { Forbidden, Invalid, NotFound } from '~/shared/api'
import { BASE, SECRET, testSettings } from '../kit/config'
import { testDatabase, type TestDatabase } from '../kit/database'
import { counter } from '../kit/ids'
import { principal, userRows } from '../kit/people'
import { signIn } from '../kit/session'
import { testApp } from './harness'

let database: TestDatabase
let pool: Pool
let client: PoolClient
let db: Db

const day = (n: number) => new Date(Date.UTC(2026, 10, n))
const nextUser = counter('user')

/** A new account for one test, verified unless asked. */
async function newUser(data: { verified?: boolean } = {}): Promise<Principal> {
  const person = principal(nextUser())
  await db.insert(auth.user).values(userRows([person], { verified: data.verified ?? true }))
  return person
}

const makeAuth = (bootstrapEmail?: string) => createAuth({ ...testSettings({ bootstrapEmail }), db })

const sessionHeaders = async (userId: string) => new Headers({ cookie: (await signIn(db, { userId, secret: SECRET, baseUrl: BASE })).header, origin: BASE })

beforeAll(async () => {
  database = await testDatabase()
  pool = database.pool
  client = await pool.connect()
  db = makeDb(client)
})
afterAll(async () => {
  client.release()
  await database.close()
})

describe('profile', () => {
  it('trims the name and changes only the caller', async () => {
    const caller = await newUser()
    const other = await newUser()
    const result = await updateProfile(db, { principal: caller, name: '  Alice Liddell  ' })
    expect(result).toEqual({ profile: { id: caller.userId, name: 'Alice Liddell', email: caller.email, emailVerified: true } })
    const [row] = await db.select({ name: auth.user.name }).from(auth.user).where(eq(auth.user.id, other.userId))
    expect(row?.name).toBe(other.name)
  })

  it('accepts 1 to LIMITS.nameMax characters after trimming', async () => {
    const caller = await newUser()
    await expect(updateProfile(db, { principal: caller, name: '   ' })).rejects.toBeInstanceOf(Invalid)
    await expect(updateProfile(db, { principal: caller, name: 'x'.repeat(LIMITS.nameMax + 1) })).rejects.toBeInstanceOf(Invalid)
    expect((await updateProfile(db, { principal: caller, name: 'x'.repeat(LIMITS.nameMax) })).profile.name).toHaveLength(LIMITS.nameMax)
  })

  it('refuses an unverified account', async () => {
    const refused = updateProfile(db, { principal: await newUser({ verified: false }), name: 'New' })
    await expect(refused).rejects.toBeInstanceOf(Forbidden)
    await expect(refused).rejects.toMatchObject({ message: 'Verify your email before setting your display name.' })
  })
})

describe('API keys', () => {
  it('creates keys through Better Auth with the current prefix, rate limit and owner', async () => {
    const owner = await newUser()
    const created = await makeAuth().api.createApiKey({ body: { name: 'My Codex' }, headers: await sessionHeaders(owner.userId) })
    expect(created.key.startsWith('agentsplit_')).toBe(true)
    const [row] = await db.select().from(auth.apikey).where(eq(auth.apikey.id, created.id))
    expect(row).toMatchObject({
      referenceId: owner.userId,
      name: 'My Codex',
      prefix: 'agentsplit_',
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: LIMITS.apiKeyRequestsPerMinute,
      expiresAt: null,
    })
    // Only the hash is stored.
    expect(row?.key).not.toContain(created.key)
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(true)
  })

  it('refuses names over LIMITS.apiKeyNameMax characters', async () => {
    const owner = await newUser()
    await expect(makeAuth().api.createApiKey({ body: { name: 'x'.repeat(LIMITS.apiKeyNameMax + 1) }, headers: await sessionHeaders(owner.userId) })).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'INVALID_NAME_LENGTH' },
    })
    expect((await getAccount(db, { principal: owner })).apiKeys).toEqual([])
  })

  it('refuses to create a key with a key instead of a session', async () => {
    const owner = await newUser()
    const created = await makeAuth().api.createApiKey({ body: { name: 'Agent' }, headers: await sessionHeaders(owner.userId) })
    const asKey = new Headers({ 'x-api-key': created.key, origin: BASE })
    await expect(makeAuth().api.createApiKey({ body: { name: 'Minted' }, headers: asKey })).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
    expect(await makeAuth().api.getSession({ headers: asKey })).toBeNull()
    expect((await getAccount(db, { principal: owner })).apiKeys.map((k) => k.name)).toEqual(['Agent'])
  })

  it('lists only the caller’s keys, newest first, without the key', async () => {
    const owner = await newUser()
    const other = await newUser()
    const older = await makeAuth().api.createApiKey({ body: { userId: owner.userId, name: 'Older' } })
    await makeAuth().api.createApiKey({ body: { userId: owner.userId, name: 'Newer' } })
    await makeAuth().api.createApiKey({ body: { userId: other.userId, name: 'Not mine' } })
    // Two keys can share a millisecond, so the older key gets an earlier date.
    await db.update(auth.apikey).set({ createdAt: day(1) }).where(eq(auth.apikey.id, older.id))
    const account = await getAccount(db, { principal: owner })
    expect(account.apiKeys.map((k) => k.name)).toEqual(['Newer', 'Older'])
    expect(Object.keys(account.apiKeys[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'start'])
    // Better Auth stores the first characters of the key for recognition: the prefix, never the secret part.
    expect('agentsplit_'.startsWith(account.apiKeys[0]?.start ?? 'missing')).toBe(true)
    expect(account.apiKeys[0]?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  it('revokes only the caller’s own key, and a revoked key stops working', async () => {
    const owner = await newUser()
    const other = await newUser()
    const created = await makeAuth().api.createApiKey({ body: { name: 'Temp' }, headers: await sessionHeaders(owner.userId) })
    await expect(revokeApiKey(db, { principal: other, keyId: created.id })).rejects.toBeInstanceOf(NotFound)
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(true)
    expect(await revokeApiKey(db, { principal: owner, keyId: created.id })).toEqual({ revoked: true })
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(false)
  })
})

describe('connected apps', () => {
  const alice = principal('alice')

  /**
   * Connections of `userId` to four clients: ChatGPT with write consent, an
   * unnamed reader whose consent was reduced to read after the grant, a client
   * without consent, and a revoked one. ChatGPT also has tokens.
   */
  async function connectApps(userId: string) {
    const connection = (id: string, clientId: string, scopes: string[], createdAt: Date, revokedAt: Date | null = null) => ({
      id: `${userId}-${id}`,
      authorizationCodeId: `code-${userId}-${id}`,
      userId,
      clientId,
      scopes,
      createdAt,
      revokedAt,
    })
    await db.insert(oauthConnections).values([
      connection('c1', 'chatgpt', ['agentsplit:read', 'agentsplit:write'], day(2)),
      connection('c2', 'reader', ['agentsplit:read', 'agentsplit:write'], day(3)),
      connection('c3', 'no-consent', ['agentsplit:read'], day(4)),
      connection('c4', 'revoked', ['agentsplit:read'], day(5), day(6)),
      // A disabled client's tokens fail verifyConnection, so Settings must not list it either.
      connection('c5', 'disabled', ['agentsplit:read'], day(7)),
    ])
    const consent = (clientId: string, scopes: string[]) => ({ id: `consent-${userId}-${clientId}`, clientId, userId, scopes, createdAt: day(1) })
    await db.insert(auth.oauthConsent).values([
      consent('chatgpt', ['agentsplit:read', 'agentsplit:write', 'offline_access']),
      // Consent reduced to read only after the grant: write is gone at once.
      consent('reader', ['agentsplit:read']),
      consent('revoked', ['agentsplit:read']),
      consent('disabled', ['agentsplit:read']),
    ])
    await db.insert(auth.oauthRefreshToken).values({ id: `${userId}-r1`, token: `hash-${userId}-r1`, clientId: 'chatgpt', userId, scopes: ['agentsplit:read'] })
    await db.insert(auth.oauthAccessToken).values({ id: `${userId}-a1`, token: `hash-${userId}-a1`, clientId: 'chatgpt', userId, scopes: ['agentsplit:read'] })
  }

  beforeAll(async () => {
    const client = (clientId: string, name: string | null, disabled = false) => ({
      id: clientId,
      clientId,
      name,
      disabled,
      redirectUris: ['https://app.example/callback'],
      createdAt: day(1),
      updatedAt: day(1),
    })
    await db.insert(auth.oauthClient).values([
      client('chatgpt', 'ChatGPT'),
      client('reader', null),
      client('no-consent', 'Stale'),
      client('revoked', 'Revoked'),
      client('disabled', 'Off', true),
    ])
    await db.insert(auth.user).values(userRows([alice], { verified: true }))
    await connectApps(alice.userId)
  })

  it('lists unrevoked, consented clients once, newest connection first', async () => {
    const account = await getAccount(db, { principal: alice })
    expect(account.connections).toEqual([
      { clientId: 'reader', name: 'Connected app', canWrite: false },
      { clientId: 'chatgpt', name: 'ChatGPT', canWrite: true },
    ])
    expect((await getAccount(db, { principal: await newUser() })).connections).toEqual([])
  })

  it('revokes with a tombstone and deletes the tokens and consent', async () => {
    const owner = await newUser()
    await connectApps(owner.userId)
    await makeAuth().api.createApiKey({ body: { userId: owner.userId } })
    expect(await revokeConnection(db, { principal: owner, clientId: 'chatgpt' })).toEqual({ revoked: true })
    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, `${owner.userId}-c1`))
    expect(connection?.revokedAt).toBeInstanceOf(Date)
    for (const table of [auth.oauthAccessToken, auth.oauthRefreshToken, auth.oauthConsent])
      expect(await db.select().from(table).where(and(eq(table.userId, owner.userId), eq(table.clientId, 'chatgpt')))).toEqual([])
    // Other clients and the user's API keys are untouched.
    const account = await getAccount(db, { principal: owner })
    expect(account.connections.map((c) => c.clientId)).toEqual(['reader'])
    expect(account.apiKeys).toHaveLength(1)
  })

  it('names a known, enabled client on the consent page', async () => {
    expect(await consentClient(db, { clientId: 'reader' })).toEqual({ clientId: 'reader', name: null })
    expect(await consentClient(db, { clientId: 'disabled' })).toBeNull()
    expect(await consentClient(db, { clientId: 'unknown' })).toBeNull()
  })
})

describe('owner bootstrap', () => {
  beforeAll(async () => {
    await db.insert(groups).values([
      { id: 'legacy-1', kind: 'named', name: 'Legacy 1', defaultCurrency: 'USD' },
      { id: 'legacy-2', kind: 'named', name: 'Legacy 2', defaultCurrency: 'USD' },
      { id: 'later', kind: 'named', name: 'Later', defaultCurrency: 'USD' },
    ])
    await db.insert(legacyGroupClaims).values([{ groupId: 'legacy-1' }, { groupId: 'legacy-2' }])
  })
  // The bootstrap marker is one row for the whole database, so each test starts without it.
  beforeEach(async () => {
    await db.delete(authBootstrap)
  })

  /** A verified account with `email`, for one test. */
  async function owner(email: string) {
    const now = new Date()
    const id = nextUser()
    await db.insert(auth.user).values({ id, name: 'Owner', email, emailVerified: true, createdAt: now, updatedAt: now })
    return { id, email, emailVerified: true }
  }

  const membershipsOf = (userId: string) =>
    db
      .select({ groupId: memberships.groupId, role: memberships.role, active: memberships.active })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(memberships.groupId)

  it('ignores other and unverified emails', async () => {
    const user = { id: 'impostor', email: 'owner@example.com', emailVerified: false }
    expect(await bootstrapOwner(db, { user, bootstrapEmail: 'owner@example.com' })).toBe(false)
    expect(await bootstrapOwner(db, { user: { id: 'bob', email: 'bob@example.com', emailVerified: true }, bootstrapEmail: 'owner@example.com' })).toBe(false)
    expect(await db.select().from(authBootstrap)).toEqual([])
  })

  it('runs on sign-in, once, and grants only the claimed groups', async () => {
    const o = await owner('Owner-Signin@Example.com')
    // An earlier, removed membership is reactivated as admin.
    await db.insert(memberships).values({ userId: o.id, groupId: 'legacy-2', role: 'member', active: false })
    const context = await makeAuth('  OWNER-SIGNIN@example.com ').$context
    await context.internalAdapter.createSession(o.id)
    expect(await membershipsOf(o.id)).toEqual([
      { groupId: 'legacy-1', role: 'admin', active: true },
      { groupId: 'legacy-2', role: 'admin', active: true },
    ])
    // Removing a membership later never brings bootstrap back.
    await db.update(memberships).set({ active: false }).where(and(eq(memberships.userId, o.id), eq(memberships.groupId, 'legacy-1')))
    await context.internalAdapter.createSession(o.id)
    expect(await bootstrapOwner(db, { user: o, bootstrapEmail: 'owner-signin@example.com' })).toBe(false)
    expect((await membershipsOf(o.id)).find((m) => m.groupId === 'legacy-1')?.active).toBe(false)
    expect(await db.select({ userId: authBootstrap.userId }).from(authBootstrap)).toEqual([{ userId: o.id }])
  })

  it('serializes concurrent runs', async () => {
    const o = await owner('owner-race@example.com')
    const clients = await Promise.all([pool.connect(), pool.connect()])
    try {
      const results = await Promise.all(clients.map((c) => bootstrapOwner(makeDb(c), { user: o, bootstrapEmail: o.email })))
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally {
      for (const c of clients) c.release()
    }
  })

  it('never blocks sign-in when it fails', async () => {
    const o = await owner('owner-fail@example.com')
    // Make the marker insert fail, so the bootstrap transaction rolls back.
    await db.execute('ALTER TABLE auth_bootstrap ADD CONSTRAINT fail_for_test CHECK (false) NOT VALID')
    try {
      const context = await makeAuth(o.email).$context
      const created = await context.internalAdapter.createSession(o.id)
      expect(created?.userId).toBe(o.id)
      expect(await db.select().from(authBootstrap)).toEqual([])
      expect(await membershipsOf(o.id)).toEqual([])
    } finally {
      await db.execute('ALTER TABLE auth_bootstrap DROP CONSTRAINT fail_for_test')
    }
  })
})

describe('sign-in destination', () => {
  it('keeps same-origin paths and refuses everything else', () => {
    expect(safeNextPath('/invite/abc?x=1#y')).toBe('/invite/abc?x=1#y')
    expect(safeNextPath('/our-flat/expenses')).toBe('/our-flat/expenses')
    for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'evil', '', '/\tx', '/sign-in?next=/x', null])
      expect(safeNextPath(bad)).toBeNull()
  })

  it('is checked by the server too: Better Auth refuses a foreign callback', async () => {
    // Better Auth limits sign-in starts per IP, with counters in the rate_limit table.
    const start = async (callbackURL: string) => {
      await db.delete(auth.rateLimit)
      return makeAuth().handler(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ provider: 'google', callbackURL }),
        }),
      )
    }
    const ok = await start('/invite/abc')
    expect(ok.status).toBe(200)
    const { url } = (await ok.json()) as { url: string }
    const google = new URL(url)
    expect(google.host).toBe('accounts.google.com')
    // Better Auth's defaults repeat the configured scopes, as in v1; the set is what counts.
    expect([...new Set(google.searchParams.get('scope')?.split(' '))].sort()).toEqual(['email', 'openid', 'profile'])
    for (const bad of ['/\\evil.example', '//evil.example', 'https://evil.example/']) expect({ bad, status: (await start(bad)).status }).toEqual({ bad, status: 403 })
  })
})

describe('security headers and readiness', () => {
  /** The whole app on this file's database; `connect` replaces the pool's connections. */
  const app = (connect?: () => Promise<PoolClient>) => testApp({ pool, ...(connect ? { connect } : {}) })

  // An injected script tag or eval in user content must never run.
  it('allows no inline or eval scripts on the SPA page, and no content at all in an API answer', async () => {
    for (const path of ['/', '/settings']) {
      const policy = (await app().fetch(new Request(`${BASE}${path}`))).headers.get('content-security-policy') ?? ''
      expect({ path, scripts: policy.split('; ').find((d) => d.startsWith('script-src')) }).toEqual({ path, scripts: "script-src 'self'" })
    }
    const api = await app().fetch(new Request(`${BASE}/api/health/readiness`))
    expect(api.headers.get('content-security-policy')).toBe(API_HEADERS['Content-Security-Policy'])
  })

  // The document headers are half of each API answer's bytes, and bytes out of the VM are billed;
  // a static file keeps them, because the service worker runs under the policy of its own response.
  it('sends the document headers only with HTML and the static files, and the short API set with every other answer', async () => {
    const assets = async (request: Request) =>
      new URL(request.url).pathname === '/sw.js'
        ? new Response('self.addEventListener', { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } })
        : new Response('SPA page', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } })
    const site = testApp({ pool, assets })
    const documents = documentHeaders({ receiptOrigin: undefined })
    const securityOf = (response: Response) => Object.fromEntries(Object.keys(documents).flatMap((name) => (response.headers.has(name) ? [[name, response.headers.get(name)]] : [])))
    for (const path of ['/', '/sw.js']) expect({ path, headers: securityOf(await site.fetch(new Request(`${BASE}${path}`))) }).toEqual({ path, headers: documents })
    const answers = [
      new Request(`${BASE}/api/rpc`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: '[]' }),
      new Request(`${BASE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }),
      new Request(`${BASE}/api/auth/get-session`),
      new Request(`${BASE}/api/health/readiness`),
      new Request(`${BASE}/api/nothing-here`),
    ]
    for (const request of answers) {
      const response = await site.fetch(request)
      expect({ path: new URL(request.url).pathname, headers: securityOf(response), cache: response.headers.has('cache-control') }).toEqual({
        path: new URL(request.url).pathname,
        headers: API_HEADERS,
        cache: true,
      })
    }
  })

  it('reports a database failure without its cause', async () => {
    const failing = app(() => Promise.reject(new Error('password authentication failed for user "secret_user"')))
    const failed = await failing.fetch(new Request(`${BASE}/api/health/readiness`))
    expect(failed.status).toBe(503)
    expect(await failed.text()).toBe('{"status":"unhealthy","services":{"database":{"status":"unhealthy"}}}')
    const healthy = await app().fetch(new Request(`${BASE}/api/health/readiness`))
    expect(healthy.status).toBe(200)
    expect(healthy.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate')
  })

  it('answers 503 with Retry-After and the security headers when no connection comes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = app(() => Promise.reject(new Error('timeout exceeded when trying to connect')))
    for (const path of ['/api/rpc', '/api/mcp', '/household/expenses/export/csv']) {
      const response = await failing.fetch(new Request(`${BASE}${path}`, path === '/api/rpc' ? { method: 'POST', headers: { origin: BASE }, body: '[]' } : {}))
      expect({ path, status: response.status, retry: response.headers.get('retry-after') }).toEqual({ path, status: 503, retry: '5' })
      expect(response.headers.get('content-security-policy')).toBe(API_HEADERS['Content-Security-Policy'])
      expect(await response.json()).toEqual({ error: 'AgentSplit is temporarily unavailable. Try again in a moment.' })
    }
    error.mockRestore()
  })
})
