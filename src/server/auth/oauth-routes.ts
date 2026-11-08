// The current app's wrapper around three OAuth routes of Better Auth
// (src/app/api/auth/[...all]/route.ts). It ties each revocation to the agent
// connection (oauth-connections.ts), which every MCP request checks:
// - RFC 7009 revoke of a refresh token tombstones its connection (P-MCP-137).
// - Deleting a consent revokes the user's connections for that client (P-MCP-138).
// - UserInfo applies the MCP endpoint's connection, consent and verified-user checks (P-MCP-139).
import { and, eq } from 'drizzle-orm'
import { Result, Schema } from 'effect'
import * as authSchema from '../../../db/schema/auth'
import type { Db } from '../core/db'
import { oauthRefusal } from './authenticate'
import { verifyOAuthRequest } from './oauth'
import { refreshTokenOf, revokeOAuthConnection, tombstoneRevokedRefresh } from './oauth-connections'
import { requestSession } from './session'

const ConsentId = Schema.Struct({ id: Schema.String })

/** The user and client of the caller's own consent that a delete-consent request names, before Better Auth deletes it. */
async function consentOwner(db: Db, data: { request: Request; secret: string; baseUrl: string }) {
  const body: unknown = await data.request
    .clone()
    .json()
    .catch(() => null)
  const input = Schema.decodeUnknownResult(ConsentId)(body)
  if (Result.isFailure(input)) return null
  const principal = await requestSession(db, data)
  if (!principal) return null
  const [consent] = await db
    .select({ clientId: authSchema.oauthConsent.clientId })
    .from(authSchema.oauthConsent)
    .where(and(eq(authSchema.oauthConsent.id, input.success.id), eq(authSchema.oauthConsent.userId, principal.userId)))
  return consent ? { userId: principal.userId, clientId: consent.clientId } : null
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
    if (result.kind !== 'ok') return oauthRefusal({ result, baseUrl: data.baseUrl })
  }
  const owner = request.method === 'POST' && path.endsWith('/oauth2/delete-consent') ? await consentOwner(db, { request, secret: data.secret, baseUrl: data.baseUrl }) : null
  const refresh = request.method === 'POST' && path.endsWith('/oauth2/revoke') ? await refreshTokenOf(db, request) : null
  const response = await data.handle(request)
  if (!response.ok) return response
  if (owner) await revokeOAuthConnection(db, owner)
  if (refresh) await tombstoneRevokedRefresh(db, refresh)
  return response
}
