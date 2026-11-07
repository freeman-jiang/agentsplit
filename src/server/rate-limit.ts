// Per-user token buckets in PostgreSQL, shared by every request, credential
// and process of a user, so a restart does not reset them. One statement takes
// a token or refuses, atomically, with the database clock. The MCP request
// budget and the write budget use the same code.
import { sql } from 'drizzle-orm'
import { LIMITS } from '../shared/limits'
import type { Db } from './db'

/** Takes one token from the user's bucket in `table`. Returns 0 when allowed, else the whole seconds to wait. */
async function takeToken(
  db: Db,
  data: { table: 'mcp_rate_limits' | 'write_rate_limits'; userId: string; capacity: number; periodSeconds: number },
): Promise<number> {
  const { capacity, periodSeconds } = data
  const rate = capacity / periodSeconds
  // In SET, b is the stored row and excluded carries this request's clock.
  const refilled = sql`least(${capacity}::float8, b.tokens + greatest(0, extract(epoch FROM excluded.updated_at - b.updated_at)::float8) * ${rate}::float8)`
  const result = await db.execute<{ tokens: number; allowed: boolean }>(sql`
    INSERT INTO ${sql.identifier(data.table)} AS b (user_id, tokens, updated_at, allowed)
    VALUES (${data.userId}, ${capacity - 1}, clock_timestamp(), true)
    ON CONFLICT (user_id) DO UPDATE SET
      tokens = CASE WHEN ${refilled} >= 1 THEN ${refilled} - 1 ELSE ${refilled} END,
      allowed = ${refilled} >= 1,
      updated_at = excluded.updated_at
    RETURNING b.tokens, b.allowed
  `)
  const row = result.rows[0]
  if (!row) throw new Error('Rate limit row missing')
  if (row.allowed) return 0
  return Math.ceil((1 - row.tokens) / rate)
}

/**
 * Takes one write from the user's budget (LIMITS.writesPerMinute), shared by
 * the web app and every agent credential. Run it outside the write's
 * transaction, so a refused or rolled-back write still counts and concurrent
 * writes do not conflict on the bucket row.
 */
export const takeWrite = (db: Db, userId: string) => takeToken(db, { table: 'write_rate_limits', userId, capacity: LIMITS.writesPerMinute, periodSeconds: 60 })

/**
 * Takes one request from the user's MCP budget (LIMITS.mcpRequestsPerMinute):
 * the current app's token bucket, kept in PostgreSQL so that every process
 * shares it (DECISIONS.md, P-MCP-85).
 */
export const takeMcpRequest = (db: Db, userId: string) =>
  takeToken(db, { table: 'mcp_rate_limits', userId, capacity: LIMITS.mcpRequestsPerMinute, periodSeconds: 60 })
