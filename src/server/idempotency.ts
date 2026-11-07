// Idempotency keys: a write runs once per (principal, key).
import { and, eq, sql } from 'drizzle-orm'
import { idempotencyKeys } from '../../db/schema/app'
import { Invalid } from '../shared/api'
import type { Principal } from './access'
import type { Db } from './db'
import { sha256Hex } from './ids'

/** The principal column of a key: a person on the web and each of their agent credentials keep separate keys. */
export const idempotencyPrincipal = (principal: Principal) => `${principal.userId}:${principal.agentKeyId ?? 'web'}`

/** A used idempotency key: the hash of its request, and the stored result (any JSON value). */
export type StoredRequest = { readonly requestHash: string; readonly response: unknown }

/** The stored request of `key` as one JSON value, or NULL, for a statement that reads it with other rows. */
export const storedRequestJson = (data: { principal: Principal; key: string }) =>
  sql`(SELECT json_build_object('requestHash', k.request_hash, 'response', k.response) FROM idempotency_keys k
    WHERE k.principal = ${idempotencyPrincipal(data.principal)} AND k.key = ${data.key})`

/**
 * Runs a write once per (principal, key). A retry with the same request gets
 * the stored result; the same key with a different request is refused. A
 * caller without a key (null) can never retry, so it skips the lookup and the
 * stored row. `previous` is the lookup, when the caller already read it.
 */
export async function idempotent<A>(
  tx: Db,
  data: { principal: Principal; key: string | null; request: unknown; previous?: StoredRequest | null },
  write: () => Promise<A>,
): Promise<A> {
  if (data.key === null) return write()
  const principal = idempotencyPrincipal(data.principal)
  const requestHash = sha256Hex(JSON.stringify(data.request))
  const [previous] =
    data.previous === undefined
      ? await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, data.key)))
      : data.previous
        ? [data.previous]
        : []
  if (previous) {
    if (previous.requestHash !== requestHash) throw new Invalid({ message: 'This idempotency key was used for a different request', field: 'idempotencyKey' })
    return previous.response as A
  }
  const result = await write()
  await tx.insert(idempotencyKeys).values({ principal, key: data.key, requestHash, response: result as object })
  return result
}
