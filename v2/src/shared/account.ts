// Pure account rules shared by the client and the server. No Effect import here:
// the client bundle must stay free of the Effect runtime (BUILDING.md).

export const OAUTH_READ_SCOPE = 'agentsplit:read'
export const OAUTH_WRITE_SCOPE = 'agentsplit:write'
export const OAUTH_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access', OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE]

export const PROFILE_NAME_MAX = 50
export const API_KEY_NAME_MAX = 32

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
