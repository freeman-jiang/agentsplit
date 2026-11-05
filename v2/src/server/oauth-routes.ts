// The current app's wrapper around three OAuth routes of Better Auth
// (src/app/api/auth/[...all]/route.ts). Better Auth's access tokens are JWTs
// that stay valid until they expire (300 seconds), so the wrapper ties a
// revocation to the agent connection, which every MCP request checks:
// - RFC 7009 revoke of a refresh token tombstones its connection (P-MCP-137).
// - Deleting a consent revokes the user's connections for that client (P-MCP-138).
// - UserInfo applies the MCP endpoint's connection, consent and verified-user checks (P-MCP-139).
import { and, eq, isNull } from 'drizzle-orm'
import { Result, Schema } from 'effect'
import { oauthConnections } from '../../db/schema/app'
import * as authSchema from '../../db/schema/auth'
import { revokeOAuthConnection } from './account'
import { hashOAuthToken } from './auth-options'
import type { Db } from './db'
import { challenge } from './mcp/challenge'
import { verifyOAuthRequest } from './mcp/oauth'
import { sessionPrincipal } from './session'

const ConsentId = Schema.Struct({ id: Schema.String })

/** The user and client of the caller's own consent that a delete-consent request names, before Better Auth deletes it. */
async function consentOwner(db: Db, data: { request: Request; secret: string; baseUrl: string }) {
  const body: unknown = await data.request
    .clone()
    .json()
    .catch(() => null)
  const input = Schema.decodeUnknownResult(ConsentId)(body)
  if (Result.isFailure(input)) return null
  const principal = await sessionPrincipal(db, { cookie: data.request.headers.get('cookie'), secret: data.secret, baseUrl: data.baseUrl })
  if (!principal) return null
  const [consent] = await db
    .select({ userId: authSchema.oauthConsent.userId, clientId: authSchema.oauthConsent.clientId })
    .from(authSchema.oauthConsent)
    .where(and(eq(authSchema.oauthConsent.id, input.success.id), eq(authSchema.oauthConsent.userId, principal.userId)))
  return consent?.userId ? { userId: consent.userId, clientId: consent.clientId } : null
}

/** The stored refresh token that an RFC 7009 revoke request names, before Better Auth revokes it. */
async function refreshTokenOf(db: Db, request: Request) {
  const token = new URLSearchParams(await request.clone().text()).get('token')
  if (!token) return null
  const [refresh] = await db.select().from(authSchema.oauthRefreshToken).where(eq(authSchema.oauthRefreshToken.token, hashOAuthToken(token)))
  return refresh ?? null
}

/**
 * Sends one /api/auth/* request to Better Auth (`handle`), with the extra
 * checks before and the revocations after. Only a successful answer of Better
 * Auth revokes anything, and only an active-to-revoked change of a refresh
 * token tombstones its connection.
 */
export async function handleAuthRoute(data: {
  db: Db
  request: Request
  baseUrl: string
  secret: string
  handle: (request: Request) => Promise<Response>
}): Promise<Response> {
  const { db, request } = data
  const path = new URL(request.url).pathname
  if (path.endsWith('/oauth2/userinfo')) {
    // Better Auth's UserInfo checks the DPoP proof itself; a second check here would see the same proof as a replay.
    const result = await verifyOAuthRequest(db, { request, baseUrl: data.baseUrl, dpop: false })
    if (result.kind === 'invalid') return challenge({ baseUrl: data.baseUrl })
    if (result.kind === 'no-read') return challenge({ baseUrl: data.baseUrl, status: 403, message: 'Read permission is no longer granted' })
  }
  const owner = request.method === 'POST' && path.endsWith('/oauth2/delete-consent') ? await consentOwner(db, { request, secret: data.secret, baseUrl: data.baseUrl }) : null
  const refresh = request.method === 'POST' && path.endsWith('/oauth2/revoke') ? await refreshTokenOf(db, request) : null
  const response = await data.handle(request)
  if (!response.ok) return response
  if (owner) await revokeOAuthConnection(db, owner)
  if (refresh && !refresh.revoked && refresh.authorizationCodeId) {
    const [after] = await db
      .select({ revoked: authSchema.oauthRefreshToken.revoked })
      .from(authSchema.oauthRefreshToken)
      .where(eq(authSchema.oauthRefreshToken.id, refresh.id))
    if (after?.revoked)
      await db
        .update(oauthConnections)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oauthConnections.authorizationCodeId, refresh.authorizationCodeId),
            eq(oauthConnections.userId, refresh.userId),
            eq(oauthConnections.clientId, refresh.clientId),
            isNull(oauthConnections.revokedAt),
          ),
        )
  }
  return response
}
