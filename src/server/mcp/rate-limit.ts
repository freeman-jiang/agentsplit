// The per-user MCP request budget: the current app's token bucket (120
// requests, refilled at 2 per second), kept in PostgreSQL so that every
// process shares it (DECISIONS.md, P-MCP-85). The bucket code is in
// src/server/rate-limit.ts.
import type { Db } from '../db'
import { takeToken } from '../rate-limit'

export const MCP_BUCKET = { capacity: 120, periodSeconds: 60 } as const

/** Takes one request from the user's bucket. Returns 0 when allowed, else the whole seconds to wait. */
export const takeMcpRequest = (db: Db, userId: string): Promise<number> => takeToken(db, { table: 'mcp_rate_limits', userId, ...MCP_BUCKET })
