// Group tools: list_groups, get_group, create_group, update_group and
// manage_group_access, with the current app's inputs and output shapes
// (src/trpc/routers/groups/*, src/lib/group-access.ts). Each read is one
// statement whose membership check is part of the query. Writes call the
// groups and ungrouped services, which check access and write the log.
import { Result, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { CURRENCIES, type CurrencyCode } from '../../../shared/currencies'
import { groupAccessDenied, NotFound } from '../../../shared/api'
import { AccessRequest, GroupChanges, GroupCreateInput } from '../../../shared/api/groups'
import { EMAIL, groupPath } from '../../../shared/groups'
import { GROUP_ID } from '../../../shared/ids'
import { LIMITS } from '../../../shared/limits'
import { ROLES, type Role } from '../../../shared/vocabulary'
import type { Db } from '../../db'
import * as groups from '../../groups'
import { displayName, iso } from '../../sql'
import { renewPrivateInvitation } from '../../ungrouped'
import { defineTool, ToolError } from '../registry'
import { DateTime, Id, isCurrencyCode, NonNegativeInt, NullableString, origin } from './shared'

/** The current group wire shape. `currency` is the currency's symbol; v2 stores only the code. */
const GroupFields = {
  id: Id,
  name: Schema.String,
  slug: NullableString,
  information: NullableString,
  revision: NonNegativeInt,
  currency: Schema.String,
  currencyCode: NullableString,
  createdAt: DateTime,
}

type GroupRow = {
  id: string
  name: string
  slug: string | null
  information: string
  revision: number
  default_currency: string
  created_at: string
}

const groupFields = (g: GroupRow) => ({
  id: g.id,
  name: g.name,
  slug: g.slug,
  // The current app stores a missing description as null.
  information: g.information === '' ? null : g.information,
  revision: g.revision,
  currency: CURRENCIES[g.default_currency as CurrencyCode]?.symbol ?? g.default_currency,
  currencyCode: g.default_currency,
  createdAt: g.created_at,
})

const groupColumns = sql`g.id, g.name, g.slug, g.information, g.revision, g.default_currency, ${iso(sql`g.created_at`)} AS created_at`

export const listGroups = defineTool({
  name: 'list_groups',
  kind: 'read',
  description:
    'List named groups available to your user; ungrouped private contexts are excluded. Use list_all_expenses to discover both grouped and ungrouped expenses. Keys inherit the same memberships. Page with nextCursor while hasMore is true; optionally supply a subset of groupIds.',
  input: Schema.Struct({
    groupIds: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).check(Schema.isMaxLength(LIMITS.pageMax))),
    cursor: Schema.optionalKey(NonNegativeInt.annotate({ default: 0 })),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.pageMax })).annotate({ default: LIMITS.pageMax })),
  }),
  strict: [''],
  output: Schema.Struct({
    groups: Schema.Array(Schema.Struct({ ...GroupFields, _count: Schema.Struct({ participants: NonNegativeInt }) })),
    hasMore: Schema.Boolean,
    nextCursor: NonNegativeInt,
  }),
  run: async ({ db, principal }, { groupIds, cursor = 0, limit = LIMITS.pageMax }) => {
    const requested = groupIds ? [...new Set(groupIds)] : null
    // A requested ID outside the caller's memberships fails the whole call, as in the current app.
    if (requested?.length) {
      const ids = sql.join(requested.map((id) => sql`${id}`), sql`, `)
      const denied = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM unnest(ARRAY[${ids}]::text[]) AS r(id)
        WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${principal.userId} AND m.group_id = r.id AND m.active)`)
      if (denied.rows[0]?.n !== 0) throw groupAccessDenied()
    }
    const result = await db.execute<GroupRow & { participants: number }>(sql`
      SELECT ${groupColumns}, (SELECT count(*)::int FROM participants p WHERE p.group_id = g.id) AS participants
      FROM memberships m JOIN groups g ON g.id = m.group_id
      WHERE m.user_id = ${principal.userId} AND m.active AND g.kind = 'named'
        ${requested ? (requested.length ? sql`AND g.id IN (${sql.join(requested.map((id) => sql`${id}`), sql`, `)})` : sql`AND false`) : sql``}
      ORDER BY g.created_at DESC, g.id DESC
      LIMIT ${limit + 1} OFFSET ${cursor}
    `)
    return {
      groups: result.rows.slice(0, limit).map((g) => ({ ...groupFields(g), _count: { participants: g.participants } })),
      hasMore: result.rows.length > limit,
      nextCursor: cursor + limit,
    }
  },
})

type DetailsRow = GroupRow & {
  role: Role
  participant_id: string | null
  context_expense_id: string | null
  participants: { id: string; name: string; groupId: string }[]
  members: { id: string; name: string; email: string; role: string; participantId: string | null }[]
  invitations: { id: string; email: string; expiresAt: string; participantId: string | null; participantName: string | null }[]
  reserved: string[]
  with_expenses: string[]
}

export const getGroup = defineTool({
  name: 'get_group',
  kind: 'read',
  description:
    'Read group or private accounting-context details (context.kind and context.expenseId distinguish them), its revision, participant IDs, member roles, pending invitations (admins only), group/export links, and participant IDs referenced by expenses. access.participantId is your fixed identity (null means an admin must bind a legacy account). Each member is tied to one participant, but any member may record another participant as payer; authenticated authorship remains separate.',
  input: Schema.Struct({ groupId: Schema.String.check(Schema.isMinLength(1)) }),
  strict: [''],
  output: Schema.Struct({
    context: Schema.Struct({ kind: Schema.Literals(['group', 'ungrouped']), expenseId: NullableString }),
    access: Schema.Struct({
      role: Schema.String,
      participantId: NullableString,
      reservedParticipantIds: Schema.Array(Id),
      members: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, email: Schema.String, role: Schema.String, participantId: NullableString })),
      invitations: Schema.Array(
        Schema.Struct({ id: Id, email: Schema.String, expiresAt: DateTime, participantId: NullableString, participantName: NullableString }),
      ),
    }),
    group: Schema.Struct({ ...GroupFields, participants: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, groupId: Id })) }),
    participantsWithExpenses: Schema.Array(Id),
    links: Schema.Struct({ share: Schema.String, csv: Schema.String, json: Schema.String }),
  }),
  run: async ({ db, principal, baseUrl }, { groupId }) => {
    const result = await db.execute<DetailsRow>(sql`
      WITH m AS (SELECT role, participant_id FROM memberships WHERE user_id = ${principal.userId} AND group_id = ${groupId} AND active)
      SELECT ${groupColumns}, m.role, m.participant_id,
        (SELECT pc.expense_id FROM private_contexts pc WHERE pc.group_id = g.id) AS context_expense_id,
        coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${displayName({ group: sql`p.group_id`, participant: sql`p.id`, name: sql`p.name` })}, 'groupId', p.group_id) ORDER BY p.created_at, p.id)
          FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
        coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', mb.role, 'participantId', mb.participant_id) ORDER BY mb.created_at, u.id)
          FROM memberships mb JOIN "user" u ON u.id = mb.user_id WHERE mb.group_id = g.id AND mb.active), '[]') AS members,
        CASE WHEN m.role = 'admin' THEN coalesce((
          SELECT json_agg(json_build_object('id', i.id, 'email', i.email, 'expiresAt', ${iso(sql`i.expires_at`)}, 'participantId', i.participant_id, 'participantName', i.participant_name) ORDER BY i.created_at, i.id)
          FROM invitations i WHERE i.group_id = g.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND (g.kind = 'private' OR i.expires_at > now())), '[]') ELSE '[]' END AS invitations,
        coalesce((SELECT array_agg(p.id ORDER BY p.id) FROM participants p WHERE p.group_id = g.id
          AND (EXISTS (SELECT 1 FROM memberships mb WHERE mb.participant_id = p.id) OR EXISTS (SELECT 1 FROM invitations i WHERE i.participant_id = p.id))), '{}') AS reserved,
        coalesce((SELECT array_agg(DISTINCT x.participant_id ORDER BY x.participant_id) FROM (
          SELECT participant_id FROM expense_payers WHERE group_id = g.id UNION SELECT participant_id FROM expense_shares WHERE group_id = g.id) x), '{}') AS with_expenses
      FROM groups g JOIN m ON true
      WHERE g.id = ${groupId}
    `)
    const g = result.rows[0]
    if (!g) throw groupAccessDenied()
    const path = `${origin(baseUrl)}${groupPath(g)}`
    // A private context has no group page: people open its expense (P-UNGROUP-39).
    const share = g.context_expense_id ? `${origin(baseUrl)}/expenses/${g.context_expense_id}` : path
    return {
      context: { kind: g.context_expense_id ? ('ungrouped' as const) : ('group' as const), expenseId: g.context_expense_id },
      access: {
        role: g.role,
        participantId: g.participant_id,
        reservedParticipantIds: g.reserved,
        members: g.members,
        invitations: g.invitations,
      },
      group: { ...groupFields(g), participants: g.participants },
      participantsWithExpenses: g.with_expenses,
      links: { share, csv: `${path}/expenses/export/csv`, json: `${path}/expenses/export/json` },
    }
  },
})

// ---------- writes ----------

const ParticipantRow = Schema.Struct({ id: Id, name: Schema.String, groupId: Id })
const GroupWritten = Schema.Struct({ groupId: Id, group: Schema.Struct({ ...GroupFields, participants: Schema.Array(ParticipantRow) }) })

/** The group as a write leaves it, in the same transaction. The service has checked access. */
async function readGroup(db: Db, groupId: string): Promise<typeof GroupWritten.Encoded> {
  const result = await db.execute<GroupRow & { participants: { id: string; name: string; groupId: string }[] }>(sql`
    SELECT ${groupColumns},
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${displayName({ group: sql`p.group_id`, participant: sql`p.id`, name: sql`p.name` })}, 'groupId', p.group_id) ORDER BY p.created_at, p.id)
        FROM participants p WHERE p.group_id = g.id), '[]') AS participants
    FROM groups g WHERE g.id = ${groupId}`)
  const g = result.rows[0]
  if (!g) throw new NotFound({ entity: 'group', id: groupId })
  return { groupId: g.id, group: { ...groupFields(g), participants: g.participants } }
}

const NO_CUSTOM_CURRENCY = 'Set currencyCode to a supported currency code, such as USD. Groups use registered currencies, not custom symbols.'

/**
 * The group currency from the current app's pair: currencyCode, else a
 * `currency` that is a code or the symbol of exactly one currency. v2 has no
 * custom symbols (docs/v2/parity/groups.md, P-GROUP-23).
 */
function currencyOf(data: { currency: string | undefined; currencyCode: string | null | undefined }): CurrencyCode {
  if (data.currencyCode) {
    if (!isCurrencyCode(data.currencyCode)) throw new ToolError('BAD_REQUEST', NO_CUSTOM_CURRENCY)
    return data.currencyCode
  }
  const text = data.currency?.trim() ?? ''
  if (isCurrencyCode(text.toUpperCase())) return text.toUpperCase() as CurrencyCode
  const bySymbol = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => CURRENCIES[code].symbol === text)
  const [only] = bySymbol
  if (bySymbol.length !== 1 || !only) throw new ToolError('BAD_REQUEST', NO_CUSTOM_CURRENCY)
  return only
}

/** Applies the RPC contract's checks to a value built from MCP input, as the RPC decoder would. */
function contract<S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] {
  const decoded = Schema.decodeUnknownResult(schema, { errors: 'all' })(value)
  if (Result.isFailure(decoded)) throw new ToolError('BAD_REQUEST', decoded.failure.message)
  return decoded.success
}

const Slug = Schema.NullOr(Schema.String.check(Schema.isMaxLength(LIMITS.slugMax))).annotate({
  description: 'Optional unique group URL slug, e.g. maple. Set null or empty string to remove it.',
})
const CurrencyCodeField = Schema.Union([Schema.NullOr(Schema.String.check(Schema.isBetweenLength(3, 3))), Schema.Literal('')])
const GroupInputFields = {
  name: Schema.String.check(Schema.isBetweenLength(LIMITS.groupNameMin, LIMITS.nameMax)),
  slug: Slug,
  information: Schema.String.check(Schema.isMaxLength(LIMITS.informationMax)),
  currency: Schema.String.check(Schema.isBetweenLength(1, 5)),
  currencyCode: CurrencyCodeField,
}

export const createGroup = defineTool({
  name: 'create_group',
  kind: 'write',
  destructive: false,
  description:
    'Create a group. The authenticated creator is automatically added as a participant using their account name and becomes admin. Supply name, optional unique slug, currency/default currencyCode, and OTHER participant names in group.participants (empty array allowed); do not include the creator. currencyCode must be a supported code (get_reference_data); custom currency symbols are not supported. All keys inherit the fixed membership. An optional caller-minted 21-character groupId prevents accidental duplicate creation; check it before retrying an uncertain result.',
  input: Schema.Struct({
    group: Schema.Struct({
      name: GroupInputFields.name,
      slug: Schema.optionalKey(GroupInputFields.slug),
      information: Schema.optionalKey(GroupInputFields.information),
      currency: GroupInputFields.currency,
      currencyCode: Schema.optionalKey(GroupInputFields.currencyCode),
      participants: Schema.Array(Schema.Struct({ name: Schema.String.check(Schema.isBetweenLength(1, LIMITS.nameMax)) })).check(Schema.isMaxLength(LIMITS.participantsPerGroup - 1)),
    }),
    groupId: Schema.optionalKey(Schema.String.check(Schema.isPattern(GROUP_ID))),
  }),
  strict: [''],
  output: GroupWritten,
  run: async ({ db, principal }, input) => {
    const g = input.group
    const group = contract(GroupCreateInput, {
      name: g.name.trim(),
      slug: g.slug ?? null,
      information: g.information ?? '',
      defaultCurrency: currencyOf({ currency: g.currency, currencyCode: g.currencyCode }),
      participants: g.participants.map((p) => p.name.trim()),
    })
    // Each call is new, so it sends no idempotency key. A reused groupId is an
    // Invalid state error, which errorBody answers as CONFLICT (P-TOOL-CREATEGROUP-04).
    const created = await groups.createGroup(db, { principal, groupId: input.groupId ?? null, idempotencyKey: null, group })
    return readGroup(db, created.id)
  },
})

export const updateGroup = defineTool({
  name: 'update_group',
  kind: 'write',
  description:
    'Admins only: edit group settings (including optional unique slug) or participants using a partial changes object and the current expectedRevision from get_group. Omitted fields stay unchanged. Existing participant IDs preserve identities; entries without IDs create participants. Historical participants cannot be erased. currencyCode must be a supported code.',
  input: Schema.Struct({
    groupId: Schema.String.check(Schema.isMinLength(1)),
    changes: Schema.Struct({
      name: Schema.optionalKey(GroupInputFields.name),
      slug: Schema.optionalKey(GroupInputFields.slug),
      information: Schema.optionalKey(GroupInputFields.information),
      currency: Schema.optionalKey(GroupInputFields.currency),
      currencyCode: Schema.optionalKey(GroupInputFields.currencyCode),
      participants: Schema.optionalKey(
        Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))), name: Schema.String.check(Schema.isBetweenLength(1, LIMITS.nameMax)) })).check(
          Schema.isBetweenLength(1, LIMITS.participantsPerGroup),
        ),
      ),
    }),
    expectedRevision: NonNegativeInt,
  }),
  strict: ['', 'changes'],
  output: GroupWritten,
  run: async ({ db, principal }, input) => {
    const c = input.changes
    const changes = contract(GroupChanges, {
      ...(c.name === undefined ? {} : { name: c.name.trim() }),
      ...(c.slug === undefined ? {} : { slug: c.slug }),
      ...(c.information === undefined ? {} : { information: c.information }),
      ...(c.currency === undefined && c.currencyCode === undefined ? {} : { defaultCurrency: currencyOf({ currency: c.currency, currencyCode: c.currencyCode }) }),
      ...(c.participants === undefined
        ? {}
        : { participants: c.participants.map((p) => ({ ...(p.id === undefined ? {} : { id: p.id }), name: p.name.trim() })) }),
    })
    const updated = await groups.updateGroup(db, { principal, group: input.groupId, expectedRevision: input.expectedRevision, idempotencyKey: null, changes })
    return readGroup(db, updated.id)
  },
})

const ACTIONS = ['join', 'leave', 'invite', 'renew_invitation', 'revoke_invitation', 'remove_member', 'set_role', 'bind_member'] as const
type Action = (typeof ACTIONS)[number]
type AccessField = 'shareUrl' | 'groupId' | 'email' | 'invitationId' | 'userId' | 'participantId' | 'role'

/** The fields each action needs, as the current app's groupAccessInput requires them. */
const REQUIRED: Record<Action, readonly AccessField[]> = {
  join: ['shareUrl'],
  leave: ['groupId'],
  invite: ['groupId', 'email', 'participantId'],
  renew_invitation: ['groupId', 'participantId'],
  revoke_invitation: ['groupId', 'invitationId'],
  remove_member: ['groupId', 'userId'],
  set_role: ['groupId', 'userId', 'role'],
  bind_member: ['groupId', 'userId', 'email', 'participantId'],
}

const AccessInput = Schema.Struct({
  action: Schema.Literals(ACTIONS),
  groupId: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 64))),
  shareUrl: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(2000)).annotate({ format: 'uri', description: 'For join: the email-bound invitation URL, not a group URL.' }),
  ),
  email: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(EMAIL)).annotate({ format: 'email' })),
  invitationId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  userId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  participantId: Schema.optionalKey(
    Schema.String.check(Schema.isBetweenLength(1, 64)).annotate({ description: 'The existing participant to invite or bind. A membership identity cannot later be switched.' }),
  ),
  role: Schema.optionalKey(Schema.Literals(ROLES)),
}).check(
  Schema.makeFilter((input) => {
    const missing = REQUIRED[input.action].filter((field) => !input[field])
    return missing.length === 0 || missing.map((field) => `${field} is required`).join('; ')
  }),
)

/** The current app's texts for what an access change did not find. */
const notFound = (error: NotFound) =>
  error.entity === 'invitation'
    ? new ToolError('NOT_FOUND', error.id === 'token' ? 'Invitation not found or no longer valid' : 'Pending invitation not found')
    : error.entity === 'member'
      ? new ToolError('NOT_FOUND', 'Member not found')
      : error

export const manageGroupAccess = defineTool({
  name: 'manage_group_access',
  kind: 'write',
  description:
    `Manage membership: join with an email-bound invitation shareUrl; leave with groupId. Admin actions: invite with groupId, email and participantId (an existing unclaimed participant) (returns a single-use URL valid for ${LIMITS.invitationDays} days; share it with the intended person), revoke_invitation with invitationId, remove_member with userId, set_role with userId and role=admin|member. Read members, their fixed participantId, and pending invitations with get_group. For an unbound legacy member only, an admin can bind_member with userId, verified email and participantId. For a private ungrouped expense, renew_invitation with groupId and participantId atomically replaces its invitation, including an expired one; only its original email can be invited. For a new named-group participant, first call update_group preserving all existing participants, then invite the returned participantId. This returns a link and sends no email. joined is true only after a join. Identity bindings cannot be changed; removal retains the identity and history. The last admin cannot leave or be demoted. A group URL grants no access. Changes apply immediately to all user keys; ledger history is preserved. Invitations are not idempotent: do not blindly retry an uncertain invite; inspect get_group first.`,
  input: AccessInput,
  strict: [''],
  output: Schema.Struct({
    groupId: Id,
    joined: Schema.Boolean,
    invitation: Schema.optionalKey(
      Schema.Struct({ id: Id, email: Schema.String, expiresAt: DateTime, url: Schema.String, participantId: Id, participantName: Schema.String }),
    ),
  }),
  run: async ({ db, principal, baseUrl }, input) => {
    const field = (name: AccessField) => input[name] ?? ''
    if (input.action === 'renew_invitation') {
      const invitation = await renewPrivateInvitation(db, { principal, baseUrl, groupId: field('groupId'), participantId: field('participantId') })
      return { groupId: field('groupId'), joined: false, invitation }
    }
    const request = contract(AccessRequest, {
      action: input.action,
      ...Object.fromEntries(REQUIRED[input.action].map((name) => [name, field(name)])),
    })
    const result = await groups.changeAccess(db, { principal, baseUrl, idempotencyKey: null, request }).catch((error: unknown) => {
      throw error instanceof NotFound ? notFound(error) : error
    })
    const i = result.invitation
    return {
      groupId: result.groupId,
      // The current app answered true for every action but leave (DECISIONS.md group C, P-TOOL-ACCESS-28).
      joined: input.action === 'join',
      ...(i && i.url && i.participantId ? { invitation: { id: i.id, email: i.email, expiresAt: i.expiresAt, url: i.url, participantId: i.participantId, participantName: i.participantName ?? '' } } : {}),
    }
  },
})

export const groupTools = [listGroups, getGroup, createGroup, updateGroup, manageGroupAccess]
