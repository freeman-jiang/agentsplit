// OAuth names the MCP path needs. They equal the exports of auth-options.ts
// (test/db/mcp-auth.test.ts pins them); that module imports every Better Auth
// plugin, so the MCP path keeps its own copies and never loads Better Auth.
export const OAUTH_READ_SCOPE = 'agentsplit:read'
export const OAUTH_WRITE_SCOPE = 'agentsplit:write'
export const OAUTH_CONNECTION_CLAIM = 'https://agentsplit.app/connection'
export const mcpResource = (baseUrl: string) => new URL('/api/mcp', baseUrl).href
export const oauthIssuer = (baseUrl: string) => new URL('/api/auth', baseUrl).href
