// The signed-in user's account: profile, API keys, connected apps, and the
// one-time owner bootstrap. This module must not import Better Auth: the RPC
// handlers load it on every isolate.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { authBootstrap, oauthConnections } from '../../db/schema/app'
import * as authSchema from '../../db/schema/auth'
import { Forbidden, Invalid, NotFound, PROFILE_NAME_MAX } from '../shared/api'
import type { Db } from './db'
import type { Principal } from './ledger'

type AccountRow = {
  profile: { id: string; name: string; email: string; emailVerified: boolean }
  apiKeys: { id: string; name: string | null; start: string | null; createdAt: string }[]
  connections: { clientId: string; name: string; canWrite: boolean }[]
}

const iso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

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
        SELECT json_agg(json_build_object('id', k.id, 'name', k.name, 'start', k.start, 'createdAt', ${iso('k.created_at')})
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
  if (!row) throw new NotFound({ entity: 'user', id: data.principal.userId })
  return row.account
}

/** Sets the one global display name of the caller. Past snapshots and audit names keep the old name. */
export async function updateProfile(db: Db, data: { principal: Principal; name: string }) {
  const name = data.name.trim()
  if (name.length < 1 || name.length > PROFILE_NAME_MAX)
    throw new Invalid({ message: `Display name must be 1 to ${PROFILE_NAME_MAX} characters`, field: 'name' })
  const [current] = await db
    .select({ verified: authSchema.user.emailVerified })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, data.principal.userId))
  if (!current) throw new NotFound({ entity: 'user', id: data.principal.userId })
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
  if (!profile) throw new NotFound({ entity: 'user', id: data.principal.userId })
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

/** Keeps the grant tombstone, so old JWTs and racing refreshes never regain access. */
export async function revokeOAuthConnection(db: Db, data: { userId: string; clientId: string }) {
  await db.transaction(async (tx) => {
    await tx
      .update(oauthConnections)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthConnections.userId, data.userId), eq(oauthConnections.clientId, data.clientId), isNull(oauthConnections.revokedAt)))
    for (const table of [authSchema.oauthAccessToken, authSchema.oauthRefreshToken, authSchema.oauthConsent])
      await tx.delete(table).where(and(eq(table.userId, data.userId), eq(table.clientId, data.clientId)))
  })
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

const BOOTSTRAP_ID = 'private-groups-v1'
const BOOTSTRAP_LOCK = 170031011

/**
 * The one-time cutover from the app before accounts: the configured owner,
 * once Google has verified their email, becomes admin of every group recorded
 * in legacy_group_claims. The auth_bootstrap row makes it run at most once,
 * also after memberships are removed later. Returns true when it ran.
 *
 * The current app also imported legacy MCP_ACCESS_GRANTS keys here. Production
 * ran that import already, and the importer copies the resulting key rows.
 */
export async function bootstrapOwner(
  db: Db,
  data: { user: { id: string; email: string; emailVerified: boolean }; bootstrapEmail: string | undefined },
): Promise<boolean> {
  const owner = data.bootstrapEmail?.trim().toLowerCase()
  if (!owner || !data.user.emailVerified || data.user.email.toLowerCase() !== owner) return false
  const done = async (d: Db) => (await d.select({ id: authBootstrap.id }).from(authBootstrap).where(eq(authBootstrap.id, BOOTSTRAP_ID))).length > 0
  if (await done(db)) return false
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`)
    if (await done(tx)) return false
    await tx.execute(sql`
      INSERT INTO memberships (user_id, group_id, role, active)
      SELECT ${data.user.id}, group_id, 'admin', true FROM legacy_group_claims
      ON CONFLICT (user_id, group_id) DO UPDATE SET active = true, role = 'admin'
    `)
    await tx.insert(authBootstrap).values({ id: BOOTSTRAP_ID, userId: data.user.id })
    return true
  })
}
