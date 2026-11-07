// The per-user MCP request budget (LIMITS.mcpRequestsPerMinute): the current
// app's token bucket, kept in PostgreSQL so that every process shares it
// (DECISIONS.md, P-MCP-85). The bucket code is in
// src/server/rate-limit.ts.
import { LIMITS } from '../../shared/limits'
import type { Db } from '../db'
import { takeToken } from '../rate-limit'

/** Takes one request from the user's bucket. Returns 0 when allowed, else the whole seconds to wait. */
export const takeMcpRequest = (db: Db, userId: string): Promise<number> =>
  takeToken(db, { table: 'mcp_rate_limits', userId, capacity: LIMITS.mcpRequestsPerMinute, periodSeconds: 60 })
