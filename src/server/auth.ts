import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-call'
import { and, arrayContains, count, eq, sql } from 'drizzle-orm'
import * as authSchema from '../../db/schema/auth'
import { oauthConnections } from '../../db/schema/app'
import { isSafeCallback } from '../shared/api/account'
import { apiKeyLimitMessage, LIMITS, SIGN_UP_LIMIT_CODE, signUpLimitMessage } from '../shared/limits'
import { bootstrapOwner } from './account'
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
        if (grantType === 'authorization_code' && typeof body['code'] === 'string') authorizationCodeId = hashOAuthToken(body['code'])
        if (grantType === 'refresh_token' && typeof body['refresh_token'] === 'string') {
          const [refresh] = await db
            .select()
            .from(authSchema.oauthRefreshToken)
            .where(eq(authSchema.oauthRefreshToken.token, hashOAuthToken(body['refresh_token'])))
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

export { revokeOAuthConnection } from './account'

/**
 * CIMD metadata fetch. A container can reach the private networks around it
 * (the database, the bucket), so Better Auth's Node fetcher checks that every
 * DNS answer is a public address and pins the connection to it, as in the
 * current app. This adds the remaining rules: no redirects, and limits on time and size.
 */
export const cimdFetch: ClientMetadataResourceFetch = async (input, init) => {
  const response = await fetchClientMetadataResource(input, { ...init, signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } })
  if (response.status >= 300 && response.status < 400) throw new Error('Client metadata redirects are not followed')
  const body = await response.arrayBuffer()
  if (body.byteLength > 64 * 1024) throw new Error('Client metadata is too large')
  return new Response(body, { status: response.status, headers: response.headers })
}

/**
 * The daily cap on new accounts (LIMITS.signUpsPerDay, or SIGN_UP_DAILY_LIMIT):
 * at most `limit` accounts created in the last 24 hours. It runs only when
 * Better Auth creates a user, so existing accounts always sign in. Concurrent
 * sign-ups at the cap can pass it by a few; it is a brake on abuse, not a quota.
 */
export async function checkSignUpCap(db: Db, limit: number) {
  const result = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM "user" WHERE created_at > now() - interval '24 hours'`)
  if ((result.rows[0]?.count ?? 0) >= limit) throw new APIError('FORBIDDEN', { code: SIGN_UP_LIMIT_CODE, message: signUpLimitMessage })
}

/** Refuses a new API key for an account that has LIMITS.apiKeys keys. The caller is the session, or the userId of a server call. */
async function checkApiKeyLimit(db: Db, userId: string) {
  const [row] = await db.select({ keys: count() }).from(authSchema.apikey).where(eq(authSchema.apikey.referenceId, userId))
  if ((row?.keys ?? 0) >= LIMITS.apiKeys) throw new APIError('FORBIDDEN', { message: apiKeyLimitMessage })
}

export type AuthConfig = {
  readonly db: Db
  readonly baseUrl: string
  readonly secret: string
  readonly googleClientId: string
  readonly googleClientSecret: string
  /** The verified email that may claim the groups created before accounts existed. */
  readonly bootstrapEmail?: string | undefined
  /** New accounts per 24 hours; LIMITS.signUpsPerDay when not set. */
  readonly signUpDailyLimit?: number | undefined
}

export function createAuth(config: AuthConfig) {
  if (config.secret.length < 32 || !config.baseUrl || !config.googleClientId || !config.googleClientSecret)
    throw new Error('Google sign-in is not configured')
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
    hooks: {
      // Better Auth accepts relative callbacks such as /\evil.example, which
      // browsers resolve to another host. Only same-origin targets pass here.
      before: createAuthMiddleware(async (ctx) => {
        const body: unknown = ctx.body
        if (ctx.path === '/api-key/create') {
          const session = await getSessionFromCtx(ctx)
          const bodyUser = typeof body === 'object' && body !== null && 'userId' in body && typeof body.userId === 'string' ? body.userId : null
          const userId = session?.user.id ?? bodyUser
          if (userId) await checkApiKeyLimit(config.db, userId)
        }
        if (typeof body !== 'object' || body === null) return
        for (const field of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']) {
          const value: unknown = (body as Record<string, unknown>)[field]
          if (value !== undefined && !isSafeCallback(value, config.baseUrl))
            throw new APIError('FORBIDDEN', { message: `Invalid ${field}` })
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            await checkSignUpCap(config.db, config.signUpDailyLimit ?? LIMITS.signUpsPerDay)
          },
        },
      },
      session: {
        create: {
          // Runs once per sign-in, never on a session lookup. A failure is logged
          // and does not block sign-in; the next sign-in tries again.
          after: async (created) => {
            if (!config.bootstrapEmail) return
            try {
              const [owner] = await config.db
                .select({ id: authSchema.user.id, email: authSchema.user.email, emailVerified: authSchema.user.emailVerified })
                .from(authSchema.user)
                .where(eq(authSchema.user.id, created.userId))
              if (owner) await bootstrapOwner(config.db, { user: owner, bootstrapEmail: config.bootstrapEmail })
            } catch (error) {
              console.error('Owner bootstrap failed', error)
            }
          },
        },
      },
    },
    plugins: authPlugins({
      baseUrl: config.baseUrl,
      fetchClientMetadataResource: cimdFetch,
      extensions: [connectionClaims(config.db)],
    }),
  })
}

export type Auth = ReturnType<typeof createAuth>
