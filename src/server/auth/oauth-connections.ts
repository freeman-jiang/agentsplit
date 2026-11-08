// Agent connections: every OAuth access token names one revocable connection,
// one per authorization (the current app's src/lib/oauth-connections.ts).
// This module owns the claim that issues it, the check of a token's live
// connection, the recheck inside a write, revocation, and the tombstone after
// a refresh-token revoke. Better Auth's access tokens are JWTs that stay
// valid until they expire, so a revoked connection is what stops them.
import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { APIError } from 'better-call'
import { and, arrayContains, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { oauthConnections } from '../../../db/schema/app'
import * as authSchema from '../../../db/schema/auth'
import { Forbidden } from '../../shared/api'
import type { Db } from '../core/db'
import { sha256Base64url } from '../core/ids'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from '../../shared/account'
import { randomId } from '../../shared/ids'
import { OAUTH_CONNECTION_CLAIM } from './constants'

/** The Better Auth claim that creates or finds the connection of an authorization, and names it in each access token. */
export function connectionClaims(db: Db): OAuthProviderExtension {
  return {
    claims: {
      accessToken: async ({ user, client, grantType, ctx, scopes }) => {
        if (!user?.emailVerified || !['authorization_code', 'refresh_token'].includes(grantType ?? ''))
          throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'A verified account grant is required' })
        const body = ctx.body as Record<string, unknown>
        let authorizationCodeId: string | null | undefined
        if (grantType === 'authorization_code' && typeof body['code'] === 'string') authorizationCodeId = sha256Base64url(body['code'])
        if (grantType === 'refresh_token' && typeof body['refresh_token'] === 'string') {
          const [refresh] = await db
            .select()
            .from(authSchema.oauthRefreshToken)
            .where(eq(authSchema.oauthRefreshToken.token, sha256Base64url(body['refresh_token'])))
          if (refresh?.userId === user.id && refresh.clientId === client.clientId) authorizationCodeId = refresh.authorizationCodeId
        }
        if (!authorizationCodeId) throw new APIError('BAD_REQUEST', { error: 'invalid_grant' })
        const [consent] = await db
          .select({ id: authSchema.oauthConsent.id })
          .from(authSchema.oauthConsent)
          .where(
            and(
              eq(authSchema.oauthConsent.userId, user.id),
              eq(authSchema.oauthConsent.clientId, client.clientId),
              arrayContains(authSchema.oauthConsent.scopes, scopes),
            ),
          )
        if (!consent) throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'Consent is no longer active' })
        await db
          .insert(oauthConnections)
          .values({ id: randomId(), authorizationCodeId, userId: user.id, clientId: client.clientId, scopes })
          .onConflictDoNothing({ target: oauthConnections.authorizationCodeId })
        const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.authorizationCodeId, authorizationCodeId))
        if (!connection || connection.revokedAt || connection.userId !== user.id || connection.clientId !== client.clientId)
          throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Connection revoked; connect again' })
        return { [OAUTH_CONNECTION_CLAIM]: connection.id }
      },
    },
  }
}

/** The outcome of an OAuth request's checks (oauth.ts and verifyConnection). */
export type OAuthResult =
  | { readonly kind: 'ok'; readonly userId: string; readonly name: string; readonly email: string; readonly connectionId: string; readonly scopes: readonly string[] }
  /** Missing, invalid, expired or revoked: answer with the 401 challenge. */
  | { readonly kind: 'invalid' }
  /** Valid, but read access is no longer granted: answer 403 insufficient_scope. */
  | { readonly kind: 'no-read' }

/**
 * Whether the client of an unrevoked connection still has access for the
 * user: it exists, is not disabled, and has a consent. verifyConnection
 * checks the token's connection with it, and Settings lists the connections
 * it keeps.
 */
export const clientStillGranted = (data: { userId: SQL; clientId: SQL }) =>
  sql`(EXISTS (SELECT 1 FROM oauth_client oc WHERE oc.client_id = ${data.clientId} AND oc.disabled IS NOT TRUE)
    AND EXISTS (SELECT 1 FROM oauth_consent s WHERE s.user_id = ${data.userId} AND s.client_id = ${data.clientId}))`

type GrantRow = {
  connection_user: string | null
  connection_client: string | null
  connection_scopes: string[] | null
  revoked: boolean | null
  user_id: string | null
  user_name: string | null
  user_email: string | null
  verified: boolean | null
  granted: boolean
  consent_scopes: string[] | null
}

/**
 * The live check of a verified access token: its connection is unrevoked and
 * belongs to the token's account and client, the account is verified, the
 * client exists and is enabled, and a consent is current. The granted scopes
 * are the token's, within the consent and the connection.
 */
export async function verifyConnection(db: Db, data: { connectionId: string; userId: string; clientId: string; scope: string }): Promise<OAuthResult> {
  // One round trip: the connection, the account, the client and the current consent.
  const result = await db.execute<GrantRow>(sql`
    SELECT
      c.user_id AS connection_user, c.client_id AS connection_client, c.scopes AS connection_scopes, c.revoked_at IS NOT NULL AS revoked,
      u.id AS user_id, u.name AS user_name, u.email AS user_email, u.email_verified AS verified,
      ${clientStillGranted({ userId: sql`${data.userId}`, clientId: sql`${data.clientId}` })} AS granted,
      (SELECT scopes FROM oauth_consent WHERE user_id = ${data.userId} AND client_id = ${data.clientId} LIMIT 1) AS consent_scopes
    FROM (SELECT 1) one
    LEFT JOIN oauth_connections c ON c.id = ${data.connectionId}
    LEFT JOIN "user" u ON u.id = ${data.userId}
  `)
  const row = result.rows[0]
  if (
    !row ||
    row.connection_user === null ||
    row.revoked ||
    row.connection_user !== data.userId ||
    row.connection_client !== data.clientId ||
    !row.verified ||
    !row.user_id ||
    !row.granted ||
    !row.consent_scopes
  )
    return { kind: 'invalid' }
  const consent = row.consent_scopes
  const scopes = data.scope.split(' ').filter((s) => s && consent.includes(s))
  // The current app's requireMcpAuth demanded read scope in the token itself; with
  // the consent intersection this is one check, answered 403 as both did.
  if (!scopes.includes(OAUTH_READ_SCOPE)) return { kind: 'no-read' }
  const granted = row.connection_scopes ?? []
  if (!scopes.every((s) => granted.includes(s))) return { kind: 'invalid' }
  return { kind: 'ok', userId: row.user_id, name: row.user_name ?? '', email: row.user_email ?? '', connectionId: data.connectionId, scopes }
}

/**
 * Rechecks, inside a write's transaction, that an OAuth connection is live and
 * its consent still allows changes, so a revocation that races the request
 * cannot let the write commit (the current app's assertOAuthWriteAccess).
 */
export async function assertOAuthWrite(
  tx: Db,
  principal: { readonly userId: string; readonly scopes: readonly string[] | null; readonly oauthConnectionId: string | null },
) {
  if (!principal.oauthConnectionId) return
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM oauth_connections c
      JOIN oauth_consent o ON o.user_id = c.user_id AND o.client_id = c.client_id AND o.scopes @> ARRAY[${OAUTH_READ_SCOPE}, ${OAUTH_WRITE_SCOPE}]::text[]
      WHERE c.id = ${principal.oauthConnectionId} AND c.revoked_at IS NULL AND c.user_id = ${principal.userId}
    ) AS ok`)
  if (!result.rows[0]?.ok || !principal.scopes?.includes(OAUTH_WRITE_SCOPE))
    throw new Forbidden({ message: 'This OAuth connection no longer has write permission' })
}

/** Keeps the grant tombstone, so old JWTs and racing refreshes never regain access. */
export async function revokeOAuthConnection(db: Db, data: { userId: string; clientId: string }) {
  await db.transaction(async (tx) => {
    await tx
      .update(oauthConnections)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthConnections.userId, data.userId), eq(oauthConnections.clientId, data.clientId), isNull(oauthConnections.revokedAt)))
    for (const table of [authSchema.oauthAccessToken, authSchema.oauthRefreshToken, authSchema.oauthConsent])
      await tx.delete(table).where(and(eq(table.userId, data.userId), eq(table.clientId, data.clientId)))
  })
}

export type RefreshToken = typeof authSchema.oauthRefreshToken.$inferSelect

/** The stored refresh token that an RFC 7009 revoke request names, before Better Auth revokes it. */
export async function refreshTokenOf(db: Db, request: Request) {
  const token = new URLSearchParams(await request.clone().text()).get('token')
  if (!token) return null
  const [refresh] = await db.select().from(authSchema.oauthRefreshToken).where(eq(authSchema.oauthRefreshToken.token, sha256Base64url(token)))
  return refresh ?? null
}

/**
 * After Better Auth answered an RFC 7009 revoke: if it turned the refresh
 * token from active to revoked, tombstones the token's connection (P-MCP-137),
 * so its access tokens stop working before they expire.
 */
export async function tombstoneRevokedRefresh(db: Db, refresh: RefreshToken) {
  if (refresh.revoked || !refresh.authorizationCodeId) return
  const [after] = await db
    .select({ revoked: authSchema.oauthRefreshToken.revoked })
    .from(authSchema.oauthRefreshToken)
    .where(eq(authSchema.oauthRefreshToken.id, refresh.id))
  if (!after?.revoked) return
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
