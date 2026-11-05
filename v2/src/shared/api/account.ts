// The account area: the signed-in user's profile, API keys and connected apps.
// API keys are created through Better Auth (/api/auth/api-key/create), which
// owns the key format and hash; listing and revoking them run here.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { Id, ReadError, WriteError } from './core'

export const OAUTH_READ_SCOPE = 'agentsplit:read'
export const OAUTH_WRITE_SCOPE = 'agentsplit:write'
export const OAUTH_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access', OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE]

export const PROFILE_NAME_MAX = 50
export const API_KEY_NAME_MAX = 32

export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
})

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  /** The first characters of the key, for recognition; never the key. */
  start: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})

export const ConnectedApp = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  /** The current consent still includes agentsplit:write. */
  canWrite: Schema.Boolean,
})

export const Account = Schema.Struct({
  profile: Profile,
  apiKeys: Schema.Array(ApiKeySummary),
  connections: Schema.Array(ConnectedApp),
})

export const ConsentClient = Schema.Struct({ clientId: Schema.String, name: Schema.NullOr(Schema.String) })

export class AccountApi extends RpcGroup.make(
  Rpc.make('account.get', { success: Account, error: ReadError }),
  Rpc.make('account.updateProfile', {
    // The server trims the name and checks its length, so MCP gets the same rule.
    payload: { name: Schema.String.check(Schema.isMaxLength(200)) },
    success: Schema.Struct({ profile: Profile }),
    error: WriteError,
  }),
  Rpc.make('account.revokeApiKey', { payload: { keyId: Id }, success: Schema.Struct({ revoked: Schema.Literal(true) }), error: WriteError }),
  Rpc.make('account.revokeConnection', {
    payload: { clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) },
    success: Schema.Struct({ revoked: Schema.Literal(true) }),
    error: WriteError,
  }),
  /** The client named on the consent page; null when it is unknown or disabled. */
  Rpc.make('account.consentClient', {
    payload: { clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) },
    success: Schema.NullOr(ConsentClient),
    error: ReadError,
  }),
) {}

const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{43}$/
export const isInvitationPath = (path: string) => INVITE_PATH.test(path)

/**
 * A path on this origin, normalized, or null. It refuses protocol-relative
 * and backslash forms such as `//evil.example` and `/\evil.example`, which
 * browsers resolve to another host.
 */
export function sameOriginPath(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return null
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null
  const base = 'https://agentsplit.invalid'
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  return url.origin === base ? url.pathname + url.search + url.hash : null
}

/** The page to open after sign-in: a same-origin path other than the sign-in page itself, or null. */
export function safeNextPath(value: string | null | undefined): string | null {
  const path = sameOriginPath(value)
  return path === null || path.startsWith('/sign-in') ? null : path
}

/** A sign-in callback: a same-origin path, or an absolute URL on `baseUrl`'s origin. */
export function isSafeCallback(value: unknown, baseUrl: string): boolean {
  if (typeof value !== 'string') return false
  if (value.startsWith('/')) return sameOriginPath(value) !== null
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false
  try {
    return new URL(value).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}
