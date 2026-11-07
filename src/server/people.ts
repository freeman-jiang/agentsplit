// People: the names shown for participants, and the accounts a caller may add
// to an ungrouped expense.
import { sql, type SQL } from 'drizzle-orm'
import type { Db } from './core/db'

/**
 * The name to show for a participant: the bound, verified account's current
 * name, else `name`, the participant's own name, as in the current app
 * (P-GROUP-55). The group filter lets the (group_id, participant_id) unique
 * index find the membership.
 */
export const displayName = (data: { group: SQL; participant: SQL; name: SQL }) => sql`coalesce(
  (SELECT bu.name FROM memberships bm JOIN "user" bu ON bu.id = bm.user_id AND bu.email_verified
    WHERE bm.group_id = ${data.group} AND bm.participant_id = ${data.participant}),
  ${data.name})`

/** The display name of participant row `p`. */
export const participantName = displayName({ group: sql`p.group_id`, participant: sql`p.id`, name: sql`p.name` })

/** The participants of group `groupId` with their display names, as rows `p(id, name)`. */
export const displayNames = (groupId: SQL) => sql`
  SELECT p.id, ${participantName} AS name
  FROM participants p WHERE p.group_id = ${groupId}`

/**
 * The caller and the verified accounts with a linked participant in any group
 * or context the caller can see. Nobody else is discoverable.
 */
export const contactsSql = (userId: string) => sql`
  SELECT u.id, u.name, u.email FROM "user" u
  WHERE u.email_verified AND (u.id = ${userId} OR u.id IN (
    SELECT pm.user_id FROM memberships pm
    WHERE pm.active AND pm.participant_id IS NOT NULL
      AND pm.group_id IN (SELECT group_id FROM memberships WHERE user_id = ${userId} AND active)))`

export async function contacts(db: Db, data: { userId: string }) {
  const result = await db.execute<{ id: string; name: string; email: string }>(contactsSql(data.userId))
  return result.rows
}
