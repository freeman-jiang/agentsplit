// The MCP path verifies credentials without building Better Auth. These tests
// hold it to Better Auth's own answers on the same rows.
import { DPOP_SIGNING_ALGORITHMS } from 'better-auth/oauth2'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apikey } from '../../db/schema/auth'
import { verifyApiKey } from '~/server/auth/api-key'
import { readApiKey } from '~/server/auth/authenticate'
import { DPOP_ALGORITHMS, protectedResourceMetadata } from '~/server/auth/challenge'
import { sha256Base64url } from '~/server/core/ids'
import { BASE, startHarness, type Harness } from './mcp-harness'

// These tests create many API keys for one account; the fair-use cap has its own test (test/db/limits.test.ts).
vi.mock('~/shared/limits', async (original) => {
  const limits = await original<typeof import('~/shared/limits')>()
  return { ...limits, LIMITS: { ...limits.LIMITS, apiKeys: 1000 } }
})

let h: Harness
beforeAll(async () => {
  h = await startHarness()
  await h.account('alice')
})
afterAll(() => h.close())

describe('copied Better Auth values', () => {
  it('lists the DPoP algorithms Better Auth accepts', () => {
    expect([...DPOP_ALGORITHMS]).toEqual([...DPOP_SIGNING_ALGORITHMS])
  })
})

describe('protected-resource metadata', () => {
  it('lists offline_access with the read and write scopes, on GET and HEAD', async () => {
    const r = protectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`), BASE)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: `${BASE}/api/mcp`,
      authorization_servers: [`${BASE}/api/auth`],
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: ['EdDSA', 'ES256', 'ES512', 'PS256', 'RS256'],
      scopes_supported: ['agentsplit:read', 'agentsplit:write', 'offline_access'],
    })
    const head = protectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource`, { method: 'HEAD' }), BASE)
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(protectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource`, { method: 'POST' }), BASE).status).toBe(405)
  })

  it('differs from Better Auth’s own document only by offline_access', async () => {
    const theirs = await h.auth(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`))
    expect(theirs.status).toBe(200)
    const body = (await theirs.json()) as { scopes_supported: string[] }
    const ours = (await protectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`), BASE).json()) as Record<string, unknown>
    expect({ ...body, scopes_supported: [...body.scopes_supported, 'offline_access'] }).toEqual(ours)
  })
})

describe('API key headers', () => {
  const key = `agentsplit_${'k'.repeat(40)}`
  const other = `agentsplit_${'o'.repeat(40)}`
  const read = (headers: Record<string, string>) => readApiKey(new Headers(headers))
  it('reads the raw key from X-API-Key or Bearer, and refuses ambiguity', () => {
    expect(read({ 'x-api-key': key })).toBe(key)
    expect(read({ 'X-API-KEY': key })).toBe(key)
    expect(read({ authorization: `Bearer ${key}` })).toBe(key)
    expect(read({ authorization: `bearer ${key}` })).toBe(key)
    expect(read({ 'x-api-key': key, authorization: `Bearer ${key}` })).toBe(key)
    expect(read({ 'x-api-key': key, authorization: `Bearer ${other}` })).toBeUndefined()
    // A malformed second header never falls back to the valid one.
    for (const authorization of [`Basic ${key}`, `Bearer ${key} extra`, `Bearer a,b${key}`, 'Bearer short', `Bearer ${'x'.repeat(4097)}`])
      expect(read({ 'x-api-key': key, authorization })).toBeUndefined()
    expect(read({ 'x-api-key': `${key},${key}` })).toBeUndefined()
    expect(read({})).toBeUndefined()
  })
})

describe('API key verification', () => {
  /** Two keys with the same row state: Better Auth verifies one, the MCP path the other. */
  async function twins(state: Partial<typeof apikey.$inferInsert>) {
    const created = await h.authApi(async (api) => [await api.createApiKey({ body: { userId: 'alice' } }), await api.createApiKey({ body: { userId: 'alice' } })])
    if (Object.keys(state).length) for (const k of created) await h.withDb((db) => db.update(apikey).set(state).where(eq(apikey.id, k.id)))
    return { theirs: created[0]!, ours: created[1]! }
  }
  const row = (id: string) => h.withDb(async (db) => (await db.select().from(apikey).where(eq(apikey.id, id)))[0] ?? null)
  /** The fields a verification may change, with times reduced to whether they moved. */
  const state = (r: typeof apikey.$inferSelect | null, before: typeof apikey.$inferSelect | null) =>
    r && {
      requestCount: r.requestCount,
      remaining: r.remaining,
      lastRequestMoved: r.lastRequest?.getTime() !== before?.lastRequest?.getTime(),
      lastRefillMoved: r.lastRefillAt?.getTime() !== before?.lastRefillAt?.getTime(),
      enabled: r.enabled,
    }

  const now = () => new Date()
  const ago = (ms: number) => new Date(Date.now() - ms)
  const cases: [string, Partial<typeof apikey.$inferInsert>][] = [
    ['a new key', {}],
    ['a disabled key', { enabled: false }],
    ['an expired key', { expiresAt: ago(1000) }],
    ['a key that expires later', { expiresAt: new Date(Date.now() + 3_600_000) }],
    ['a key inside its window', { lastRequest: ago(5_000), requestCount: 7 }],
    ['a key at its limit', { lastRequest: ago(5_000), requestCount: 120 }],
    ['a key whose window has passed', { lastRequest: ago(61_000), requestCount: 120 }],
    ['a key without rate limiting', { rateLimitEnabled: false, lastRequest: ago(5_000), requestCount: 500 }],
    ['a key without a limit window', { rateLimitTimeWindow: null }],
    ['a key with quota left', { remaining: 2 }],
    ['a key with no quota and no refill', { remaining: 0 }],
    ['a key whose quota refills', { remaining: 0, refillAmount: 5, refillInterval: 1000, lastRefillAt: ago(5_000) }],
    ['a key whose quota refills later', { remaining: 0, refillAmount: 5, refillInterval: 3_600_000, lastRefillAt: now() }],
  ]

  it.each(cases)('answers as Better Auth for %s', async (_name, initial) => {
    const { theirs, ours } = await twins(initial)
    const [beforeTheirs, beforeOurs] = [await row(theirs.id), await row(ours.id)]
    const expected = await h.authApi((api) => api.verifyApiKey({ body: { key: theirs.key } }))
    const actual = await h.withDb((db) => verifyApiKey(db, ours.key))
    expect(actual.valid).toBe(expected.valid)
    if (!actual.valid) {
      // Better Auth reports the reason through error.code.
      const code = (expected.error as { code?: string } | null)?.code
      expect({ ours: actual.code }).toEqual({ ours: code === 'KEY_NOT_FOUND' ? 'INVALID_API_KEY' : code })
    } else expect(actual.key.referenceId).toBe(expected.key?.referenceId)
    expect(state(await row(ours.id), beforeOurs)).toEqual(state(await row(theirs.id), beforeTheirs))
  })

  it('refuses an unknown key and stores the same hash Better Auth stores', async () => {
    expect(await h.withDb((db) => verifyApiKey(db, `agentsplit_${'z'.repeat(40)}`))).toEqual({ valid: false, code: 'INVALID_API_KEY' })
    const created = await h.authApi((api) => api.createApiKey({ body: { userId: 'alice' } }))
    expect((await row(created.id))?.key).toBe(sha256Base64url(created.key))
    expect(created.key.startsWith('agentsplit_')).toBe(true)
    expect((await row(created.id))?.expiresAt).toBeNull()
  })

  it('says how long a rate-limited key waits', async () => {
    const { ours } = await twins({ lastRequest: ago(20_000), requestCount: 120 })
    const result = await h.withDb((db) => verifyApiKey(db, ours.key))
    expect(result).toMatchObject({ valid: false, code: 'RATE_LIMITED' })
    if (!result.valid && result.code === 'RATE_LIMITED') expect(result.tryAgainInMs).toBeGreaterThan(39_000)
  })
})
