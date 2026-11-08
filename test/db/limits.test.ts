// The fair-use limits other than receipt storage, against a real database. A
// broken write budget, sign-up cap, key cap or registration limit fails
// silently until someone abuses it, so each has a test.
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../../db/schema/auth'
import { createAuth } from '~/server/auth/auth'
import { takeWrite } from '~/server/rate-limit'
import { apiKeyLimitMessage, LIMITS, SIGN_UP_LIMIT_CODE } from '~/shared/limits'
import { testSettings } from '../kit/config'
import { BASE, failure, startHarness, type Harness } from './harness'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
})
afterAll(() => h.close())

describe('other limits', () => {
  it('allows 60 writes a minute per user, refilled one a second, at a fixed clock', async () => {
    for (const id of ['gail', 'hank']) await h.account(id)
    const at = new Date('2026-11-05T12:00:00.000Z')
    const take = (userId: string, time: Date) => h.withDb((db) => takeWrite(db, { userId, at: time }))
    for (let i = 0; i < LIMITS.writesPerMinute; i++) expect(await take('gail', at)).toBe(0)
    expect(await take('gail', at)).toBe(1)
    // One second later exactly one more write fits.
    const later = new Date(at.getTime() + 1000)
    expect(await take('gail', later)).toBe(0)
    expect(await take('gail', later)).toBe(1)
    // Another user's budget is separate.
    expect(await take('hank', at)).toBe(0)
  })

  it('refuses a write over the budget through a tool, with the wait, and writes nothing', async () => {
    await h.account('ines')
    const key = { 'x-api-key': await h.apiKey('ines') }
    // Spent a minute ahead of the database clock, so the request below sees no refill.
    const ahead = new Date(Date.now() + 60_000)
    for (let i = 0; i < LIMITS.writesPerMinute; i++) await h.withDb((db) => takeWrite(db, { userId: 'ines', at: ahead }))
    const refused = await failure(h, { name: 'update_profile', args: { name: 'Too fast' }, headers: key })
    expect(refused).toMatchObject({ code: 'TOO_MANY_REQUESTS', outcomeUnknown: false, recovery: 'retry_later' })
    expect(refused.message).toMatch(/^You're making changes too quickly\. Wait 1 second and try again\./)
    const [row] = await h.withDb((db) => db.select({ name: user.name }).from(user).where(eq(user.id, 'ines')))
    expect(row?.name).toBe('ines')
  })

  it('caps new accounts per 24 hours when Better Auth creates one, and older accounts do not count', async () => {
    const recent = await h.withDb(async (db) => (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user" WHERE created_at > now() - interval '24 hours'`)).rows[0]?.n ?? 0)
    /** A sign-up as Better Auth makes it, through its database hooks, with room for one more account than there is now. */
    const signUp = (email: string) =>
      h.withDb(async (db) => {
        const auth = createAuth({ ...testSettings({ signUpDailyLimit: recent + 1 }), db })
        return (await auth.$context).internalAdapter.createUser({ email, name: 'New', emailVerified: true }, { method: 'oauth' })
      })
    await expect(signUp('first-new@example.com')).resolves.toMatchObject({ email: 'first-new@example.com' })
    await expect(signUp('second-new@example.com')).rejects.toMatchObject({ body: { code: SIGN_UP_LIMIT_CODE } })
    // The first account, created two days ago instead, no longer counts.
    await h.withDb((db) => db.update(user).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(user.email, 'first-new@example.com')))
    await expect(signUp('second-new@example.com')).resolves.toMatchObject({ email: 'second-new@example.com' })
  })

  it('caps API keys per account, also for keys made by a server call', async () => {
    await h.account('ivan')
    for (let i = 0; i < LIMITS.apiKeys; i++) await h.apiKey('ivan')
    await expect(h.apiKey('ivan')).rejects.toMatchObject({ body: { message: apiKeyLimitMessage } })
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
