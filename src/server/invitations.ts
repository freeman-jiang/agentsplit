// Email-bound invitations, for named groups and private contexts alike: the
// link's token and its stored hash, the expiry, creation and revocation, and
// when an invitation is pending, open or usable.
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { invitations } from '../../db/schema/app'
import { INVITATION_TOKEN, invitationTokenOfPath, normalizeEmail } from '../shared/groups'
import { LIMITS } from '../shared/limits'
import type { Db } from './db'
import { randomId, randomToken, sha256Hex } from './ids'

export type Invitation = typeof invitations.$inferSelect

/** The stored form of a token: hex SHA-256, as in the current app, so imported invitations keep working. */
const tokenHash = (token: string) => sha256Hex(token)

/** Not accepted and not revoked, on invitation row `i`. */
const pending = (i: SQL) => sql`${i}.accepted_at IS NULL AND ${i}.revoked_at IS NULL`

/** Pending and not expired: it can still be used, and it reserves its email and participant. */
export const openInvitation = (i: SQL) => sql`${pending(i)} AND ${i}.expires_at > now()`

/**
 * The invitations an admin sees, on invitation row `i` of a group of kind
 * `kind`: the open ones, and in a private context also the expired ones,
 * which its creator renews.
 */
export const listedInvitation = (data: { i: SQL; kind: SQL }) => sql`${pending(data.i)} AND (${data.kind} = 'private' OR ${data.i}.expires_at > now())`

/**
 * Why the account with `email` cannot use the invitation now, or null:
 * `closed` when it is revoked, expired or addressed to another email, and
 * `no-participant` for an older invitation without a participant identity.
 * An accepted invitation stays usable by its member, whom a join leaves as is.
 */
export function invitationProblem(data: { invitation: Invitation; email: string }): 'closed' | 'no-participant' | null {
  const { invitation } = data
  if (invitation.revokedAt || invitation.expiresAt <= new Date() || invitation.email !== normalizeEmail(data.email)) return 'closed'
  return invitation.participantId ? null : 'no-participant'
}

/** The invitation of a token, or null for a malformed or unknown one. */
export async function findInvitation(db: Db, token: string): Promise<Invitation | null> {
  if (!INVITATION_TOKEN.test(token)) return null
  const [row] = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash(token)))
  return row ?? null
}

/** The token of an invitation link of this app, or null. Only `<this origin>/invite/<token>` links count (P-ACCESS-42). */
export function tokenOfLink(data: { shareUrl: string; baseUrl: string }): string | null {
  let url: URL
  try {
    url = new URL(data.shareUrl)
  } catch {
    return null
  }
  if (url.origin !== new URL(data.baseUrl).origin || url.username || url.password) return null
  return invitationTokenOfPath(url.pathname)
}

/**
 * Creates an invitation that expires after LIMITS.invitationDays. Its link
 * holds the secret, so it is returned here once and never stored.
 */
export async function createInvitation(
  tx: Db,
  data: { groupId: string; email: string; participantId: string; participantName: string; createdBy: string; baseUrl: string },
) {
  const token = randomToken()
  const invitation = {
    id: randomId(),
    groupId: data.groupId,
    email: normalizeEmail(data.email),
    participantId: data.participantId,
    participantName: data.participantName,
    tokenHash: tokenHash(token),
    createdBy: data.createdBy,
    expiresAt: new Date(Date.now() + LIMITS.invitationDays * 86_400_000),
  }
  await tx.insert(invitations).values(invitation)
  return {
    id: invitation.id,
    email: invitation.email,
    participantId: invitation.participantId,
    participantName: invitation.participantName,
    expiresAt: invitation.expiresAt.toISOString(),
    url: new URL(`/invite/${token}`, data.baseUrl).href,
  }
}

/** Revokes pending invitations of a group: one by ID, or every one of a participant. Returns the revoked rows. */
export async function revokeInvitations(tx: Db, data: { groupId: string } & ({ invitationId: string } | { participantId: string })) {
  return tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.groupId, data.groupId),
        'invitationId' in data ? eq(invitations.id, data.invitationId) : eq(invitations.participantId, data.participantId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ participantName: invitations.participantName })
}
