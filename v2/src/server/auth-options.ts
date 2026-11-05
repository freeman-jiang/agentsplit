// The Better Auth plugin set, shared by the runtime (src/server/auth.ts) and the
// schema generator (scripts/gen-auth-schema.ts). It matches the current app's
// src/lib/auth.ts, so imported rows keep working.
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { mcp } from '@better-auth/mcp'
import type { OAuthProviderExtension } from '@better-auth/oauth-provider'
import { jwt } from 'better-auth/plugins/jwt'
import { OAUTH_SCOPES } from '../shared/api/account'

// The consent page needs the scopes too, so they live in the shared contract.
export { OAUTH_READ_SCOPE, OAUTH_SCOPES, OAUTH_WRITE_SCOPE } from '../shared/api/account'
export const OAUTH_CONNECTION_CLAIM = 'https://agentsplit.app/connection'

export const mcpResource = (baseUrl: string) => new URL('/api/mcp', baseUrl).href
export const oauthIssuer = (baseUrl: string) => new URL('/api/auth', baseUrl).href

/** The stored form of every OAuth token: base64url(sha256(token)), as in the current app. */
export async function hashOAuthToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
      storeTokens: { hash: hashOAuthToken },
      // CIMD stays preferred; older MCP clients can register before sign-in.
      // Registration does not grant account access or bypass consent or PKCE.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      extensions: config.extensions,
    }),
    cimd({ fetchClientMetadataResource: config.fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    apiKey({
      defaultPrefix: 'agentsplit_',
      enableSessionForAPIKeys: false,
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
      keyExpiration: { defaultExpiresIn: null },
    }),
  ]
}
