// The signed-in user's account: profile, API keys and connected apps. This
// module does not import Better Auth: the RPC handlers do not call Better Auth
// (docs/v2/BUILDING.md).
import { and, eq, sql } from 'drizzle-orm'
import * as authSchema from '../../db/schema/auth'
import { Forbidden, Invalid, NotFound } from '../shared/api'
import { trimmedName } from '../shared/groups'
import { LIMITS } from '../shared/limits'
import type { Db } from './core/db'
import type { Principal } from './core/access'
import { revokeOAuthConnection } from './auth/oauth-connections'
import { iso } from './sql'

type AccountRow = {
  profile: { id: string; name: string; email: string; emailVerified: boolean }
  apiKeys: { id: string; name: string | null; start: string | null; createdAt: string }[]
  connections: { clientId: string; name: string; canWrite: boolean }[]
}

/**
 * The settings screens in one statement. Connected apps are the clients with
 * an unrevoked connection and a current consent, newest connection first.
 * Write access needs both a connection and the current consent to include it.
 */
export async function getAccount(db: Db, data: { principal: Principal }): Promise<AccountRow> {
  const result = await db.execute<{ account: AccountRow }>(sql`
    SELECT json_build_object(
      'profile', json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'emailVerified', u.email_verified),
      'apiKeys', COALESCE((
        SELECT json_agg(json_build_object('id', k.id, 'name', k.name, 'start', k.start, 'createdAt', ${iso(sql`k.created_at`)})
          ORDER BY k.created_at DESC, k.id)
        FROM apikey k WHERE k.reference_id = u.id
      ), '[]'::json),
      'connections', COALESCE((
        SELECT json_agg(json_build_object(
            'clientId', g.client_id,
            'name', COALESCE(oc.name, 'Connected app'),
            'canWrite', 'agentsplit:write' = ANY(g.scopes) AND EXISTS (
              SELECT 1 FROM oauth_consent s WHERE s.user_id = u.id AND s.client_id = g.client_id AND 'agentsplit:write' = ANY(s.scopes))
          ) ORDER BY g.latest DESC, g.client_id)
        FROM (
          SELECT c.client_id, max(c.created_at) AS latest, array_agg(DISTINCT scope) AS scopes
          FROM oauth_connections c, unnest(c.scopes) AS scope
          WHERE c.user_id = u.id AND c.revoked_at IS NULL
          GROUP BY c.client_id
        ) g
        JOIN oauth_client oc ON oc.client_id = g.client_id
        WHERE EXISTS (SELECT 1 FROM oauth_consent s WHERE s.user_id = u.id AND s.client_id = g.client_id)
      ), '[]'::json)
    ) AS account
    FROM "user" u WHERE u.id = ${data.principal.userId}
  `)
  const row = result.rows[0]
  if (!row) throw new NotFound({ entity: 'account', id: data.principal.userId })
  return row.account
}

/** Sets the one global display name of the caller. Past snapshots and audit names keep the old name. */
export async function updateProfile(db: Db, data: { principal: Principal; name: string }) {
  const name = trimmedName(data.name)
  if (name === null) throw new Invalid({ message: `Display name must be 1 to ${LIMITS.nameMax} characters`, field: 'name' })
  const [current] = await db
    .select({ verified: authSchema.user.emailVerified })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, data.principal.userId))
  if (!current) throw new NotFound({ entity: 'account', id: data.principal.userId })
  if (!current.verified) throw new Forbidden({ message: 'Verify your email before setting your display name.' })
  const [profile] = await db
    .update(authSchema.user)
    .set({ name, updatedAt: new Date() })
    .where(eq(authSchema.user.id, data.principal.userId))
    .returning({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      emailVerified: authSchema.user.emailVerified,
    })
  if (!profile) throw new NotFound({ entity: 'account', id: data.principal.userId })
  return { profile }
}

/** Deletes one of the caller's own keys. Another user's key looks the same as a missing one. */
export async function revokeApiKey(db: Db, data: { principal: Principal; keyId: string }) {
  const deleted = await db
    .delete(authSchema.apikey)
    .where(and(eq(authSchema.apikey.id, data.keyId), eq(authSchema.apikey.referenceId, data.principal.userId)))
    .returning({ id: authSchema.apikey.id })
  if (deleted.length === 0) throw new NotFound({ entity: 'apiKey', id: data.keyId })
  return { revoked: true as const }
}

export async function revokeConnection(db: Db, data: { principal: Principal; clientId: string }) {
  await revokeOAuthConnection(db, { userId: data.principal.userId, clientId: data.clientId })
  return { revoked: true as const }
}

/** The client a consent page names, or null when it is unknown or disabled. */
export async function consentClient(db: Db, data: { clientId: string }) {
  const [client] = await db
    .select({ clientId: authSchema.oauthClient.clientId, name: authSchema.oauthClient.name, disabled: authSchema.oauthClient.disabled })
    .from(authSchema.oauthClient)
    .where(eq(authSchema.oauthClient.clientId, data.clientId))
  if (!client || client.disabled) return null
  return { clientId: client.clientId, name: client.name }
}
