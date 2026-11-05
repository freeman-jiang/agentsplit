// OAuth access tokens on the MCP endpoint. This is the check of the current
// app's src/lib/mcp/oauth-authenticate.ts, which used requireMcpAuth from
// @better-auth/mcp. requireMcpAuth fetches the JWKS over HTTP from the app's own
// /api/auth/jwks, and a Worker cannot fetch its own hostname. So this module
// runs the same Better Auth steps (verifyJwsAccessToken, enforceDpopBinding)
// with a key set read from the jwks table, as the jwt plugin serves it.
import {
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
  type DpopReplayStore,
} from 'better-auth/oauth2'
import { sql } from 'drizzle-orm'
import type { JWTPayload } from 'jose'
import type { Db } from '../db'
import { mcpResource, OAUTH_CONNECTION_CLAIM, OAUTH_READ_SCOPE, oauthIssuer } from './constants'

export type OAuthResult =
  | { readonly kind: 'ok'; readonly userId: string; readonly name: string; readonly email: string; readonly connectionId: string; readonly scopes: readonly string[] }
  /** Missing, invalid, expired or revoked: answer with the 401 challenge. */
  | { readonly kind: 'invalid' }
  /** Valid, but read access is no longer granted: answer 403 insufficient_scope. */
  | { readonly kind: 'no-read' }

/** The jwt plugin's default grace period for rotated keys: 30 days. */
const GRACE_MS = 2_592_000 * 1000

type JwkRow = { id: string; public_key: string; alg: string | null; crv: string | null; expires_at: Date | null }

/** The JWKS that /api/auth/jwks publishes (better-auth jwt plugin getJwks), read from the table. */
async function loadJwks(db: Db) {
  const result = await db.execute<JwkRow>(sql`SELECT id, public_key, alg, crv, expires_at FROM jwks`)
  const now = Date.now()
  return {
    keys: result.rows
      .filter((k) => !k.expires_at || k.expires_at.getTime() + GRACE_MS > now)
      .map((k) => ({ alg: k.alg ?? 'EdDSA', ...(k.crv ? { crv: k.crv } : {}), ...(JSON.parse(k.public_key) as Record<string, string>), kid: k.id })),
  }
}

/** One cache entry per isolate, with Better Auth's TTL and kid-miss refetch rules. */
const jwksCacheKey = {}

/**
 * Better Auth's createDpopReplayStore over internalAdapter.reserveVerificationValue:
 * a verification row whose ID is base64url(sha256("reserve:dpop-proof:" + key)).
 * A second insert of the same proof finds the row and fails, across isolates.
 */
async function reservationId(identifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`reserve:${identifier}`)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const replayStore = (db: Db): DpopReplayStore => ({
  reserve: async ({ key, expiresAt }) => {
    const identifier = `dpop-proof:${key}`
    const result = await db.execute(sql`
      INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES (${await reservationId(identifier)}, ${identifier}, ${key}, ${expiresAt}, now(), now())
      ON CONFLICT (id) DO NOTHING RETURNING id`)
    return result.rows.length === 1
  },
})

type GrantRow = {
  connection_user: string | null
  connection_client: string | null
  connection_scopes: string[] | null
  revoked: boolean | null
  user_id: string | null
  user_name: string | null
  user_email: string | null
  verified: boolean | null
  client_disabled: boolean | null
  client_exists: boolean
  consent_scopes: string[] | null
}

/** jose's errors carry codes such as ERR_JWT_EXPIRED; PostgreSQL errors carry SQLSTATE codes. */
const isJoseError = (error: unknown) =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && /^ERR_J(W[STEK]|OSE)/.test(error.code)

const isScopeToken =(s: string) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)

/** Verifies the request's OAuth access token, then the live connection, account, client and consent. */
export async function verifyOAuthRequest(db: Db, data: { request: Request; baseUrl: string }): Promise<OAuthResult> {
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

  // One round trip: the connection, the account, the client and the current consent.
  const result = await db.execute<GrantRow>(sql`
    SELECT
      c.user_id AS connection_user, c.client_id AS connection_client, c.scopes AS connection_scopes, c.revoked_at IS NOT NULL AS revoked,
      u.id AS user_id, u.name AS user_name, u.email AS user_email, u.email_verified AS verified,
      oc.disabled AS client_disabled, oc.id IS NOT NULL AS client_exists,
      (SELECT scopes FROM oauth_consent WHERE user_id = ${sub} AND client_id = ${clientId} LIMIT 1) AS consent_scopes
    FROM (SELECT 1) one
    LEFT JOIN oauth_connections c ON c.id = ${connectionId}
    LEFT JOIN "user" u ON u.id = ${sub}
    LEFT JOIN oauth_client oc ON oc.client_id = ${clientId}
  `)
  const row = result.rows[0]
  if (
    !row ||
    row.connection_user === null ||
    row.revoked ||
    row.connection_user !== sub ||
    row.connection_client !== clientId ||
    !row.verified ||
    !row.user_id ||
    !row.client_exists ||
    row.client_disabled === true ||
    !row.consent_scopes
  )
    return { kind: 'invalid' }
  const consent = row.consent_scopes
  const scopes = scope.split(' ').filter((s) => s && consent.includes(s))
  // The current app's requireMcpAuth demanded read scope in the token itself; with
  // the consent intersection this is one check, answered 403 as both did.
  if (!scopes.includes(OAUTH_READ_SCOPE)) return { kind: 'no-read' }
  const granted = row.connection_scopes ?? []
  if (!scopes.every((s) => granted.includes(s))) return { kind: 'invalid' }
  return { kind: 'ok', userId: row.user_id, name: row.user_name ?? '', email: row.user_email ?? '', connectionId, scopes }
}
