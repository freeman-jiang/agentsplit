import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { jwt } from 'better-auth/plugins/jwt'
import { mcpResource, OAUTH_SCOPES, oauthIssuer } from './oauth-config'
import { connectionClaims, hashOAuthToken } from './oauth-connections'
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
      jwt({ jwt: { issuer: oauthIssuer() } }),
      mcp({
        resource: mcpResource(),
        resources: [
          {
            identifier: mcpResource(),
            name: 'AgentSplit',
            allowedScopes: OAUTH_SCOPES,
          },
        ],
        loginPage: '/sign-in',
        consentPage: '/settings/connections/consent',
        scopes: OAUTH_SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        storeTokens: { hash: hashOAuthToken },
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        extensions: [connectionClaims],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
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
