// API-key verification without building Better Auth. This is Better Auth's
// api-key plugin check (validateApiKey and claimUsageInDatabase in
// @better-auth/api-key 1.7.14) for the plugin settings in auth-options.ts:
// database storage, hashed keys, rate limiting on, no permissions, no custom
// validator and no deferred updates. test/db/mcp-auth.test.ts runs both on the
// same rows and requires the same answers and the same row changes.
import { and, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm'
import { apikey } from '../../../db/schema/auth'
import type { Db } from '../db'

type KeyRow = typeof apikey.$inferSelect

export type ApiKeyResult =
  | { readonly valid: true; readonly key: KeyRow }
  | { readonly valid: false; readonly code: 'INVALID_API_KEY' | 'KEY_DISABLED' | 'KEY_EXPIRED' | 'USAGE_EXCEEDED' }
  | { readonly valid: false; readonly code: 'RATE_LIMITED'; readonly tryAgainInMs: number }

/** Better Auth's defaultKeyHasher: base64url(sha256(key)) without padding. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const byId = (id: string) => eq(apikey.id, id)

async function fresh(db: Db, id: string): Promise<KeyRow | undefined> {
  const [row] = await db.select().from(apikey).where(byId(id))
  return row
}

/** Guarded quota use: one refill wins a compare-and-swap, then the decrement only applies above zero. */
async function consumeRemaining(db: Db, key: KeyRow): Promise<KeyRow | null> {
  const now = new Date()
  if (key.refillInterval && key.refillAmount) {
    const last = (key.lastRefillAt ?? key.createdAt).getTime()
    if (now.getTime() - last > key.refillInterval) {
      const [refilled] = await db
        .update(apikey)
        .set({ remaining: key.refillAmount - 1, lastRefillAt: now })
        .where(and(byId(key.id), key.lastRefillAt === null ? isNull(apikey.lastRefillAt) : eq(apikey.lastRefillAt, key.lastRefillAt)))
        .returning()
      if (refilled) return refilled
    }
  }
  const [decremented] = await db
    .update(apikey)
    .set({ remaining: sql`${apikey.remaining} - 1` })
    .where(and(byId(key.id), gt(apikey.remaining, 0)))
    .returning()
  return decremented ?? null
}

/** Guarded rate-limit use, as Better Auth's consumeRateLimit: a window counted from the latest request. */
async function consumeRateLimit(db: Db, key: KeyRow): Promise<KeyRow | { tryAgainInMs: number } | null> {
  const now = new Date()
  if (key.rateLimitEnabled === false) {
    const [row] = await db.update(apikey).set({ lastRequest: now }).where(byId(key.id)).returning()
    return row ?? key
  }
  const window = key.rateLimitTimeWindow
  const max = key.rateLimitMax
  if (window === null || max === null) return key
  if (key.lastRequest !== null) {
    const since = now.getTime() - key.lastRequest.getTime()
    const windowStart = new Date(now.getTime() - window)
    if (since <= window) {
      if ((key.requestCount ?? 0) >= max) return { tryAgainInMs: Math.ceil(window - since) }
      const [row] = await db
        .update(apikey)
        .set({ requestCount: sql`${apikey.requestCount} + 1`, lastRequest: now })
        .where(and(byId(key.id), gt(apikey.lastRequest, windowStart), lt(apikey.requestCount, max)))
        .returning()
      if (row) return row
      const again = await fresh(db, key.id)
      return again ? consumeRateLimit(db, again) : null
    }
    const [row] = await db.update(apikey).set({ requestCount: 1, lastRequest: now }).where(and(byId(key.id), lte(apikey.lastRequest, windowStart))).returning()
    if (row) return row
  } else {
    const [row] = await db.update(apikey).set({ requestCount: 1, lastRequest: now }).where(and(byId(key.id), isNull(apikey.lastRequest))).returning()
    if (row) return row
  }
  const again = await fresh(db, key.id)
  return again ? consumeRateLimit(db, again) : null
}

/** Verifies a raw API key and records its use, as `auth.api.verifyApiKey({ body: { key } })` does. */
export async function verifyApiKey(db: Db, rawKey: string): Promise<ApiKeyResult> {
  const [key] = await db
    .select()
    .from(apikey)
    .where(eq(apikey.key, await hashApiKey(rawKey)))
    .limit(1)
  if (!key) return { valid: false, code: 'INVALID_API_KEY' }
  if (key.enabled === false) return { valid: false, code: 'KEY_DISABLED' }
  if (key.expiresAt && Date.now() > key.expiresAt.getTime()) {
    await db.delete(apikey).where(byId(key.id))
    return { valid: false, code: 'KEY_EXPIRED' }
  }
  if (key.remaining === 0 && key.refillAmount === null) {
    await db.delete(apikey).where(byId(key.id))
    return { valid: false, code: 'USAGE_EXCEEDED' }
  }
  let row: KeyRow | null = key
  if (key.remaining !== null) {
    row = await consumeRemaining(db, key)
    if (!row) return { valid: false, code: 'USAGE_EXCEEDED' }
  }
  const limited = await consumeRateLimit(db, row)
  if (!limited) return { valid: false, code: 'INVALID_API_KEY' }
  if ('tryAgainInMs' in limited) return { valid: false, code: 'RATE_LIMITED', tryAgainInMs: limited.tryAgainInMs }
  const [final] = await db.update(apikey).set({ updatedAt: new Date() }).where(byId(limited.id)).returning()
  return final ? { valid: true, key: final } : { valid: false, code: 'INVALID_API_KEY' }
}
