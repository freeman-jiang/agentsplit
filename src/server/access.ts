// Who is calling, and the one group membership check. Every service and MCP
// tool resolves a group reference here, so an ID, a current slug in any case
// and a retired slug name the same group everywhere (agentsplit_group_id, 0004).
import { sql, type SQL } from 'drizzle-orm'
import { Forbidden, groupAccessDenied } from '../shared/api'
import type { ActivitySource, Role } from '../shared/vocabulary'
import type { Db } from './db'

export type Principal = {
  readonly userId: string
  readonly name: string
  readonly email: string
  /** The activity source: `agent` for an API key or OAuth connection, as in the current app (P-DB-79). */
  readonly source: Exclude<ActivitySource, 'system'>
  /** The API key or OAuth connection an agent used; null on the web. */
  readonly agentKeyId: string | null
}

export type Membership = { groupId: string; role: Role; participantId: string | null }

/** The ID of the group that reference `ref` names, or NULL: its ID, its current slug in any case, or a slug it used before. */
export const groupIdOf = (ref: SQL) => sql`agentsplit_group_id(${ref})`

/**
 * The caller's membership of group `group` as the CTE `g`: the group's columns
 * with the member's `role`, `participant_id` and `active`. No row, or an
 * inactive one, means no access. A statement that starts with it reads rows
 * only from a group the caller belongs to, in the same round trip.
 */
export const memberCte = (data: { principal: Principal; groupId: string }) => sql`g AS (
  SELECT g.*, m.role, m.participant_id, m.active
  FROM groups g JOIN memberships m ON m.group_id = g.id AND m.user_id = ${data.principal.userId}
  WHERE g.id = ${groupIdOf(sql`${data.groupId}`)})`

/** The row of a statement built on memberCte, or the denial. A group that does not exist and one the caller cannot see look the same. */
export function requireActive<T extends { active: boolean | null }>(row: T | undefined): T {
  if (!row?.active) throw groupAccessDenied()
  return row
}

/** The membership check on its own. `admin` is the refusal for a caller who is not an admin. */
export async function requireMember(db: Db, data: { principal: Principal; groupId: string; admin?: string }): Promise<Membership> {
  const result = await db.execute<{ id: string; role: Role; participant_id: string | null; active: boolean }>(
    sql`WITH ${memberCte(data)} SELECT id, role, participant_id, active FROM g`,
  )
  const row = requireActive(result.rows[0])
  if (data.admin !== undefined && row.role !== 'admin') throw new Forbidden({ message: data.admin })
  return { groupId: row.id, role: row.role, participantId: row.participant_id }
}
