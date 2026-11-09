// The hourly removal of used idempotency keys (src/server/idempotency.ts). A
// key removed too early fails silently: a client's retry then writes twice.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IDEMPOTENCY_KEY_DAYS, removeExpiredIdempotencyKeys } from '~/server/idempotency'
import { startHarness, type Harness } from './harness'

let h: Harness
beforeAll(async () => {
  h = await startHarness()
})
afterAll(() => h.close())

describe('used idempotency keys', () => {
  it(`stay for ${IDEMPOTENCY_KEY_DAYS} days, then the hourly job removes them`, async () => {
    const row = (data: { key: string; ageHours: number }) =>
      sql`('expiry-test:web', ${data.key}, 'hash', '{}'::jsonb, now() - make_interval(hours => ${data.ageHours}))`
    await h.withDb((db) =>
      db.execute(sql`INSERT INTO idempotency_keys (principal, key, request_hash, response, created_at) VALUES
        ${row({ key: 'old', ageHours: IDEMPOTENCY_KEY_DAYS * 24 + 1 })},
        ${row({ key: 'recent', ageHours: IDEMPOTENCY_KEY_DAYS * 24 - 1 })}`),
    )
    expect(await h.withDb((db) => removeExpiredIdempotencyKeys(db))).toBe(1)
    const left = await h.withDb((db) => db.execute<{ key: string }>(sql`SELECT key FROM idempotency_keys WHERE principal = 'expiry-test:web'`))
    expect(left.rows.map((r) => r.key)).toEqual(['recent'])
  })
})
