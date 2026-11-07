// The per-user MCP request budget: the current app's token bucket (120
// requests, refilled at 2 per second), kept in PostgreSQL so that every Worker
// isolate shares it (DECISIONS.md, P-MCP-85). One statement takes a token or
// refuses, atomically, with the database clock.
import { sql } from 'drizzle-orm'
import type { Db } from '../db'

export const MCP_BUCKET = { capacity: 120, periodSeconds: 60 } as const

/** Takes one request from the user's bucket. Returns 0 when allowed, else the whole seconds to wait. */
export async function takeMcpRequest(db: Db, userId: string): Promise<number> {
  const { capacity, periodSeconds } = MCP_BUCKET
  const rate = capacity / periodSeconds
  // In SET, b is the stored row and excluded carries this request's clock.
  const refilled = sql`least(${capacity}::float8, b.tokens + greatest(0, extract(epoch FROM excluded.updated_at - b.updated_at)::float8) * ${rate}::float8)`
  const result = await db.execute<{ tokens: number; allowed: boolean }>(sql`
    INSERT INTO mcp_rate_limits AS b (user_id, tokens, updated_at, allowed)
    VALUES (${userId}, ${capacity - 1}, clock_timestamp(), true)
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
