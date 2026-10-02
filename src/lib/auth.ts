import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from './prisma'

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET
  const baseURL = process.env.BASE_URL
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!secret || secret.length < 32 || !baseURL || !clientId || !clientSecret)
    throw new Error('Google sign-in is not configured')
  return betterAuth({
    appName: 'AgentSplit',
    baseURL,
    secret,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    trustedOrigins: [new URL(baseURL).origin],
    socialProviders: {
      google: { clientId, clientSecret, scope: ['openid', 'email', 'profile'] },
    },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: 'database', modelName: 'RateLimit' },
    plugins: [
      apiKey({
        defaultPrefix: 'agentsplit_',
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
        keyExpiration: { defaultExpiresIn: null },
      }),
    ],
  })
}
let instance: ReturnType<typeof createAuth> | undefined
export function getAuth() {
  return (instance ??= createAuth())
}
