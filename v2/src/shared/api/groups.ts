// Groups and access: the directory, group settings and people, and
// email-bound invitations. Ported from the current app's src/lib/api.ts
// (createGroup, updateGroup) and src/lib/group-access.ts.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { CurrencyCodeSchema, DecimalOutput } from '../money'
import { Id, IdempotencyKey, ReadError, WriteError } from './core'

// ---------- rules shared by the form and the server ----------

/** Root routes and infrastructure names a group cannot claim (P-GROUP-94). */
export const RESERVED_GROUP_SLUGS: ReadonlySet<string> = new Set([
  'sign-in',
  'api',
  'groups',
  'expenses',
  'agents',
  'login',
  'logout',
  'signup',
  'auth',
  'invite',
  'join',
  'settings',
  'account',
  'admin',
  'health',
  'about',
  'privacy',
  'terms',
  'robots',
  'sitemap',
  'favicon',
  'manifest',
  'opengraph-image',
  'twitter-image',
])

/** A slug is trimmed and lowercased before it is checked and stored (P-GROUP-92). */
export const normalizeSlug = (slug: string) => slug.trim().toLowerCase()

/** The problem with a normalized, non-empty slug, or null if it is valid. */
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug))
    return 'Use 3–63 lowercase letters, numbers or hyphens; start and end with a letter or number.'
  if (RESERVED_GROUP_SLUGS.has(slug)) return 'This URL is reserved.'
  return null
}

/** The group's canonical URL segment: its slug, else its ID. */
export const groupRef = (group: { id: string; slug: string | null }) => group.slug ?? group.id

export const INVITATION_DAYS = 7
/** An invitation token: 32 random bytes in base64url (P-ACCESS-14). */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/

const GroupName = Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(2, 50))
const Information = Schema.String.check(Schema.isMaxLength(10_000))
const PersonName = Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(1, 50))
/** A slug as typed; the server normalizes and checks it. Empty or null removes it. */
const SlugInput = Schema.NullOr(Schema.String.check(Schema.isMaxLength(80)))
const Email = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
const Role = Schema.Literals(['admin', 'member'])
const Timestamp = Schema.String // ISO 8601, UTC

// ---------- shapes ----------

export const DirectoryGroup = Schema.Struct({
  id: Schema.String,
  slug: Schema.NullOr(Schema.String),
  name: Schema.String,
  participantCount: Schema.Number,
  createdAt: Timestamp,
})

export const Directory = Schema.Struct({
  groups: Schema.Array(DirectoryGroup),
  /** Pass back as `offset` for the next page; null at the end. */
  nextOffset: Schema.NullOr(Schema.Number),
  /** The caller's net balance per currency across every group where they have a participant. */
  totals: Schema.Array(Schema.Struct({ currency: CurrencyCodeSchema, net: DecimalOutput })),
  /** Groups the caller belongs to without a linked participant; their balances are not in `totals`. */
  unboundGroupCount: Schema.Number,
})

export const Person = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** joined: an active member is bound to this person; invited: a pending invitation names them (admins only). */
  status: Schema.Literals(['joined', 'invited', 'none']),
  /** The member's or the invitee's email. */
  email: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Role),
  userId: Schema.NullOr(Schema.String),
  /** Pays or shares in any expense, deleted ones included: the person cannot be removed. */
  inExpenses: Schema.Boolean,
  /** Bound to an account, now or before, or named by an invitation: cannot be renamed or removed. */
  reserved: Schema.Boolean,
})

export const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  participantId: Schema.NullOr(Schema.String),
  participantName: Schema.NullOr(Schema.String),
  expiresAt: Timestamp,
})

export const GroupDetails = Schema.Struct({
  kind: Schema.Literals(['named', 'private']),
  id: Schema.String,
  slug: Schema.NullOr(Schema.String),
  name: Schema.String,
  information: Schema.String,
  defaultCurrency: CurrencyCodeSchema,
  revision: Schema.Number,
  role: Role,
  participantId: Schema.NullOr(Schema.String),
  people: Schema.Array(Person),
  /** Active members with no participant yet (legacy memberships). */
  unboundMembers: Schema.Array(Schema.Struct({ userId: Schema.String, name: Schema.String, email: Schema.String, role: Role })),
  /** Pending invitations, for admins only; members get an empty list. */
  invitations: Schema.Array(Invitation),
})

export const GroupCreateInput = Schema.Struct({
  name: GroupName,
  slug: SlugInput,
  information: Information,
  defaultCurrency: CurrencyCodeSchema,
  /** Other participants; the creator is added automatically. */
  participants: Schema.Array(PersonName).check(Schema.isMaxLength(99)),
})

export const GroupChanges = Schema.Struct({
  name: Schema.optionalKey(GroupName),
  slug: Schema.optionalKey(SlugInput),
  information: Schema.optionalKey(Information),
  defaultCurrency: Schema.optionalKey(CurrencyCodeSchema),
  /**
   * The full list of people: entries with an ID keep that person (and may rename
   * them), entries without one add a person, and people left out are removed.
   */
  participants: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.optionalKey(Id), name: PersonName })).check(Schema.isBetweenLength(1, 100)),
  ),
})

export const GroupWritten = Schema.Struct({ id: Schema.String, slug: Schema.NullOr(Schema.String), revision: Schema.Number })

export const AccessRequest = Schema.Union([
  /** Joins with an email-bound invitation URL from this app. */
  Schema.Struct({ action: Schema.Literal('join'), shareUrl: Schema.String.check(Schema.isMaxLength(2000)) }),
  Schema.Struct({ action: Schema.Literal('leave'), groupId: Id }),
  Schema.Struct({ action: Schema.Literal('invite'), groupId: Id, email: Email, participantId: Id }),
  Schema.Struct({ action: Schema.Literal('revoke_invitation'), groupId: Id, invitationId: Id }),
  Schema.Struct({ action: Schema.Literal('remove_member'), groupId: Id, userId: Id }),
  Schema.Struct({ action: Schema.Literal('set_role'), groupId: Id, userId: Id, role: Role }),
  /** Links an active member without a participant to an unclaimed participant, permanently. */
  Schema.Struct({ action: Schema.Literal('bind_member'), groupId: Id, userId: Id, email: Email, participantId: Id }),
])

export const AccessResult = Schema.Struct({
  groupId: Schema.String,
  /** False only after leaving. */
  joined: Schema.Boolean,
  /** The created invitation. `url` holds the secret and is returned once; a retried request gets null. */
  invitation: Schema.NullOr(Schema.Struct({ ...Invitation.fields, url: Schema.NullOr(Schema.String) })),
})

/** What the invite page shows. An unavailable invitation reveals nothing about its group. */
export const InvitationPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('valid'),
    kind: Schema.Literals(['named', 'private']),
    groupName: Schema.String,
    participantName: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal('unavailable') }),
])

// ---------- procedures ----------

export class GroupsApi extends RpcGroup.make(
  Rpc.make('groups.directory', { payload: { offset: Schema.Number }, success: Directory, error: ReadError }),
  Rpc.make('groups.details', { payload: { groupId: Id }, success: GroupDetails, error: ReadError }),
  Rpc.make('groups.create', {
    payload: {
      /** Optional caller-chosen ID, 21 URL-safe characters. */
      groupId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}$/))),
      idempotencyKey: IdempotencyKey,
      group: GroupCreateInput,
    },
    success: GroupWritten,
    error: WriteError,
  }),
  Rpc.make('groups.update', {
    payload: { groupId: Id, expectedRevision: Schema.Number, idempotencyKey: IdempotencyKey, changes: GroupChanges },
    success: GroupWritten,
    error: WriteError,
  }),
  Rpc.make('groups.access', { payload: { idempotencyKey: IdempotencyKey, request: AccessRequest }, success: AccessResult, error: WriteError }),
  Rpc.make('invitations.preview', {
    payload: { token: Schema.String.check(Schema.isPattern(INVITATION_TOKEN)) },
    success: InvitationPreview,
    error: ReadError,
  }),
) {}
