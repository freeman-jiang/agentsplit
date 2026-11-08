// The Better Auth options that decide its tables, shared by the runtime
// (auth.ts) and the schema generator (scripts/gen-auth-schema.ts): the plugin
// set and the rate-limit storage. It matches v1's src/lib/auth.ts, so
// imported rows keep working.
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { mcp } from '@better-auth/mcp'
import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { jwt } from 'better-auth/plugins/jwt'
import { LIMITS } from '../../shared/limits'
import { sha256Base64url } from '../core/ids'
import { OAUTH_SCOPES } from '../../shared/account'
import { mcpResource, oauthIssuer } from './constants'

/** Better Auth takes its lifetimes in seconds. */
export const DAY_SECONDS = 24 * 60 * 60

/** Better Auth's own rate limits (sign-in, client registration) count in its rate_limit table. */
export const AUTH_RATE_LIMIT = { enabled: true, storage: 'database', modelName: 'rateLimit' } as const

export type ClientMetadataResourceFetch = Parameters<typeof cimd>[0]['fetchClientMetadataResource']

const unavailableFetch: ClientMetadataResourceFetch = () => {
  throw new Error('No CIMD fetcher is configured')
}

export function authPlugins(config: {
  baseUrl: string
  fetchClientMetadataResource: ClientMetadataResourceFetch
  extensions: OAuthProviderExtension[]
} = { baseUrl: 'http://localhost', fetchClientMetadataResource: unavailableFetch, extensions: [] }) {
  const resource = mcpResource(config.baseUrl)
  return [
    jwt({ jwt: { issuer: oauthIssuer(config.baseUrl) } }),
    mcp({
      resource,
      resources: [{ identifier: resource, name: 'AgentSplit', allowedScopes: [...OAUTH_SCOPES] }],
      loginPage: '/sign-in',
      consentPage: '/settings/connections/consent',
      scopes: [...OAUTH_SCOPES],
      grantTypes: ['authorization_code', 'refresh_token'],
      accessTokenExpiresIn: LIMITS.accessTokenSeconds,
      refreshTokenExpiresIn: LIMITS.refreshTokenDays * DAY_SECONDS,
      // The stored form of every OAuth token, as in the current app.
      storeTokens: { hash: sha256Base64url },
      // CIMD stays preferred; older MCP clients can register before sign-in.
      // Registration does not grant account access or bypass consent or PKCE.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Fair use: registrations per IP address, in Better Auth's rate-limit table.
      rateLimit: { register: { window: 3600, max: LIMITS.clientRegistrationsPerHour } },
      extensions: config.extensions,
    }),
    cimd({ fetchClientMetadataResource: config.fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    apiKey({
      defaultPrefix: 'agentsplit_',
      enableSessionForAPIKeys: false,
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: LIMITS.apiKeyRequestsPerMinute },
      keyExpiration: { defaultExpiresIn: null },
    }),
  ]
}
