// The RPC hot path's session check: verify Better Auth's signed session cookie
// and read the session with one query. It accepts exactly the sessions Better
// Auth's getSession accepts (test/db/session.test.ts compares them), without
// building Better Auth for every request. Sessions are refreshed by Better Auth
// itself, through /api/auth/get-session, which the SPA calls once per load.
import { and, eq, gt } from 'drizzle-orm'
import { parseCookies } from 'better-call'
import { session, user } from '../../db/schema/auth'
import type { Db } from './db'
import type { Principal } from './ledger'

/** Better Auth reads one name: the __Secure- form when the app runs on HTTPS. */
const cookieName = (baseUrl: string) =>
  baseUrl.startsWith('https:') ? '__Secure-better-auth.session_token' : 'better-auth.session_token'

const keys = new Map<string, Promise<CryptoKey>>()
const keyFor = (secret: string) => {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    keys.set(secret, key)
  }
  return key
}

/** The session token if the cookie carries a valid signature, else null. */
export async function verifiedSessionToken(data: { cookie: string | null; secret: string; baseUrl: string }): Promise<string | null> {
  if (!data.cookie) return null
  const cookies = parseCookies(data.cookie)
  const value = cookies.get(cookieName(data.baseUrl))
  if (!value) return null
  const at = value.lastIndexOf('.')
  if (at < 1) return null
  const token = value.slice(0, at)
  const signature = value.slice(at + 1)
  if (signature.length !== 44 || !signature.endsWith('=')) return null
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  const valid = await crypto.subtle.verify('HMAC', await keyFor(data.secret), bytes, new TextEncoder().encode(token))
  return valid ? token : null
}

/** The signed-in web principal: a live session of a verified account, or null. */
export async function sessionPrincipal(db: Db, data: { cookie: string | null; secret: string; baseUrl: string }): Promise<Principal | null> {
  const token = await verifiedSessionToken(data)
  if (!token) return null
  const [row] = await db
    .select({ id: user.id, name: user.name, email: user.email, verified: user.emailVerified })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.token, token), gt(session.expiresAt, new Date())))
    .limit(1)
  if (!row?.verified) return null
  return { userId: row.id, name: row.name, email: row.email, source: 'web', agentKeyId: null }
}

/** The signed-in web principal of a plain HTTP request, from its session cookie, or null. */
export const requestSession = (db: Db, data: { request: Request; secret: string; baseUrl: string }) =>
  sessionPrincipal(db, { cookie: data.request.headers.get('cookie'), secret: data.secret, baseUrl: data.baseUrl })
