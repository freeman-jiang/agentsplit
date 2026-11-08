// Group tools: list_groups, get_group, create_group, update_group and
// manage_group_access, with the current app's inputs and output shapes
// (src/trpc/routers/groups/*, src/lib/group-access.ts). They call the groups
// and ungrouped services, which check access and write the log.
import { Result, Schema } from 'effect'
import { Id as IdInput, Invalid, NewId } from '../../../shared/api'
import { AccessRequest, Email, GROUP_NAME_LENGTH, GroupName, Information, PERSON_NAME_LENGTH, PersonName, ShareUrl, SlugInput, type GroupChanges, type GroupCreateInput } from '../../../shared/api/groups'
import { CURRENCIES, CURRENCY_CODES, isCurrencyCode, type CurrencyCode } from '../../../shared/currencies'
import { groupPath } from '../../../shared/groups'
import { absoluteUrl, expensePagePath, exportPath } from '../../../shared/paths'
import { compareIds } from '../../../shared/ids'
import { LIMITS } from '../../../shared/limits'
import { ROLES } from '../../../shared/vocabulary'
import type { Db } from '../../core/db'
import * as groups from '../../groups'
import type { Principal } from '../../core/access'
import { renewPrivateInvitation } from '../../ungrouped'
import { defineTool } from './registry'
import { PageLimit, trimmed } from './inputs'
import { DateTime, GroupFields, groupFields, GroupParticipant, Id, NonNegativeInt, NullableString, optional } from './wire'

export const listGroups = defineTool({
  name: 'list_groups',
  kind: 'read',
  description:
    'List named groups available to your user; ungrouped private contexts are excluded. Use list_all_expenses to discover both grouped and ungrouped expenses. Keys inherit the same memberships. Page with nextCursor while hasMore is true; optionally supply a subset of groupIds.',
  input: Schema.Struct({
    groupIds: optional(Schema.Array(IdInput).check(Schema.isMaxLength(LIMITS.pageMax))),
    cursor: optional(NonNegativeInt.annotate({ default: 0 })),
    limit: optional(PageLimit(LIMITS.pageMax)),
  }),
  strict: [''],
  output: Schema.Struct({
    groups: Schema.Array(Schema.Struct({ ...GroupFields, _count: Schema.Struct({ participants: NonNegativeInt }) })),
    hasMore: Schema.Boolean,
    nextCursor: NonNegativeInt,
  }),
  run: async ({ db, principal }, { groupIds, cursor = 0, limit = LIMITS.pageMax }) => {
    const page = await groups.listGroupPage(db, { principal, offset: cursor, limit, ...(groupIds ? { groupIds } : {}) })
    return {
      groups: page.groups.map((g) => ({ ...groupFields(g), _count: { participants: g.participantCount } })),
      hasMore: page.hasMore,
      nextCursor: cursor + limit,
    }
  },
})

/** A group as get_group and the group writes show it, from the groups service (which checks the membership). */
async function readGroup(db: Db, data: { principal: Principal; groupId: string }) {
  const g = await groups.getGroupDetails(db, data)
  return { ...g, wire: { ...groupFields(g), participants: g.people.map((p) => ({ id: p.id, name: p.name, groupId: g.id })) } }
}

export const getGroup = defineTool({
  name: 'get_group',
  kind: 'read',
  description:
    'Read group or private accounting-context details (context.kind and context.expenseId distinguish them), its revision, participant IDs, member roles, pending invitations (admins only), group/export links, and participant IDs referenced by expenses. access.participantId is your fixed identity (null means an admin must bind a legacy account). Each member is tied to one participant, but any member may record another participant as payer; authenticated authorship remains separate.',
  input: Schema.Struct({ groupId: IdInput }),
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
    group: Schema.Struct({ ...GroupFields, participants: Schema.Array(GroupParticipant) }),
    participantsWithExpenses: Schema.Array(Id),
    links: Schema.Struct({ share: Schema.String, csv: Schema.String, json: Schema.String }),
  }),
  run: async ({ db, principal, baseUrl }, { groupId }) => {
    const g = await readGroup(db, { principal, groupId })
    const link = (path: string) => absoluteUrl({ baseUrl, path })
    // A private context has no group page: people open its expense (P-UNGROUP-39).
    const share = link(g.contextExpenseId ? expensePagePath(g.contextExpenseId) : groupPath(g))
    const ids = (people: readonly { id: string }[]) => people.map((p) => p.id).sort(compareIds)
    return {
      context: { kind: g.contextExpenseId ? ('ungrouped' as const) : ('group' as const), expenseId: g.contextExpenseId },
      access: {
        role: g.role,
        participantId: g.participantId,
        reservedParticipantIds: ids(g.people.filter((p) => p.reserved)),
        members: g.members.map((m) => ({ id: m.userId, name: m.name, email: m.email, role: m.role, participantId: m.participantId })),
        invitations: g.invitations,
      },
      group: g.wire,
      participantsWithExpenses: ids(g.people.filter((p) => p.inExpenses)),
      links: { share, csv: link(exportPath({ groupPath: groupPath(g), format: 'csv' })), json: link(exportPath({ groupPath: groupPath(g), format: 'json' })) },
    }
  },
})

// ---------- writes ----------

const GroupWritten = Schema.Struct({ groupId: Id, group: Schema.Struct({ ...GroupFields, participants: Schema.Array(GroupParticipant) }) })

/** The group as a write leaves it, in the same transaction. */
const written = async (db: Db, data: { principal: Principal; groupId: string }): Promise<typeof GroupWritten.Encoded> => {
  const g = await readGroup(db, data)
  return { groupId: g.id, group: g.wire }
}

const NO_CUSTOM_CURRENCY = 'Set currencyCode to a supported currency code, such as USD. Groups use registered currencies, not custom symbols.'

/**
 * The group currency from the current app's pair: currencyCode, else a
 * `currency` that is a code or the symbol of exactly one currency. v2 has no
 * custom symbols (docs/v2/parity/groups.md, P-GROUP-23).
 */
function currencyOf(data: { currency: string | undefined; currencyCode: string | null | undefined }): CurrencyCode {
  if (data.currencyCode) {
    if (!isCurrencyCode(data.currencyCode)) throw new Invalid({ message: NO_CUSTOM_CURRENCY })
    return data.currencyCode
  }
  const text = data.currency?.trim() ?? ''
  const upper = text.toUpperCase()
  if (isCurrencyCode(upper)) return upper
  const bySymbol = CURRENCY_CODES.filter((code) => CURRENCIES[code].symbol === text)
  const [only] = bySymbol
  if (bySymbol.length !== 1 || !only) throw new Invalid({ message: NO_CUSTOM_CURRENCY })
  return only
}

// Names are trimmed, as the current app's z.string().trim() did; the contract checks the trimmed text.
const Name = trimmed(PersonName, PERSON_NAME_LENGTH)
const GroupInputFields = {
  name: trimmed(GroupName, GROUP_NAME_LENGTH),
  slug: SlugInput.annotate({ description: 'Optional unique group URL slug, e.g. macademia. Set null or empty string to remove it.' }),
  information: Information,
  currency: Schema.String.check(Schema.isBetweenLength(1, 5)),
  currencyCode: Schema.Union([Schema.NullOr(Schema.String.check(Schema.isBetweenLength(3, 3))), Schema.Literal('')]),
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
      slug: optional(GroupInputFields.slug),
      information: optional(GroupInputFields.information),
      currency: GroupInputFields.currency,
      currencyCode: optional(GroupInputFields.currencyCode),
      participants: Schema.Array(Schema.Struct({ name: Name })).check(Schema.isMaxLength(LIMITS.participantsPerGroup - 1)),
    }),
    groupId: optional(NewId),
  }),
  strict: [''],
  output: GroupWritten,
  run: async ({ db, principal }, input) => {
    const g = input.group
    const group: typeof GroupCreateInput.Type = {
      name: g.name,
      slug: g.slug ?? null,
      information: g.information ?? '',
      defaultCurrency: currencyOf({ currency: g.currency, currencyCode: g.currencyCode }),
      participants: g.participants.map((p) => p.name),
    }
    // Each call is new, so it sends no idempotency key. A reused groupId is an
    // Invalid state error, which errorBody answers as CONFLICT (P-TOOL-CREATEGROUP-04).
    const created = await groups.createGroup(db, { principal, groupId: input.groupId ?? null, idempotencyKey: null, group })
    return written(db, { principal, groupId: created.id })
  },
})

export const updateGroup = defineTool({
  name: 'update_group',
  kind: 'write',
  description:
    'Admins only: edit group settings (including optional unique slug) or participants using a partial changes object and the current expectedRevision from get_group. Omitted fields stay unchanged. Existing participant IDs preserve identities; entries without IDs create participants. Historical participants cannot be erased. currencyCode must be a supported code.',
  input: Schema.Struct({
    groupId: IdInput,
    changes: Schema.Struct({
      name: optional(GroupInputFields.name),
      slug: optional(GroupInputFields.slug),
      information: optional(GroupInputFields.information),
      currency: optional(GroupInputFields.currency),
      currencyCode: optional(GroupInputFields.currencyCode),
      participants: optional(
        Schema.Array(Schema.Struct({ id: optional(IdInput), name: Name })).check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup)),
      ),
    }),
    expectedRevision: NonNegativeInt,
  }),
  strict: ['', 'changes'],
  output: GroupWritten,
  run: async ({ db, principal }, input) => {
    const c = input.changes
    const changes: typeof GroupChanges.Type = {
      ...(c.name === undefined ? {} : { name: c.name }),
      ...(c.slug === undefined ? {} : { slug: c.slug }),
      ...(c.information === undefined ? {} : { information: c.information }),
      ...(c.currency === undefined && c.currencyCode === undefined ? {} : { defaultCurrency: currencyOf({ currency: c.currency, currencyCode: c.currencyCode }) }),
      ...(c.participants === undefined ? {} : { participants: c.participants.map((p) => ({ ...(p.id === undefined ? {} : { id: p.id }), name: p.name })) }),
    }
    const updated = await groups.updateGroup(db, { principal, groupId: input.groupId, expectedRevision: input.expectedRevision, idempotencyKey: null, changes })
    return written(db, { principal, groupId: updated.id })
  },
})

// ---------- access ----------

type Request = typeof AccessRequest.Type
type Field = Request extends infer R ? (R extends unknown ? Exclude<keyof R, 'action'> : never) : never
/** renew_invitation is MCP's own action: it reissues a private expense's invitation (ungrouped.ts). */
type Action = Request['action'] | 'renew_invitation'

const fieldsOf = (fields: object) => Object.keys(fields).filter((key): key is Field => key !== 'action')

/** The fields each action needs: those of its AccessRequest member, as the current app's groupAccessInput required them. */
const REQUIRED: Readonly<Record<Action, readonly Field[]>> = {
  ...(Object.fromEntries(AccessRequest.members.map((member) => [member.fields.action.literal, fieldsOf(member.fields)])) as Record<Request['action'], Field[]>),
  renew_invitation: ['groupId', 'participantId'],
}
const ACTIONS = Object.keys(REQUIRED) as [Action, ...Action[]]
const decodeAccessRequest = Schema.decodeUnknownResult(AccessRequest)

const AccessInput = Schema.Struct({
  action: Schema.Literals(ACTIONS),
  groupId: optional(IdInput),
  shareUrl: optional(ShareUrl.annotate({ format: 'uri', description: 'For join: the email-bound invitation URL, not a group URL.' })),
  email: optional(Email.annotate({ format: 'email' })),
  invitationId: optional(IdInput),
  userId: optional(IdInput),
  participantId: optional(
    IdInput.annotate({ description: 'The existing participant to invite or bind. A membership identity cannot later be switched.' }),
  ),
  role: optional(Schema.Literals(ROLES)),
} satisfies Record<Field | 'action', Schema.Top>).check(
  Schema.makeFilter((input) => {
    const missing = REQUIRED[input.action].filter((field) => !input[field])
    return missing.length === 0 || missing.map((field) => `${field} is required`).join('; ')
  }),
)

export const manageGroupAccess = defineTool({
  name: 'manage_group_access',
  kind: 'write',
  description: `Manage membership: join with an email-bound invitation shareUrl; leave with groupId. Admin actions: invite with groupId, email and participantId (an existing unclaimed participant) (returns a single-use URL valid for ${LIMITS.invitationDays} days; share it with the intended person), revoke_invitation with invitationId, remove_member with userId, set_role with userId and role=${ROLES.join('|')}. Read members, their fixed participantId, and pending invitations with get_group. For an unbound legacy member only, an admin can bind_member with userId, verified email and participantId. For a private ungrouped expense, renew_invitation with groupId and participantId atomically replaces its invitation, including an expired one; only its original email can be invited. For a new named-group participant, first call update_group preserving all existing participants, then invite the returned participantId. This returns a link and sends no email. joined is true only after a join. Identity bindings cannot be changed; removal retains the identity and history. The last admin cannot leave or be demoted. A group URL grants no access. Changes apply immediately to all user keys; ledger history is preserved. Invitations are not idempotent: do not blindly retry an uncertain invite; inspect get_group first.`,
  input: AccessInput,
  strict: [''],
  output: Schema.Struct({
    groupId: Id,
    joined: Schema.Boolean,
    invitation: optional(Schema.Struct({ id: Id, email: Schema.String, expiresAt: DateTime, url: Schema.String, participantId: Id, participantName: Schema.String })),
  }),
  run: async ({ db, principal, baseUrl }, input) => {
    const field = (name: Field) => input[name] ?? ''
    if (input.action === 'renew_invitation') {
      const invitation = await renewPrivateInvitation(db, { principal, baseUrl, groupId: field('groupId'), participantId: field('participantId') })
      const { groupId, ...rest } = invitation
      return { groupId, joined: false, invitation: rest }
    }
    // Each field was decoded with the contract's schema; this checks the action's member as a whole.
    const decoded = decodeAccessRequest({ action: input.action, ...Object.fromEntries(REQUIRED[input.action].map((name) => [name, field(name)])) })
    if (Result.isFailure(decoded)) throw new Invalid({ message: decoded.failure.message })
    const request = decoded.success
    const result = await groups.changeAccess(db, { principal, baseUrl, idempotencyKey: null, request })
    const i = result.invitation
    return {
      groupId: result.groupId,
      // The current app answered true for every action but leave; v2 answers true only after a join (DECISIONS.md group C, P-TOOL-ACCESS-28).
      joined: input.action === 'join',
      ...(i && i.url && i.participantId ? { invitation: { id: i.id, email: i.email, expiresAt: i.expiresAt, url: i.url, participantId: i.participantId, participantName: i.participantName ?? '' } } : {}),
    }
  },
})
