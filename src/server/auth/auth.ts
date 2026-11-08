import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-call'
import { eq, sql } from 'drizzle-orm'
import * as authSchema from '../../../db/schema/auth'
import { isSafeCallback } from '../../shared/account'
import { apiKeyLimitMessage, LIMITS, SIGN_UP_LIMIT_CODE, signUpLimitMessage } from '../../shared/limits'
import { bootstrapOwner } from './owner-bootstrap'
import type { AuthSettings } from '../core/config'
import type { Db } from '../core/db'
import { apiKeyCount } from './api-key'
import { AUTH_RATE_LIMIT, authPlugins, DAY_SECONDS } from './auth-options'
import { connectionClaims } from './oauth-connections'

/**
 * The daily cap on new accounts (LIMITS.signUpsPerDay, or SIGN_UP_DAILY_LIMIT):
 * at most `limit` accounts created in the last 24 hours. It runs only when
 * Better Auth creates a user, so existing accounts always sign in. Concurrent
 * sign-ups at the cap can pass it by a few; it is a brake on abuse, not a quota.
 */
async function checkSignUpCap(db: Db, limit: number) {
  const result = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM "user" WHERE created_at > now() - interval '24 hours'`)
  if ((result.rows[0]?.count ?? 0) >= limit) throw new APIError('FORBIDDEN', { code: SIGN_UP_LIMIT_CODE, message: signUpLimitMessage })
}

/** Refuses a new API key for an account that has LIMITS.apiKeys keys. The caller is the session, or the userId of a server call. */
async function checkApiKeyLimit(db: Db, userId: string) {
  const result = await db.execute<{ keys: number }>(sql`SELECT ${apiKeyCount(userId)} AS keys`)
  if ((result.rows[0]?.keys ?? 0) >= LIMITS.apiKeys) throw new APIError('FORBIDDEN', { message: apiKeyLimitMessage })
}

/** Better Auth with the app's plugins and hooks. The settings were checked at start (config.ts). */
export function createAuth(config: AuthSettings & { readonly db: Db }) {
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
    session: { expiresIn: LIMITS.sessionDays * DAY_SECONDS, updateAge: DAY_SECONDS, cookieCache: { enabled: false } },
    rateLimit: AUTH_RATE_LIMIT,
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
            await checkSignUpCap(config.db, config.signUpDailyLimit)
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
      // A container can reach the private networks around it (the database, the bucket), so the CIMD
      // metadata fetch uses Better Auth's Node fetcher: every DNS answer must be a public address, and
      // the connection is pinned to it, as in the current app. The plugin refuses redirects and any
      // status but 200, and limits the time (5 s) and the size (5 KiB).
      fetchClientMetadataResource,
      extensions: [connectionClaims(config.db)],
    }),
  })
}

export type Auth = ReturnType<typeof createAuth>
