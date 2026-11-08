// Web sessions without Google: a session row and Better Auth's signed cookie for it.
import { serializeSignedCookie } from 'better-call'
import { session } from '../../db/schema/auth'
import { sessionCookieName } from '../../src/server/auth/session'
import type { Db } from '../../src/server/core/db'

export type SessionCookie = { readonly name: string; readonly value: string; readonly header: string }

/** The session cookie for `token`, signed with `secret`, under the name Better Auth reads at `baseUrl`. */
export async function signedSessionCookie(data: { token: string; secret: string; baseUrl: string }): Promise<SessionCookie> {
  const name = sessionCookieName(data.baseUrl)
  const header = (await serializeSignedCookie(name, data.token, data.secret)).split(';')[0] ?? ''
  return { name, value: header.slice(name.length + 1), header }
}

/** A new session of `userId` for a day, and its signed cookie. */
export async function signIn(db: Db, data: { userId: string; secret: string; baseUrl: string }): Promise<SessionCookie> {
  const token = crypto.getRandomValues(new Uint8Array(32)).reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')
  const now = new Date()
  await db.insert(session).values({ id: `s-${token.slice(0, 16)}`, token, userId: data.userId, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now })
  return signedSessionCookie({ token, ...data })
}
