// Synthetic callers and their account rows.
import type { user } from '../../db/schema/auth'
import type { Principal } from '../../src/server/core/access'

/** A caller with the email `<userId>@example.com`. */
export const principal = (userId: string, data: { name?: string; source?: Principal['source']; agentKeyId?: string | null } = {}): Principal => ({
  userId,
  name: data.name ?? userId,
  email: `${userId}@example.com`,
  source: data.source ?? 'web',
  agentKeyId: data.agentKeyId ?? null,
})

/**
 * Account rows for callers: a membership needs its user (migration 0009).
 * Unverified emails keep the participant names in group views; a verified
 * account names its participant.
 */
export const userRows = (people: readonly Pick<Principal, 'userId' | 'name' | 'email'>[], data: { verified?: boolean } = {}): (typeof user.$inferInsert)[] => {
  const now = new Date()
  return people.map((p) => ({ id: p.userId, name: p.name, email: p.email, emailVerified: data.verified ?? false, createdAt: now, updatedAt: now }))
}
