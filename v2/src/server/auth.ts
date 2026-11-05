import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-call'
import { and, arrayContains, eq, isNull } from 'drizzle-orm'
import * as authSchema from '../../db/schema/auth'
import { oauthConnections } from '../../db/schema/app'
import { authPlugins, hashOAuthToken, OAUTH_CONNECTION_CLAIM, type ClientMetadataResourceFetch } from './auth-options'
import type { Db } from './db'
import { randomId } from './ids'

/**
 * Ties every access token to a revocable connection, one per authorization.
 * Ported from the current app's src/lib/oauth-connections.ts.
 */
function connectionClaims(db: Db): OAuthProviderExtension {
  return {
    claims: {
      accessToken: async ({ user, client, grantType, ctx, scopes }) => {
        if (!user?.emailVerified || !['authorization_code', 'refresh_token'].includes(grantType ?? ''))
          throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'A verified account grant is required' })
        const body = ctx.body as Record<string, unknown>
        let authorizationCodeId: string | null | undefined
        if (grantType === 'authorization_code' && typeof body['code'] === 'string') authorizationCodeId = await hashOAuthToken(body['code'])
        if (grantType === 'refresh_token' && typeof body['refresh_token'] === 'string') {
          const [refresh] = await db
            .select()
            .from(authSchema.oauthRefreshToken)
            .where(eq(authSchema.oauthRefreshToken.token, await hashOAuthToken(body['refresh_token'])))
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

const SPECIAL_USE_V4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.[02]\./, /^192\.88\.99\./, /^192\.168\./, /^198\.(1[89])\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|2[3-5]\d)\./,
]

/**
 * CIMD metadata fetch for Workers. A Worker's fetch reaches only the public
 * internet, so loopback and private networks are out of reach. This adds the
 * remaining rules: HTTPS only, no IP literals in special-use ranges, no
 * redirects, and limits on time and size.
 */
export const workerCimdFetch: ClientMetadataResourceFetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || host === 'localhost' || host.includes(':') || SPECIAL_USE_V4.some((r) => r.test(host)))
    throw new Error('Client metadata must be on a public HTTPS host')
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } })
  if (response.status >= 300 && response.status < 400) throw new Error('Client metadata redirects are not followed')
  const body = await response.arrayBuffer()
  if (body.byteLength > 64 * 1024) throw new Error('Client metadata is too large')
  return new Response(body, { status: response.status, headers: response.headers })
}

export type AuthConfig = {
  readonly db: Db
  readonly baseUrl: string
  readonly secret: string
  readonly googleClientId: string
  readonly googleClientSecret: string
}

export function createAuth(config: AuthConfig) {
  if (config.secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  return betterAuth({
    appName: 'AgentSplit',
    baseURL: config.baseUrl,
    secret: config.secret,
    database: drizzleAdapter(config.db, { provider: 'pg', schema: authSchema }),
    telemetry: { enabled: false },
    trustedOrigins: [new URL(config.baseUrl).origin],
    socialProviders: {
      google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret, scope: ['openid', 'email', 'profile'] },
    },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', modelName: 'rateLimit' },
    plugins: authPlugins({
      baseUrl: config.baseUrl,
      fetchClientMetadataResource: workerCimdFetch,
      extensions: [connectionClaims(config.db)],
    }),
  })
}

export type Auth = ReturnType<typeof createAuth>
