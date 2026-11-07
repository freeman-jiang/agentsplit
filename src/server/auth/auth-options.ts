// The Better Auth plugin set, shared by the runtime (auth.ts) and the
// schema generator (scripts/gen-auth-schema.ts). It matches the current app's
// src/lib/auth.ts, so imported rows keep working.
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { mcp } from '@better-auth/mcp'
import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { jwt } from 'better-auth/plugins/jwt'
import { LIMITS } from '../../shared/limits'
import { sha256Base64url } from '../core/ids'
import { mcpResource, OAUTH_SCOPES, oauthIssuer } from './constants'

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
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 60 * 60 * 24 * 30,
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
