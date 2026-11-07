// OAuth names that the MCP path and Better Auth's options share. This module
// loads no Better Auth code, so the MCP path never does.
export { OAUTH_READ_SCOPE, OAUTH_SCOPES, OAUTH_WRITE_SCOPE } from '../../shared/account'
/** The access-token claim that names the token's connection (oauth-connections.ts). */
export const OAUTH_CONNECTION_CLAIM = 'https://agentsplit.app/connection'
export const mcpResource = (baseUrl: string) => new URL('/api/mcp', baseUrl).href
export const oauthIssuer = (baseUrl: string) => new URL('/api/auth', baseUrl).href
