// OAuth names that the MCP path and Better Auth's options share. This module
// loads no Better Auth code, so the MCP path never does. The scopes are in
// src/shared/account.ts, which the consent page reads too.
import { MCP_PATH } from '../../shared/mcp'
import { AUTH_PATH } from '../../shared/paths'
/** The access-token claim that names the token's connection (oauth-connections.ts). */
export const OAUTH_CONNECTION_CLAIM = 'https://agentsplit.app/connection'
export const mcpResource = (baseUrl: string) => new URL(MCP_PATH, baseUrl).href
export const oauthIssuer = (baseUrl: string) => new URL(AUTH_PATH, baseUrl).href
