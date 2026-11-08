// The owner's first sign-in after the cutover (docs/v2/CUTOVER.md). Better Auth
// runs it once per sign-in (auth.ts); it is a no-op for everyone else.
import { eq, sql } from 'drizzle-orm'
import { authBootstrap } from '../../../db/schema/app'
import { normalizeEmail } from '../../shared/groups'
import { ADVISORY_LOCKS, type Db } from '../core/db'

const BOOTSTRAP_ID = 'private-groups-v1'

/**
 * The one-time cutover from the app before accounts: the configured owner,
 * once Google has verified their email, becomes admin of every group recorded
 * in legacy_group_claims. The auth_bootstrap row makes it run at most once,
 * also after memberships are removed later. Returns true when it ran.
 *
 * The current app also imported legacy MCP_ACCESS_GRANTS keys here. Production
 * ran that import before the cutover.
 */
export async function bootstrapOwner(
  db: Db,
  data: { user: { id: string; email: string; emailVerified: boolean }; bootstrapEmail: string | undefined },
): Promise<boolean> {
  const owner = data.bootstrapEmail === undefined ? '' : normalizeEmail(data.bootstrapEmail)
  if (!owner || !data.user.emailVerified || normalizeEmail(data.user.email) !== owner) return false
  const done = async (d: Db) => (await d.select({ id: authBootstrap.id }).from(authBootstrap).where(eq(authBootstrap.id, BOOTSTRAP_ID))).length > 0
  if (await done(db)) return false
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.ownerBootstrap})`)
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
