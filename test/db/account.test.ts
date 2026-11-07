// The account area against a real database: profile, API keys through Better
// Auth, connected apps, consent clients, the owner bootstrap, and the
// security rules that sign-in and the server rely on.
import { serializeSignedCookie } from 'better-call'
import { and, eq } from 'drizzle-orm'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authBootstrap, groups, legacyGroupClaims, memberships, oauthConnections } from '../../db/schema/app'
import * as auth from '../../db/schema/auth'
import { bootstrapOwner, consentClient, getAccount, revokeApiKey, revokeConnection, updateProfile } from '~/server/account'
import { createAuth } from '~/server/auth'
import { makeDb, type Db } from '~/server/db'
import type { Principal } from '~/server/ledger'
import { CONTENT_SECURITY_POLICY, readinessResponse } from '~/server/security'
import { safeNextPath } from '~/shared/account'
import { Forbidden, Invalid, NotFound } from '~/shared/api'
import { resetTestDatabase } from './setup'

const secret = 'test-secret-0123456789-0123456789-0123456789'
const baseUrl = 'http://localhost:5185'
let pool: Pool
let client: PoolClient
let db: Db

const principal = (userId: string): Principal => ({ userId, name: userId, email: `${userId}@example.com`, source: 'web', agentKeyId: null })
const alice = principal('alice')
const bob = principal('bob')
const day = (n: number) => new Date(Date.UTC(2026, 10, n))

const makeAuth = (bootstrapEmail?: string) =>
  createAuth({ db, baseUrl, secret, googleClientId: 'test-client', googleClientSecret: 'test-secret', bootstrapEmail })

async function sessionHeaders(userId: string): Promise<Headers> {
  const token = `token-${userId}-${crypto.randomUUID()}`
  const now = new Date()
  await db.insert(auth.session).values({ id: token, token, userId, expiresAt: new Date(Date.now() + 3_600_000), createdAt: now, updatedAt: now })
  const cookie = (await serializeSignedCookie('better-auth.session_token', token, secret)).split(';')[0] ?? ''
  return new Headers({ cookie, origin: baseUrl })
}

beforeAll(async () => {
  pool = await resetTestDatabase()
  client = await pool.connect()
  db = makeDb(client)
  const now = new Date()
  await db.insert(auth.user).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.com', emailVerified: true, createdAt: now, updatedAt: now },
    { id: 'bob', name: 'Bob', email: 'bob@example.com', emailVerified: true, createdAt: now, updatedAt: now },
    { id: 'unverified', name: 'U', email: 'u@example.com', emailVerified: false, createdAt: now, updatedAt: now },
  ])
})
afterAll(async () => {
  client.release()
  await pool.end()
})

describe('profile', () => {
  it('trims the name and changes only the caller', async () => {
    const result = await updateProfile(db, { principal: alice, name: '  Alice Liddell  ' })
    expect(result).toEqual({ profile: { id: 'alice', name: 'Alice Liddell', email: 'alice@example.com', emailVerified: true } })
    const [other] = await db.select({ name: auth.user.name }).from(auth.user).where(eq(auth.user.id, 'bob'))
    expect(other?.name).toBe('Bob')
  })

  it('accepts 1 to 50 characters after trimming', async () => {
    await expect(updateProfile(db, { principal: alice, name: '   ' })).rejects.toBeInstanceOf(Invalid)
    await expect(updateProfile(db, { principal: alice, name: 'x'.repeat(51) })).rejects.toBeInstanceOf(Invalid)
    expect((await updateProfile(db, { principal: alice, name: 'x'.repeat(50) })).profile.name).toHaveLength(50)
    await updateProfile(db, { principal: alice, name: 'Alice' })
  })

  it('refuses an unverified account', async () => {
    const error = await updateProfile(db, { principal: principal('unverified'), name: 'New' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Forbidden)
    expect((error as Forbidden).message).toBe('Verify your email before setting your display name.')
  })
})

describe('API keys', () => {
  it('creates keys through Better Auth with the current prefix, rate limit and owner', async () => {
    const created = await makeAuth().api.createApiKey({ body: { name: 'My Codex' }, headers: await sessionHeaders('alice') })
    expect(created.key.startsWith('agentsplit_')).toBe(true)
    const [row] = await db.select().from(auth.apikey).where(eq(auth.apikey.id, created.id))
    expect(row).toMatchObject({
      referenceId: 'alice',
      name: 'My Codex',
      prefix: 'agentsplit_',
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 120,
      expiresAt: null,
    })
    // Only the hash is stored.
    expect(row?.key).not.toContain(created.key)
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(true)
  })

  it('refuses names over 32 characters', async () => {
    await expect(makeAuth().api.createApiKey({ body: { name: 'x'.repeat(33) }, headers: await sessionHeaders('alice') })).rejects.toThrow()
  })

  it('refuses to create a key with a key instead of a session', async () => {
    const created = await makeAuth().api.createApiKey({ body: { name: 'Agent' }, headers: await sessionHeaders('bob') })
    const asKey = new Headers({ 'x-api-key': created.key, origin: baseUrl })
    await expect(makeAuth().api.createApiKey({ body: { name: 'Minted' }, headers: asKey })).rejects.toThrow()
    expect(await makeAuth().api.getSession({ headers: asKey })).toBeNull()
  })

  it('lists only the caller’s keys, newest first, without the key', async () => {
    const account = await getAccount(db, { principal: alice })
    expect(account.apiKeys.map((k) => k.name)).toEqual(['My Codex'])
    expect(Object.keys(account.apiKeys[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'start'])
    // Better Auth stores the first characters of the key for recognition.
    expect('agentsplit_'.startsWith(account.apiKeys[0]?.start ?? 'missing')).toBe(true)
    expect(account.apiKeys[0]?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  it('revokes only the caller’s own key, and a revoked key stops working', async () => {
    const created = await makeAuth().api.createApiKey({ body: { name: 'Temp' }, headers: await sessionHeaders('alice') })
    await expect(revokeApiKey(db, { principal: bob, keyId: created.id })).rejects.toBeInstanceOf(NotFound)
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(true)
    expect(await revokeApiKey(db, { principal: alice, keyId: created.id })).toEqual({ revoked: true })
    expect((await makeAuth().api.verifyApiKey({ body: { key: created.key } })).valid).toBe(false)
  })
})

describe('connected apps', () => {
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
    const connection = (id: string, clientId: string, scopes: string[], createdAt: Date, revokedAt: Date | null = null) => ({
      id,
      authorizationCodeId: `code-${id}`,
      userId: 'alice',
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
    ])
    const consent = (clientId: string, scopes: string[]) => ({ id: `consent-${clientId}`, clientId, userId: 'alice', scopes, createdAt: day(1) })
    await db.insert(auth.oauthConsent).values([
      consent('chatgpt', ['agentsplit:read', 'agentsplit:write', 'offline_access']),
      // Consent reduced to read only after the grant: write is gone at once.
      consent('reader', ['agentsplit:read']),
      consent('revoked', ['agentsplit:read']),
    ])
    await db.insert(auth.oauthRefreshToken).values({ id: 'r1', token: 'hash-r1', clientId: 'chatgpt', userId: 'alice', scopes: ['agentsplit:read'] })
    await db.insert(auth.oauthAccessToken).values({ id: 'a1', token: 'hash-a1', clientId: 'chatgpt', userId: 'alice', scopes: ['agentsplit:read'] })
  })

  it('lists unrevoked, consented clients once, newest connection first', async () => {
    const account = await getAccount(db, { principal: alice })
    expect(account.connections).toEqual([
      { clientId: 'reader', name: 'Connected app', canWrite: false },
      { clientId: 'chatgpt', name: 'ChatGPT', canWrite: true },
    ])
    expect((await getAccount(db, { principal: bob })).connections).toEqual([])
  })

  it('revokes with a tombstone and deletes the tokens and consent', async () => {
    expect(await revokeConnection(db, { principal: alice, clientId: 'chatgpt' })).toEqual({ revoked: true })
    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, 'c1'))
    expect(connection?.revokedAt).toBeInstanceOf(Date)
    for (const table of [auth.oauthAccessToken, auth.oauthRefreshToken, auth.oauthConsent])
      expect(await db.select().from(table).where(and(eq(table.userId, 'alice'), eq(table.clientId, 'chatgpt')))).toEqual([])
    // Other clients and the user's API keys are untouched.
    expect((await getAccount(db, { principal: alice })).connections.map((c) => c.clientId)).toEqual(['reader'])
    expect((await getAccount(db, { principal: alice })).apiKeys).toHaveLength(1)
  })

  it('names a known, enabled client on the consent page', async () => {
    expect(await consentClient(db, { clientId: 'reader' })).toEqual({ clientId: 'reader', name: null })
    expect(await consentClient(db, { clientId: 'disabled' })).toBeNull()
    expect(await consentClient(db, { clientId: 'unknown' })).toBeNull()
  })
})

describe('owner bootstrap', () => {
  beforeAll(async () => {
    const now = new Date()
    await db.insert(auth.user).values([
      { id: 'owner', name: 'Owner', email: 'Owner@Example.com', emailVerified: true, createdAt: now, updatedAt: now },
      { id: 'impostor', name: 'I', email: 'owner@example.org', emailVerified: false, createdAt: now, updatedAt: now },
    ])
    await db.insert(groups).values([
      { id: 'legacy-1', kind: 'named', name: 'Legacy 1', defaultCurrency: 'USD' },
      { id: 'legacy-2', kind: 'named', name: 'Legacy 2', defaultCurrency: 'USD' },
      { id: 'later', kind: 'named', name: 'Later', defaultCurrency: 'USD' },
    ])
    await db.insert(legacyGroupClaims).values([{ groupId: 'legacy-1' }, { groupId: 'legacy-2' }])
    // An earlier, removed membership is reactivated as admin.
    await db.insert(memberships).values({ userId: 'owner', groupId: 'legacy-2', role: 'member', active: false })
  })

  const ownerMemberships = () =>
    db.select({ groupId: memberships.groupId, role: memberships.role, active: memberships.active }).from(memberships).where(eq(memberships.userId, 'owner'))

  it('ignores other and unverified emails', async () => {
    const user = { id: 'impostor', email: 'owner@example.com', emailVerified: false }
    expect(await bootstrapOwner(db, { user, bootstrapEmail: 'owner@example.com' })).toBe(false)
    expect(await bootstrapOwner(db, { user: { id: 'bob', email: 'bob@example.com', emailVerified: true }, bootstrapEmail: 'owner@example.com' })).toBe(false)
    expect(await db.select().from(authBootstrap)).toEqual([])
  })

  it('runs on sign-in, once, and grants only the claimed groups', async () => {
    const authWithOwner = makeAuth('  OWNER@example.com ')
    const context = await authWithOwner.$context
    await context.internalAdapter.createSession('owner')
    expect((await ownerMemberships()).sort((a, b) => a.groupId.localeCompare(b.groupId))).toEqual([
      { groupId: 'legacy-1', role: 'admin', active: true },
      { groupId: 'legacy-2', role: 'admin', active: true },
    ])
    // Removing a membership later never brings bootstrap back.
    await db.update(memberships).set({ active: false }).where(and(eq(memberships.userId, 'owner'), eq(memberships.groupId, 'legacy-1')))
    await context.internalAdapter.createSession('owner')
    const owner = { id: 'owner', email: 'Owner@Example.com', emailVerified: true }
    expect(await bootstrapOwner(db, { user: owner, bootstrapEmail: 'owner@example.com' })).toBe(false)
    expect((await ownerMemberships()).find((m) => m.groupId === 'legacy-1')?.active).toBe(false)
    expect(await db.select({ userId: authBootstrap.userId }).from(authBootstrap)).toEqual([{ userId: 'owner' }])
  })

  it('serializes concurrent runs', async () => {
    await db.delete(authBootstrap)
    const clients = await Promise.all([pool.connect(), pool.connect()])
    try {
      const owner = { id: 'owner', email: 'owner@example.com', emailVerified: true }
      const results = await Promise.all(clients.map((c) => bootstrapOwner(makeDb(c), { user: owner, bootstrapEmail: 'owner@example.com' })))
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally {
      for (const c of clients) c.release()
    }
  })

  it('never blocks sign-in when it fails', async () => {
    await db.delete(authBootstrap)
    // Make the marker insert fail, so the bootstrap transaction rolls back.
    await db.execute('ALTER TABLE auth_bootstrap ADD CONSTRAINT fail_for_test CHECK (false) NOT VALID')
    try {
      const context = await makeAuth('owner@example.com').$context
      const created = await context.internalAdapter.createSession('owner')
      expect(created?.userId).toBe('owner')
      expect(await db.select().from(authBootstrap)).toEqual([])
    } finally {
      await db.execute('ALTER TABLE auth_bootstrap DROP CONSTRAINT fail_for_test')
    }
  })
})

describe('sign-in destination', () => {
  it('keeps same-origin paths and refuses everything else', () => {
    expect(safeNextPath('/invite/abc?x=1#y')).toBe('/invite/abc?x=1#y')
    expect(safeNextPath('/macademia/expenses')).toBe('/macademia/expenses')
    for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'evil', '', '/\tx', '/sign-in?next=/x', null])
      expect(safeNextPath(bad)).toBeNull()
  })

  it('is checked by the server too: Better Auth refuses a foreign callback', async () => {
    // Better Auth limits sign-in starts per IP, with counters in the rate_limit table.
    const start = async (callbackURL: string) => {
      await db.delete(auth.rateLimit)
      return makeAuth().handler(
        new Request(`${baseUrl}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: baseUrl },
          body: JSON.stringify({ provider: 'google', callbackURL }),
        }),
      )
    }
    const ok = await start('/invite/abc')
    expect(ok.status).toBe(200)
    const { url } = (await ok.json()) as { url: string }
    const google = new URL(url)
    expect(google.host).toBe('accounts.google.com')
    expect((await db.select().from(auth.rateLimit)).length).toBeGreaterThan(0)
    // Better Auth's defaults repeat the configured scopes, as in the current app; the set is what counts.
    expect([...new Set(google.searchParams.get('scope')?.split(' '))].sort()).toEqual(['email', 'openid', 'profile'])
    for (const bad of ['/\\evil.example', '//evil.example', 'https://evil.example/']) expect({ bad, status: (await start(bad)).status }).toEqual({ bad, status: 403 })
  })

  it('refuses incomplete configuration', () => {
    expect(() => createAuth({ db, baseUrl, secret: 'short', googleClientId: 'a', googleClientSecret: 'b' })).toThrow(
      'Google sign-in is not configured',
    )
    expect(() => createAuth({ db, baseUrl, secret, googleClientId: '', googleClientSecret: 'b' })).toThrow('Google sign-in is not configured')
  })
})

describe('OAuth discovery', () => {
  const get = (path: string) => makeAuth().handler(new Request(`${baseUrl}${path}`))

  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp'])('serves %s', async (path) => {
    const response = await get(path)
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({ resource: `${baseUrl}/api/mcp`, authorization_servers: [`${baseUrl}/api/auth`] })
    expect(metadata['scopes_supported']).toEqual(['agentsplit:read', 'agentsplit:write'])
  })

  it('serves the authorization-server metadata', async () => {
    const response = await get('/.well-known/oauth-authorization-server/api/auth')
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: `${baseUrl}/api/auth`,
      authorization_endpoint: `${baseUrl}/api/auth/oauth2/authorize`,
      token_endpoint: `${baseUrl}/api/auth/oauth2/token`,
      registration_endpoint: `${baseUrl}/api/auth/oauth2/register`,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
    expect(metadata['code_challenge_methods_supported']).toContain('S256')
    expect(metadata['grant_types_supported']).toEqual(['authorization_code', 'refresh_token'])
    expect(metadata['token_endpoint_auth_methods_supported']).toEqual(
      expect.arrayContaining(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt']),
    )
  })

  it('answers HEAD', async () => {
    const response = await makeAuth().handler(new Request(`${baseUrl}/.well-known/oauth-protected-resource/api/mcp`, { method: 'HEAD' }))
    expect(response.status).toBe(200)
  })
})

describe('security headers and readiness', () => {
  it('allows no inline or eval scripts', () => {
    const scripts = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'))
    expect(scripts).toBe("script-src 'self'")
  })

  it('reports a database failure without its cause', async () => {
    const failed = await readinessResponse(async () => {
      throw new Error('password authentication failed for user "secret_user"')
    })
    expect(failed.status).toBe(503)
    expect(await failed.text()).toBe('{"status":"unhealthy","services":{"database":{"status":"unhealthy"}}}')
    const healthy = await readinessResponse(async () => {
      await db.execute('SELECT 1')
    })
    expect(healthy.status).toBe(200)
    expect(healthy.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate')
  })
})
