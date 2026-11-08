// OAuth access tokens on the MCP endpoint. This is the check of the current
// app's src/lib/mcp/oauth-authenticate.ts, which used requireMcpAuth from
// @better-auth/mcp. requireMcpAuth fetches the JWKS over HTTP from the app's own
// /api/auth/jwks; this module runs the same Better Auth steps
// (verifyJwsAccessToken, enforceDpopBinding) with the key set read from the
// jwks table, as the jwt plugin serves it, so a request makes no HTTP call to
// the app itself. The live connection check is in oauth-connections.ts.
import {
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
  type DpopReplayStore,
} from 'better-auth/oauth2'
import { sql } from 'drizzle-orm'
import type { JWTPayload } from 'jose'
import type { Db } from '../core/db'
import { sha256Base64url } from '../core/ids'
import { mcpResource, OAUTH_CONNECTION_CLAIM, oauthIssuer } from './constants'
import { verifyConnection, type OAuthResult } from './oauth-connections'

/** The jwt plugin's default grace period for rotated keys: 30 days. */
const GRACE_MS = 2_592_000 * 1000

type JwkRow = { id: string; public_key: string; alg: string | null; crv: string | null; expires_ms: number | null }

/** The JWKS that /api/auth/jwks publishes (better-auth jwt plugin getJwks), read from the table. */
export async function loadJwks(db: Db) {
  const result = await db.execute<JwkRow>(sql`SELECT id, public_key, alg, crv, (extract(epoch FROM expires_at) * 1000)::float8 AS expires_ms FROM jwks`)
  const now = Date.now()
  return {
    keys: result.rows
      .filter((k) => k.expires_ms === null || k.expires_ms + GRACE_MS > now)
      .map((k) => ({ alg: k.alg ?? 'EdDSA', ...(k.crv ? { crv: k.crv } : {}), ...(JSON.parse(k.public_key) as Record<string, string>), kid: k.id })),
  }
}

/** One cache entry per process, with Better Auth's TTL and kid-miss refetch rules. */
const jwksCacheKey = {}

/**
 * Better Auth's createDpopReplayStore over internalAdapter.reserveVerificationValue:
 * a verification row whose ID is base64url(sha256("reserve:dpop-proof:" + key)).
 * A second insert of the same proof finds the row and fails, across processes.
 */
const reservationId = (identifier: string) => sha256Base64url(`reserve:${identifier}`)
/** The identifier prefix of a DPoP replay row, the same as Better Auth's. */
const DPOP_PROOF = 'dpop-proof:'
export const replayStore = (db: Db): DpopReplayStore => ({
  reserve: async ({ key, expiresAt }) => {
    const identifier = `${DPOP_PROOF}${key}`
    const result = await db.execute(sql`
      INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES (${reservationId(identifier)}, ${identifier}, ${key}, ${expiresAt}, now(), now())
      ON CONFLICT (id) DO NOTHING RETURNING id`)
    return result.rows.length === 1
  },
})

/**
 * Deletes the replay rows of DPoP proofs that expired an hour ago or more. A
 * proof is refused after its expiry by its own iat check, so its row is no
 * longer needed. The hour covers a clock difference between the server and
 * the database. Runs from the hourly job; returns the number of rows deleted.
 */
export async function removeExpiredDpopProofs(db: Db): Promise<number> {
  // A range on the prefix ("dpop-proof:" up to "dpop-proof;"), which the identifier index serves; LIKE cannot under the default collation.
  const result = await db.execute(
    sql`DELETE FROM verification WHERE identifier >= ${DPOP_PROOF} AND identifier < ${`${DPOP_PROOF.slice(0, -1)};`} AND expires_at < now() - interval '1 hour'`,
  )
  return result.rowCount ?? 0
}

/** jose's errors carry codes such as ERR_JWT_EXPIRED; PostgreSQL errors carry SQLSTATE codes. */
const isJoseError = (error: unknown) =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && /^ERR_J(W[STEK]|OSE)/.test(error.code)

const isScopeToken = (s: string) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)

/**
 * Verifies the request's OAuth access token, then the live connection, account,
 * client and consent. `dpop: false` leaves the DPoP proof to a later check of
 * the same request (Better Auth's UserInfo).
 */
export async function verifyOAuthRequest(db: Db, data: { request: Request; baseUrl: string; dpop?: boolean }): Promise<OAuthResult> {
  const { request, baseUrl } = data
  const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'))
  if (!authorization?.token || authorization.scheme === 'Unknown') return { kind: 'invalid' }
  let claims: JWTPayload
  try {
    claims = await verifyJwsAccessToken(authorization.token, {
      jwksFetch: () => loadJwks(db),
      jwksCacheKey,
      verifyOptions: { issuer: oauthIssuer(baseUrl), audience: mcpResource(baseUrl), requiredClaims: ['azp'] },
    })
    if (data.dpop !== false)
      await enforceDpopBinding({
        payload: claims,
        authorization,
        proofJwt: request.headers.get('dpop'),
        method: request.method,
        url: request.url,
        replayStore: replayStore(db),
      })
  } catch (error) {
    // A bad, expired or unbound token is a 401. Anything else (the database) is an outage.
    if (isDpopBindingError(error) || isJoseError(error)) return { kind: 'invalid' }
    throw error
  }
  const connectionId = claims[OAUTH_CONNECTION_CLAIM]
  const { sub, scope } = claims
  const clientId = claims['client_id']
  if (typeof connectionId !== 'string' || typeof sub !== 'string' || typeof clientId !== 'string' || typeof scope !== 'string') return { kind: 'invalid' }
  // Better Auth rejects a malformed scope claim before any other check.
  if (!scope || scope.split(' ').some((s) => !isScopeToken(s))) return { kind: 'invalid' }
  return verifyConnection(db, { connectionId, userId: sub, clientId, scope })
}
