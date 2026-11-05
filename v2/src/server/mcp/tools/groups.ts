// Group tools: list_groups and get_group, with the current app's inputs and
// output shapes (src/trpc/routers/groups/list.procedure.ts, getDetails.procedure.ts).
// Each read is one statement whose membership check is part of the query.
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { CURRENCIES, type CurrencyCode } from '../../../shared/currencies'
import { Forbidden } from '../../../shared/api'
import { defineTool } from '../registry'
import { DateTime, Id, isoSql, NonNegativeInt, NullableString, origin, participantNameSql } from './shared'

const MAX_GROUPS = 100

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

const groupColumns = sql`g.id, g.name, g.slug, g.information, g.revision, g.default_currency, ${isoSql(sql`g.created_at`)} AS created_at`

export const listGroups = defineTool({
  name: 'list_groups',
  kind: 'read',
  description:
    'List named groups available to your user; ungrouped private contexts are excluded. Use list_all_expenses to discover both grouped and ungrouped expenses. Keys inherit the same memberships. Page with nextCursor while hasMore is true; optionally supply a subset of groupIds.',
  input: Schema.Struct({
    groupIds: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).check(Schema.isMaxLength(MAX_GROUPS))),
    cursor: Schema.optionalKey(NonNegativeInt.annotate({ default: 0 })),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_GROUPS })).annotate({ default: MAX_GROUPS })),
  }),
  strict: [''],
  output: Schema.Struct({
    groups: Schema.Array(Schema.Struct({ ...GroupFields, _count: Schema.Struct({ participants: NonNegativeInt }) })),
    hasMore: Schema.Boolean,
    nextCursor: NonNegativeInt,
  }),
  run: async ({ db, principal }, { groupIds, cursor = 0, limit = MAX_GROUPS }) => {
    const requested = groupIds ? [...new Set(groupIds)] : null
    // A requested ID outside the caller's memberships fails the whole call, as in the current app.
    if (requested?.length) {
      const ids = sql.join(requested.map((id) => sql`${id}`), sql`, `)
      const denied = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM unnest(ARRAY[${ids}]::text[]) AS r(id)
        WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${principal.userId} AND m.group_id = r.id AND m.active)`)
      if (denied.rows[0]?.n !== 0) throw new Forbidden({ message: 'Group access denied' })
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
  role: 'admin' | 'member'
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
        coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', ${participantNameSql(sql`p.id`)}, 'groupId', p.group_id) ORDER BY p.created_at, p.id)
          FROM participants p WHERE p.group_id = g.id), '[]') AS participants,
        coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', mb.role, 'participantId', mb.participant_id) ORDER BY mb.created_at, u.id)
          FROM memberships mb JOIN "user" u ON u.id = mb.user_id WHERE mb.group_id = g.id AND mb.active), '[]') AS members,
        CASE WHEN m.role = 'admin' THEN coalesce((
          SELECT json_agg(json_build_object('id', i.id, 'email', i.email, 'expiresAt', ${isoSql(sql`i.expires_at`)}, 'participantId', i.participant_id, 'participantName', i.participant_name) ORDER BY i.created_at, i.id)
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
    if (!g) throw new Forbidden({ message: 'Group access denied' })
    const path = `${origin(baseUrl)}${g.slug ? `/${g.slug}` : `/groups/${g.id}`}`
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
      links: { share: path, csv: `${path}/expenses/export/csv`, json: `${path}/expenses/export/json` },
    }
  },
})

export const groupTools = [listGroups, getGroup]
