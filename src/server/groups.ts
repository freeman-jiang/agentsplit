// Groups and access: the directory, group settings and people, and
// email-bound invitations. Every function checks access itself, so the RPC
// handlers and the MCP tools cannot skip it. Ported from the current app's
// createGroup and updateGroup (src/lib/api.ts) and src/lib/group-access.ts.
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm'
import { groups, groupSlugHistory, invitations, memberships, participants } from '../../db/schema/app'
import { user } from '../../db/schema/auth'
import { Conflict, Forbidden, groupAccessDenied, Invalid, NotFound } from '../shared/api'
import type { AccessRequest, GroupChanges, GroupCreateInput } from '../shared/api/groups'
import type { CurrencyCode } from '../shared/currencies'
import { normalizeEmail, normalizeSlug, slugProblem } from '../shared/groups'
import { groupLimitMessage, LIMITS, participantLimitMessage } from '../shared/limits'
import type { GroupKind, Role } from '../shared/vocabulary'
import type { Db } from './core/db'
import { randomId } from './core/ids'
import { createInvitation, findInvitation, invitationProblem, listedInvitation, openInvitation, revokeInvitations, tokenOfLink } from './invitations'
import { groupIdOf, memberCte, myMemberships, requireActive, requireMember, type Principal } from './core/access'
import { accessText, groupSnapshot, recordGroupEvent } from './activity'
import { formatTotals, netsCte, totalsJson } from './balances'
import { idempotent } from './idempotency'
import { displayNames } from './people'
import { iso } from './sql'

/** The named groups that `userId` created, from their create_group activities (LIMITS.groupsCreated). Groups are never deleted. */
export const groupsCreated = (userId: string) => sql`(SELECT count(*)::int FROM activities a JOIN groups g ON g.id = a.group_id AND g.kind = 'named'
  WHERE a.type = 'create_group' AND a.actor_user_id = ${userId})`

type AccessInput = typeof AccessRequest.Type
type CreateInput = typeof GroupCreateInput.Type
type ChangesInput = typeof GroupChanges.Type

// ---------- reads ----------

/**
 * A page of the caller's named groups, newest first, as the CTE `page`: the
 * directory and MCP's list_groups list the same groups in the same order.
 * `refs` keeps only the groups that its references name.
 */
const groupPage = (data: { principal: Principal; offset: number; limit: number; refs?: SQL }) => sql`page AS (
  SELECT g.id, g.slug, g.name, g.information, g.revision, g.default_currency, g.created_at,
    (SELECT count(*)::int FROM participants p WHERE p.group_id = g.id) AS participant_count
  FROM ${myMemberships(data.principal.userId)} m JOIN groups g ON g.id = m.group_id
  WHERE g.kind = 'named'
    ${data.refs ? sql`AND g.id IN (SELECT ${groupIdOf(sql`r.ref`)} FROM ${data.refs})` : sql``}
  ORDER BY g.created_at DESC, g.id DESC
  OFFSET ${data.offset} LIMIT ${data.limit + 1}
)`

type DirectoryRow = {
  groups: { id: string; slug: string | null; name: string; participantCount: number; createdAt: string }[]
  totals: { currency: CurrencyCode; net: string }[]
  unbound: number
}

/**
 * The /groups page in one statement: a page of the caller's named groups,
 * newest first, and the caller's net balance per currency across every active
 * membership, private expenses included, so it matches the home total.
 */
export async function listDirectory(db: Db, data: { principal: Principal; offset: number }) {
  const { offset } = data
  const result = await db.execute<DirectoryRow>(sql`
    WITH mine AS ${myMemberships(data.principal.userId)},
    ${groupPage({ principal: data.principal, offset, limit: LIMITS.directoryPage })},
    ${netsCte}
    SELECT
      coalesce((SELECT json_agg(json_build_object('id', id, 'slug', slug, 'name', name, 'participantCount', participant_count,
        'createdAt', ${iso(sql`created_at`)}) ORDER BY created_at DESC, id DESC) FROM page), '[]') AS groups,
      ${totalsJson} AS totals,
      (SELECT count(*)::int FROM mine WHERE participant_id IS NULL) AS unbound
  `)
  const [row] = result.rows
  if (!row) throw new Error('The directory query returned no row')
  return {
    groups: row.groups.slice(0, LIMITS.directoryPage),
    nextOffset: row.groups.length > LIMITS.directoryPage ? offset + LIMITS.directoryPage : null,
    totals: formatTotals(row.totals),
    unboundGroupCount: row.unbound,
  }
}

type PageRow = {
  id: string
  slug: string | null
  name: string
  information: string
  revision: number
  default_currency: CurrencyCode
  created_at: string
  participant_count: number
}

/**
 * MCP's list_groups: a page of the caller's named groups, newest first, by
 * offset, as the current app paged them. `groupIds` keeps only the groups it
 * names (IDs or slugs), and one that is not the caller's denies the whole read.
 */
export async function listGroupPage(db: Db, data: { principal: Principal; offset: number; limit: number; groupIds?: readonly string[] }) {
  const requested = data.groupIds ? [...new Set(data.groupIds)] : undefined
  if (requested?.length === 0) return { groups: [], hasMore: false }
  const refs = requested && sql`unnest(ARRAY[${sql.join(requested.map((id) => sql`${id}`), sql`, `)}]::text[]) AS r(ref)`
  if (refs) {
    const denied = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${refs}
      WHERE NOT EXISTS (SELECT 1 FROM ${myMemberships(data.principal.userId)} m WHERE m.group_id = ${groupIdOf(sql`r.ref`)})`)
    if (denied.rows[0]?.n !== 0) throw groupAccessDenied()
  }
  const result = await db.execute<PageRow>(sql`
    WITH ${groupPage({ principal: data.principal, offset: data.offset, limit: data.limit, ...(refs ? { refs } : {}) })}
    SELECT id, slug, name, information, revision, default_currency, ${iso(sql`created_at`)} AS created_at, participant_count
    FROM page ORDER BY page.created_at DESC, page.id DESC`)
  return {
    groups: result.rows.slice(0, data.limit).map((g) => ({
      id: g.id,
      slug: g.slug,
      name: g.name,
      information: g.information,
      revision: g.revision,
      defaultCurrency: g.default_currency,
      createdAt: g.created_at,
      participantCount: g.participant_count,
    })),
    hasMore: result.rows.length > data.limit,
  }
}

type DetailsRow = {
  kind: GroupKind
  id: string
  slug: string | null
  name: string
  information: string
  default_currency: CurrencyCode
  revision: number
  role: Role
  participant_id: string | null
  active: boolean
  people: {
    id: string
    name: string
    memberEmail: string | null
    memberRole: Role | null
    userId: string | null
    invitedEmail: string | null
    inExpenses: boolean
    reserved: boolean
  }[]
  unbound: { userId: string; name: string; email: string; role: Role }[]
  members: { userId: string; name: string; email: string; role: Role; participantId: string | null }[]
  invitations: { id: string; email: string; participantId: string | null; participantName: string | null; expiresAt: string }[]
  context_expense_id: string | null
  created: string
}

/**
 * The Settings tab and MCP's get_group in one statement that also checks the
 * caller's membership. Only admins see invitations.
 */
export async function getGroupDetails(db: Db, data: { principal: Principal; groupId: string }) {
  const result = await db.execute<DetailsRow>(sql`
    WITH ${memberCte(data)},
    pending AS (
      SELECT i.id, i.email, i.participant_id, i.participant_name, i.expires_at FROM invitations i, g
      WHERE i.group_id = g.id AND g.role = 'admin' AND ${listedInvitation({ i: sql`i`, kind: sql`g.kind` })}
    )
    SELECT g.*, ${iso(sql`g.created_at`)} AS created,
      (SELECT pc.expense_id FROM private_contexts pc WHERE pc.group_id = g.id) AS context_expense_id,
      coalesce((SELECT json_agg(json_build_object(
          'id', p.id, 'name', d.name,
          'memberEmail', u.email, 'memberRole', m.role, 'userId', m.user_id,
          'invitedEmail', (SELECT pi.email FROM pending pi WHERE pi.participant_id = p.id LIMIT 1),
          'inExpenses', EXISTS (SELECT 1 FROM expense_payers x WHERE x.participant_id = p.id)
            OR EXISTS (SELECT 1 FROM expense_shares x WHERE x.participant_id = p.id),
          'reserved', EXISTS (SELECT 1 FROM memberships r WHERE r.group_id = g.id AND r.participant_id = p.id)
            OR EXISTS (SELECT 1 FROM invitations r WHERE r.group_id = g.id AND r.participant_id = p.id)
        ) ORDER BY p.created_at, p.id)
        FROM participants p
        JOIN (${displayNames(sql`g.id`)}) d ON d.id = p.id
        LEFT JOIN memberships m ON m.group_id = g.id AND m.participant_id = p.id AND m.active
        LEFT JOIN "user" u ON u.id = m.user_id
        WHERE p.group_id = g.id), '[]') AS people,
      coalesce((SELECT json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'role', m.role) ORDER BY m.created_at, u.id)
        FROM memberships m JOIN "user" u ON u.id = m.user_id
        WHERE m.group_id = g.id AND m.active AND m.participant_id IS NULL), '[]') AS unbound,
      coalesce((SELECT json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'role', m.role, 'participantId', m.participant_id)
          ORDER BY m.created_at, u.id)
        FROM memberships m JOIN "user" u ON u.id = m.user_id WHERE m.group_id = g.id AND m.active), '[]') AS members,
      coalesce((SELECT json_agg(json_build_object('id', id, 'email', email, 'participantId', participant_id, 'participantName', participant_name,
          'expiresAt', ${iso(sql`expires_at`)}) ORDER BY expires_at, id)
        FROM pending), '[]') AS invitations
    FROM g
  `)
  const g = requireActive(result.rows[0])
  return {
    kind: g.kind,
    id: g.id,
    slug: g.slug,
    name: g.name,
    information: g.information,
    defaultCurrency: g.default_currency,
    revision: g.revision,
    role: g.role,
    participantId: g.participant_id,
    people: g.people.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.userId ? ('joined' as const) : p.invitedEmail ? ('invited' as const) : ('none' as const),
      email: p.memberEmail ?? p.invitedEmail,
      role: p.memberRole,
      userId: p.userId,
      inExpenses: p.inExpenses,
      reserved: p.reserved,
    })),
    unboundMembers: g.unbound,
    invitations: g.invitations,
    /** Every active member in the order they joined, with their account name; MCP's get_group lists them. */
    members: g.members,
    /** The expense of a private context; null for a named group. */
    contextExpenseId: g.context_expense_id,
    createdAt: g.created,
  }
}

// ---------- writes: settings and people ----------

/** The normalized slug, null to remove it, or an Invalid error. */
function checkedSlug(raw: string | null): string | null {
  const slug = normalizeSlug(raw ?? '')
  if (!slug) return null
  const problem = slugProblem(slug)
  if (problem) throw new Invalid({ message: problem, field: 'slug' })
  return slug
}

/**
 * Claims a slug for a group. A transaction-scoped lock serializes competing
 * claims, creates included, before the unique index sees them. A claimed slug
 * leaves the history, so its old links follow the new owner.
 */
async function claimSlug(tx: Db, data: { slug: string; groupId: string }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${data.slug}, 0))`)
  const [taken] = await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.slug, data.slug), ne(groups.id, data.groupId)))
  if (taken) throw new Invalid({ message: 'This group URL is already in use.', field: 'slug' })
  await tx.delete(groupSlugHistory).where(eq(groupSlugHistory.slug, data.slug))
}

/** The group and its participants as they are now, for a history snapshot. */
async function currentSnapshot(tx: Db, groupId: string) {
  const [group] = await tx.select().from(groups).where(eq(groups.id, groupId))
  if (!group) throw new NotFound({ entity: 'group', id: groupId })
  const people = await tx.execute<{ id: string; name: string }>(sql`${displayNames(sql`${groupId}`)} ORDER BY p.created_at, p.id`)
  return groupSnapshot({ group, participants: people.rows })
}

export async function createGroup(
  tx: Db,
  data: { principal: Principal; groupId: string | null; idempotencyKey: string | null; group: CreateInput },
): Promise<{ id: string; slug: string | null; revision: number }> {
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request: { op: 'create_group', groupId: data.groupId, group: data.group } }, async () => {
    const groupId = data.groupId ?? randomId()
    const [prior] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId))
    if (prior) throw new Invalid({ message: 'Group ID is already in use; read it before retrying or choose a new ID', field: 'groupId', reason: 'state' })
    // Fair use. Under SERIALIZABLE, two creates that both read the count cannot both commit past it.
    const created = await tx.execute<{ count: number }>(sql`SELECT ${groupsCreated(data.principal.userId)} AS count`)
    if ((created.rows[0]?.count ?? 0) >= LIMITS.groupsCreated) throw new Invalid({ message: groupLimitMessage })
    const creator = { id: randomId(), name: data.principal.name.trim().slice(0, LIMITS.nameMax) || 'Member' }
    const people = [creator, ...data.group.participants.map((name) => ({ id: randomId(), name }))]
    if (people.length > LIMITS.participantsPerGroup) throw new Invalid({ message: participantLimitMessage, field: 'participants' })
    if (new Set(people.map((p) => p.name)).size !== people.length)
      throw new Invalid({ message: 'The creator is added automatically. Give each other participant a distinct name.', field: 'participants' })
    const slug = checkedSlug(data.group.slug)
    if (slug) await claimSlug(tx, { slug, groupId })
    await tx.insert(groups).values({
      id: groupId,
      kind: 'named',
      slug,
      name: data.group.name,
      information: data.group.information,
      defaultCurrency: data.group.defaultCurrency,
      revision: 1,
    })
    // One statement per row keeps created_at in insertion order, so the creator is listed first.
    for (const person of people) await tx.insert(participants).values({ ...person, groupId, createdAt: sql`clock_timestamp()` })
    await tx.insert(memberships).values({ userId: data.principal.userId, groupId, role: 'admin', participantId: creator.id })
    await recordGroupEvent(tx, { groupId, type: 'create_group', principal: data.principal, groupRevision: 1, data: data.group.name, snapshot: await currentSnapshot(tx, groupId) })
    return { id: groupId, slug, revision: 1 }
  })
}

async function lockGroup(tx: Db, groupId: string) {
  const [row] = await tx.select().from(groups).where(eq(groups.id, groupId)).for('update')
  if (!row) throw new NotFound({ entity: 'group', id: groupId })
  return row
}

/**
 * Changes group settings and people. Only admins may; `changes` is partial,
 * and `participants`, when given, is the full list (see GroupChanges). People
 * bound to an account or named by an invitation keep their name, and people in
 * any expense cannot be removed.
 */
export async function updateGroup(
  tx: Db,
  data: { principal: Principal; groupId: string; expectedRevision: number; idempotencyKey: string | null; changes: ChangesInput },
): Promise<{ id: string; slug: string | null; revision: number }> {
  const { groupId } = await requireMember(tx, { ...data, admin: 'Only group admins can edit group settings' })
  const request = { op: 'update_group', groupId, expectedRevision: data.expectedRevision, changes: data.changes }
  return idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request }, async () => {
    const group = await lockGroup(tx, groupId)
    if (group.kind === 'private')
      throw new Invalid({ message: 'A private expense is not a named group. Its people and visibility cannot be changed through group settings.' })
    if (group.revision !== data.expectedRevision) throw new Conflict({ entity: 'group', id: groupId, currentRevision: group.revision })
    const changes = data.changes
    if (Object.keys(changes).length === 0) return { id: group.id, slug: group.slug, revision: group.revision }

    if (changes.participants) await replacePeople(tx, { groupId, people: changes.participants })

    const slug = changes.slug === undefined ? group.slug : checkedSlug(changes.slug)
    if (slug && slug !== group.slug) await claimSlug(tx, { slug, groupId })
    if (group.slug && slug !== group.slug)
      await tx
        .insert(groupSlugHistory)
        .values({ slug: group.slug, groupId })
        .onConflictDoUpdate({ target: groupSlugHistory.slug, set: { groupId, retiredAt: sql`now()` } })
    const revision = group.revision + 1
    await tx
      .update(groups)
      .set({
        revision,
        slug,
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.information === undefined ? {} : { information: changes.information }),
        ...(changes.defaultCurrency === undefined ? {} : { defaultCurrency: changes.defaultCurrency }),
      })
      .where(eq(groups.id, groupId))
    await recordGroupEvent(tx, { groupId, type: 'update_group', principal: data.principal, groupRevision: revision, snapshot: await currentSnapshot(tx, groupId) })
    return { id: groupId, slug, revision }
  })
}

async function replacePeople(tx: Db, data: { groupId: string; people: NonNullable<ChangesInput['participants']> }) {
  const current = await tx.execute<{ id: string; name: string; reserved: boolean; in_expenses: boolean }>(sql`
    SELECT d.id, d.name,
      EXISTS (SELECT 1 FROM memberships r WHERE r.group_id = ${data.groupId} AND r.participant_id = d.id)
        OR EXISTS (SELECT 1 FROM invitations r WHERE r.group_id = ${data.groupId} AND r.participant_id = d.id) AS reserved,
      EXISTS (SELECT 1 FROM expense_payers x WHERE x.participant_id = d.id)
        OR EXISTS (SELECT 1 FROM expense_shares x WHERE x.participant_id = d.id) AS in_expenses
    FROM (${displayNames(sql`${data.groupId}`)}) d
  `)
  // Fair use. A group that is over the limit already can still rename or remove people.
  if (data.people.length > LIMITS.participantsPerGroup && data.people.length > current.rows.length)
    throw new Invalid({ message: participantLimitMessage, field: 'participants' })
  const byId = new Map(current.rows.map((p) => [p.id, p]))
  const seen = new Set<string>()
  for (const person of data.people) {
    if (person.id === undefined) continue
    if (!byId.has(person.id))
      throw new Invalid({ message: 'Existing participant IDs must belong to this group; omit the ID to add someone new', field: 'participants' })
    if (seen.has(person.id)) throw new Invalid({ message: 'Duplicate participant ID', field: 'participants' })
    seen.add(person.id)
  }
  // A new name must differ from every other name; two existing people may keep the same name (P-GROUP-72).
  data.people.forEach((person, i) => {
    if (data.people.some((other, j) => j !== i && other.name === person.name && (person.id === undefined || other.id === undefined)))
      throw new Invalid({ message: `Another person is already called ${person.name}. Give each person a distinct name.`, field: 'participants' })
  })
  const kept = new Map(data.people.flatMap((p) => (p.id === undefined ? [] : [[p.id, p.name] as const])))
  for (const person of current.rows) {
    if (person.reserved && kept.get(person.id) !== person.name)
      throw new Invalid({ message: 'Members and invited participant identities cannot be renamed or removed.', field: 'participants', reason: 'state' })
    if (!kept.has(person.id) && person.in_expenses)
      throw new Invalid({ message: `${person.name} is part of expenses, so they cannot be removed.`, field: 'participants' })
  }
  const removed = current.rows.filter((p) => !kept.has(p.id)).map((p) => p.id)
  if (removed.length) await tx.delete(participants).where(and(eq(participants.groupId, data.groupId), inArray(participants.id, removed)))
  for (const [id, name] of kept)
    if (byId.get(id)?.name !== name) await tx.update(participants).set({ name }).where(and(eq(participants.id, id), eq(participants.groupId, data.groupId)))
  for (const person of data.people)
    if (person.id === undefined)
      await tx.insert(participants).values({ id: randomId(), groupId: data.groupId, name: person.name, createdAt: sql`clock_timestamp()` })
}

// ---------- writes: access ----------

type AccessResult = {
  groupId: string
  joined: boolean
  invitation: { id: string; email: string; participantId: string | null; participantName: string | null; expiresAt: string; url: string | null } | null
}

/** The invitation that a join's link names, or an error. */
async function invitationOfLink(tx: Db, data: { shareUrl: string; baseUrl: string }) {
  const token = tokenOfLink(data)
  if (!token) throw new Invalid({ message: 'Use an email-bound invitation link from this app. A group URL does not grant access.', field: 'shareUrl' })
  const invitation = await findInvitation(tx, token)
  if (!invitation) throw new NotFound({ entity: 'invitation', id: 'token' })
  return invitation
}

/**
 * Every membership change: join, leave, invite, revoke, remove, set a role,
 * and bind an identity. Each writes its activity. Invitee emails stay out of
 * the log (DECISIONS.md, P-ACCESS-30). An invitation URL holds its secret, so
 * it is returned once and never stored; a retried invite returns `url: null`.
 */
export async function changeAccess(
  tx: Db,
  data: { principal: Principal; baseUrl: string; idempotencyKey: string | null; request: AccessInput },
): Promise<AccessResult> {
  let url: string | null = null
  const result = await idempotent(tx, { principal: data.principal, key: data.idempotencyKey, request: { op: 'access', ...data.request } }, async () => {
    const out = await applyAccess(tx, data)
    url = out.url
    return out.result
  })
  return url && result.invitation ? { ...result, invitation: { ...result.invitation, url } } : result
}

async function applyAccess(
  tx: Db,
  data: { principal: Principal; baseUrl: string; request: AccessInput },
): Promise<{ result: AccessResult; url: string | null }> {
  const input = data.request
  const me = data.principal
  const pendingInvitation = input.action === 'join' ? await invitationOfLink(tx, { shareUrl: input.shareUrl, baseUrl: data.baseUrl }) : null
  const groupId = pendingInvitation?.groupId ?? (input.action === 'join' ? null : (await resolveGroup(tx, input.groupId)))
  if (!groupId) throw groupAccessDenied()
  const group = await lockGroup(tx, groupId)
  const [membership] = await tx.select().from(memberships).where(and(eq(memberships.userId, me.userId), eq(memberships.groupId, groupId)))
  const done = (joined = true): { result: AccessResult; url: null } => ({ result: { groupId, joined, invitation: null }, url: null })
  const log = (entry: { type: 'join_group' | 'leave_group' | 'update_group'; data: string; participantId?: string | null }) =>
    recordGroupEvent(tx, { groupId, principal: me, ...entry })

  if (group.kind === 'private') {
    if (input.action === 'remove_member' || input.action === 'set_role') throw new Forbidden({ message: 'Private expense membership cannot be reassigned.' })
    if (input.action === 'invite' || input.action === 'bind_member') {
      const [person] = await tx.execute<{ email: string }>(
        sql`SELECT email FROM private_people WHERE group_id = ${groupId} AND participant_id = ${input.participantId}`,
      ).then((r) => r.rows)
      if (!person || person.email !== normalizeEmail(input.email))
        throw new Forbidden({ message: 'Only the original people may access this private expense.' })
    }
  }

  if (input.action === 'join') {
    const invitation = pendingInvitation
    if (!invitation) throw groupAccessDenied()
    const problem = invitationProblem({ invitation, email: me.email })
    if (problem === 'closed') throw new Forbidden({ message: 'This invitation is expired, revoked, or addressed to a different email' })
    if (problem === 'no-participant' || !invitation.participantId)
      throw new Invalid({ message: 'This older invitation has no participant identity. Ask an admin to issue a new invitation.', reason: 'state' })
    if (membership?.participantId && membership.participantId !== invitation.participantId)
      throw new Invalid({ message: 'Your account is already tied to another participant in this group.', reason: 'state' })
    const [claimed] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.groupId, groupId), eq(memberships.participantId, invitation.participantId), ne(memberships.userId, me.userId)))
    if (claimed) throw new Invalid({ message: 'This participant is already tied to another account.', reason: 'state' })
    if (invitation.acceptedAt) {
      if (membership?.active) return done()
      throw new Invalid({ message: 'Invitation already used', reason: 'state' })
    }
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id))
    if (membership)
      await tx
        .update(memberships)
        .set({ active: true, participantId: invitation.participantId, role: membership.active ? membership.role : 'member' })
        .where(and(eq(memberships.userId, me.userId), eq(memberships.groupId, groupId)))
    else await tx.insert(memberships).values({ userId: me.userId, groupId, role: 'member', participantId: invitation.participantId })
    await log({ type: 'join_group', data: accessText({ action: 'join', whom: me.name }), participantId: invitation.participantId })
    return done()
  }

  if (!membership?.active) throw groupAccessDenied()
  if (input.action !== 'leave' && membership.role !== 'admin') throw new Forbidden({ message: 'Only group admins can manage access' })

  if (input.action === 'invite' || input.action === 'bind_member') {
    const email = normalizeEmail(input.email)
    const [participant] = await tx.select().from(participants).where(and(eq(participants.id, input.participantId), eq(participants.groupId, groupId)))
    if (!participant) throw new Invalid({ message: 'Choose a participant in this group.', field: 'participantId' })
    const [target] = await tx.select().from(user).where(sql`lower(${user.email}) = ${email}`)
    const [targetAccess] = target
      ? await tx.select().from(memberships).where(and(eq(memberships.userId, target.id), eq(memberships.groupId, groupId)))
      : []
    if (targetAccess?.participantId && targetAccess.participantId !== participant.id)
      throw new Invalid({ message: 'That account is already tied to a different participant.', reason: 'state' })
    const [claimed] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.groupId, groupId), eq(memberships.participantId, participant.id)))
    if (claimed && claimed.userId !== target?.id) throw new Invalid({ message: 'That participant is already tied to another account.', reason: 'state' })
    const [pending] = await tx
      .execute(sql`SELECT 1 FROM invitations i WHERE i.group_id = ${groupId} AND ${openInvitation(sql`i`)} AND (i.email = ${email} OR i.participant_id = ${participant.id}) LIMIT 1`)
      .then((result) => result.rows)
    if (pending) throw new Invalid({ message: 'An invitation already reserves this email or participant. Revoke it before making another.', reason: 'state' })

    if (input.action === 'bind_member') {
      if (!target?.emailVerified || target.id !== input.userId || !targetAccess?.active)
        throw new Invalid({ message: 'The verified email must match the existing member account.' })
      if (targetAccess.participantId) throw new Invalid({ message: 'This member already has a fixed identity.', reason: 'state' })
      await tx.update(memberships).set({ participantId: participant.id }).where(and(eq(memberships.userId, target.id), eq(memberships.groupId, groupId)))
      await log({ type: 'update_group', data: accessText({ action: 'Member identity bound', whom: `${target.name} as ${participant.name}` }), participantId: participant.id })
      return done()
    }
    if (targetAccess?.active) throw new Invalid({ message: 'That account is already a member. Bind its identity in member settings if needed.', reason: 'state' })

    const { url, ...invitation } = await createInvitation(tx, {
      groupId,
      email,
      participantId: participant.id,
      participantName: participant.name,
      createdBy: me.userId,
      baseUrl: data.baseUrl,
    })
    await log({ type: 'update_group', data: `Invitation created for ${participant.name}`, participantId: participant.id })
    return { result: { groupId, joined: true, invitation: { ...invitation, url: null } }, url }
  }

  if (input.action === 'revoke_invitation') {
    const [row] = await revokeInvitations(tx, { groupId, invitationId: input.invitationId })
    if (!row) throw new NotFound({ entity: 'pendingInvitation', id: input.invitationId })
    await log({ type: 'update_group', data: `Invitation revoked${row.participantName ? ` for ${row.participantName}` : ''}` })
    return done()
  }

  // leave, remove_member, set_role
  const targetUserId = input.action === 'leave' ? me.userId : input.userId
  const [target] = await tx
    .select({ role: memberships.role, active: memberships.active, participantId: memberships.participantId, name: user.name })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.userId, targetUserId), eq(memberships.groupId, groupId)))
  if (!target?.active) throw new NotFound({ entity: 'member', id: targetUserId })
  const nextRole = input.action === 'set_role' ? input.role : null
  if (target.role === 'admin' && nextRole !== 'admin') {
    const [admins] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.groupId, groupId), eq(memberships.active, true), eq(memberships.role, 'admin')))
    if ((admins?.count ?? 0) <= 1) throw new Invalid({ message: 'Choose another admin before removing or demoting the last admin', reason: 'state' })
  }
  const where = and(eq(memberships.userId, targetUserId), eq(memberships.groupId, groupId))
  if (nextRole) {
    await tx.update(memberships).set({ role: nextRole }).where(where)
    await log({ type: 'update_group', data: accessText({ action: 'set_role', whom: `${target.name} is now ${nextRole === 'admin' ? 'an admin' : 'a member'}` }), participantId: target.participantId })
    return done()
  }
  await tx.update(memberships).set({ active: false }).where(where)
  if (input.action === 'leave') {
    await log({ type: 'leave_group', data: accessText({ action: 'leave', whom: target.name }), participantId: target.participantId })
    return done(false)
  }
  await log({ type: 'update_group', data: accessText({ action: 'remove_member', whom: target.name }), participantId: target.participantId })
  return done()
}

async function resolveGroup(tx: Db, ref: string) {
  const result = await tx.execute<{ id: string | null }>(sql`SELECT ${groupIdOf(sql`${ref}`)} AS id`)
  return result.rows[0]?.id ?? null
}

/** What the invite page shows to the signed-in visitor. Anything but a usable invitation for this account is "unavailable". */
export async function previewInvitation(db: Db, data: { principal: Principal; token: string }) {
  const invitation = await findInvitation(db, data.token)
  if (!invitation || invitationProblem({ invitation, email: data.principal.email })) return { status: 'unavailable' as const }
  const [group] = await db.select({ kind: groups.kind, name: groups.name }).from(groups).where(eq(groups.id, invitation.groupId))
  if (!group) return { status: 'unavailable' as const }
  return { status: 'valid' as const, kind: group.kind, groupName: group.name, participantName: invitation.participantName ?? '' }
}
