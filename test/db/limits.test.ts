// The fair-use limits other than receipt storage, against a real database. A
// broken write budget, sign-up cap, key cap or registration limit fails
// silently until someone abuses it, so each has a test.
import { APIError } from 'better-call'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../../db/schema/auth'
import { checkSignUpCap } from '~/server/auth/auth'
import { takeWrite } from '~/server/rate-limit'
import { LIMITS, SIGN_UP_LIMIT_CODE } from '~/shared/limits'
import { BASE, failure, startHarness, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
  for (const id of ['gail', 'hank']) await h.account(id)
})
afterAll(() => h.close())

describe('other limits', () => {
  it('allows about 60 writes a minute per user across the web app and agents', async () => {
    const key = { 'x-api-key': await h.apiKey('gail') }
    // The bucket refills one write per second, so a slow run may take a few more than 60.
    let taken = 0
    while ((await h.withDb((db) => takeWrite(db, 'gail'))) === 0) taken++
    expect(taken).toBeGreaterThanOrEqual(LIMITS.writesPerMinute)
    expect(taken).toBeLessThanOrEqual(LIMITS.writesPerMinute + 3)
    const refused = await failure(h, { name: 'update_profile', args: { name: 'Too fast' }, headers: key })
    expect(refused).toMatchObject({ code: 'TOO_MANY_REQUESTS', outcomeUnknown: false, recovery: 'retry_later' })
    expect(refused.message).toMatch(/^You're making changes too quickly\. Wait 1 second and try again\./)
    const [row] = await h.withDb((db) => db.select({ name: user.name }).from(user).where(eq(user.id, 'gail')))
    expect(row?.name).toBe('gail')
    // Another user's budget is separate.
    expect(await h.withDb((db) => takeWrite(db, 'hank'))).toBe(0)
  })

  it('caps new accounts per 24 hours, and older accounts do not count', async () => {
    const recent = await h.withDb(async (db) => (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user" WHERE created_at > now() - interval '24 hours'`)).rows[0]?.n ?? 0)
    await expect(h.withDb((db) => checkSignUpCap(db, recent + 1))).resolves.toBeUndefined()
    const refused = await h.withDb((db) => checkSignUpCap(db, recent)).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(APIError)
    expect(refused).toMatchObject({ body: { code: SIGN_UP_LIMIT_CODE } })
    const old = new Date(Date.now() - 2 * 86_400_000)
    await h.withDb((db) => db.insert(user).values({ id: 'old-user', name: 'Old', email: 'old@example.com', emailVerified: true, createdAt: old, updatedAt: old }))
    await expect(h.withDb((db) => checkSignUpCap(db, recent + 1))).resolves.toBeUndefined()
  })

  it('caps API keys per account, also for keys made by a server call', async () => {
    await h.account('ivan')
    for (let i = 0; i < LIMITS.apiKeys; i++) await h.apiKey('ivan')
    await expect(h.apiKey('ivan')).rejects.toMatchObject({ body: { message: expect.stringMatching(/^You have 10 API keys/) } })
  })

  it('rate-limits OAuth dynamic client registration per IP address', async () => {
    const register = (ip: string) =>
      h.fetch(
        new Request(`${BASE}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({
            client_name: 'Agent',
            redirect_uris: ['http://127.0.0.1/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            application_type: 'native',
          }),
        }),
      )
    for (let i = 0; i < LIMITS.clientRegistrationsPerHour; i++) expect((await register('203.0.113.7')).status).toBeLessThan(300)
    expect((await register('203.0.113.7')).status).toBe(429)
    expect((await register('203.0.113.8')).status).toBeLessThan(300)
  })
})
