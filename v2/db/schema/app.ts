// AgentSplit ledger tables. Money columns are integer minor units (bigint).
// Invariants that span rows (sums, append-only history) live in SQL triggers:
// see db/migrations/*_invariants.sql.
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

const now = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow()
const money = () => bigint({ mode: 'bigint' }).notNull()

export const groups = pgTable(
  'groups',
  {
    id: text().primaryKey(),
    /** 'named' groups appear in the directory; 'private' contexts hold one ungrouped expense. */
    kind: text({ enum: ['named', 'private'] }).notNull(),
    // Nullable: a slug is an optional URL alias.
    slug: text().unique(),
    name: text().notNull(),
    information: text().notNull().default(''),
    defaultCurrency: text().notNull(),
    revision: integer().notNull().default(0),
    createdAt: now(),
  },
  (t) => [check('groups_revision_nonnegative', sql`${t.revision} >= 0`)],
)

/** Slugs a group used before: an old link redirects to the group's current URL. */
export const groupSlugHistory = pgTable(
  'group_slug_history',
  {
    slug: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    retiredAt: now(),
  },
  (t) => [index().on(t.groupId)],
)

export const participants = pgTable(
  'participants',
  {
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    createdAt: now(),
  },
  (t) => [unique('participants_id_group').on(t.id, t.groupId), index().on(t.groupId)],
)

export const memberships = pgTable(
  'memberships',
  {
    userId: text().notNull(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    role: text({ enum: ['admin', 'member'] }).notNull().default('member'),
    active: boolean().notNull().default(true),
    // Nullable: a member may not be bound to a participant yet.
    participantId: text(),
    createdAt: now(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.groupId] }),
    unique('memberships_group_participant').on(t.groupId, t.participantId),
    foreignKey({ columns: [t.participantId, t.groupId], foreignColumns: [participants.id, participants.groupId] }).onDelete(
      'restrict',
    ),
    index().on(t.groupId),
  ],
)

export const invitations = pgTable(
  'invitations',
  {
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    email: text().notNull(),
    // Nullable: legacy invitations may name a participant that is not created yet.
    participantId: text(),
    participantName: text(),
    tokenHash: text().notNull().unique(),
    createdBy: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    createdAt: now(),
    acceptedAt: timestamp({ withTimezone: true, mode: 'date' }),
    revokedAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [
    foreignKey({ columns: [t.participantId, t.groupId], foreignColumns: [participants.id, participants.groupId] }).onDelete(
      'restrict',
    ),
    index().on(t.groupId),
  ],
)

export const categories = pgTable('categories', {
  id: integer().primaryKey(),
  grouping: text().notNull(),
  name: text().notNull(),
})

export const expenses = pgTable(
  'expenses',
  {
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    revision: integer().notNull().default(0),
    /** 'payment' records a repayment between people (the old isReimbursement). */
    kind: text({ enum: ['expense', 'payment'] }).notNull(),
    title: text().notNull(),
    // Nullable: vendor is optional.
    vendor: text(),
    notes: text().notNull().default(''),
    categoryId: integer()
      .notNull()
      .default(0)
      .references(() => categories.id),
    expenseDate: date({ mode: 'string' }).notNull(),
    currency: text().notNull(),
    amount: money(),
    splitMode: text({ enum: ['evenly', 'shares', 'percentage', 'amount'] }).notNull(),
    // Nullable as a set: present only for an amount converted from another currency.
    originalAmount: bigint({ mode: 'bigint' }),
    originalCurrency: text(),
    conversionRate: text(),
    recurrence: text({ enum: ['none', 'daily', 'weekly', 'monthly'] }).notNull().default('none'),
    createdAt: now(),
    /** The time of the latest revision: drives "recently edited or added" ordering. */
    updatedAt: now(),
    // Nullable: set when the expense is deleted (a tombstone; rows are never removed).
    deletedAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('expenses_revision_nonnegative', sql`${t.revision} >= 0`),
    check(
      'expenses_conversion_complete',
      sql`(${t.originalAmount} IS NULL) = (${t.originalCurrency} IS NULL) AND (${t.originalCurrency} IS NULL) = (${t.conversionRate} IS NULL)`,
    ),
    unique('expenses_id_group').on(t.id, t.groupId),
    index('expenses_group_date').on(t.groupId, t.deletedAt, t.expenseDate.desc(), t.createdAt.desc(), t.id.desc()),
    index('expenses_group_updated').on(t.groupId, t.deletedAt, t.updatedAt.desc(), t.id.desc()),
    index('expenses_feed').on(t.expenseDate.desc(), t.createdAt.desc(), t.id.desc()),
  ],
)

const allocation = (name: 'expense_payers' | 'expense_shares') =>
  pgTable(
    name,
    {
      expenseId: text().notNull(),
      groupId: text().notNull(),
      participantId: text().notNull(),
      /** The resolved part in minor units. */
      amount: money(),
      /** The split input as exact decimal text (share count, percentage or amount); '1' for payers. */
      weight: text().notNull().default('1'),
    },
    (t) => [
      primaryKey({ columns: [t.expenseId, t.participantId] }),
      foreignKey({ columns: [t.expenseId, t.groupId], foreignColumns: [expenses.id, expenses.groupId] }).onDelete('restrict'),
      foreignKey({ columns: [t.participantId, t.groupId], foreignColumns: [participants.id, participants.groupId] }).onDelete(
        'restrict',
      ),
      index().on(t.participantId),
    ],
  )

export const expensePayers = allocation('expense_payers')
export const expenseShares = allocation('expense_shares')

/** Append-only history: every group change and every expense revision with its full snapshot. */
export const activities = pgTable(
  'activities',
  {
    sequence: bigserial({ mode: 'bigint' }).notNull().unique(),
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    time: timestamp({ withTimezone: true, mode: 'date' }).notNull().default(sql`clock_timestamp()`),
    type: text({
      enum: ['create_group', 'join_group', 'leave_group', 'update_group', 'create_expense', 'update_expense', 'delete_expense'],
    }).notNull(),
    // Nullable: only some activity types refer to a participant or an expense.
    participantId: text(),
    expenseId: text(),
    expenseRevision: integer(),
    // Nullable: set by group changes that bump groups.revision (create_group, update_group).
    groupRevision: integer(),
    data: text(),
    snapshot: jsonb(),
    source: text().notNull().default('web'),
    actorName: text(),
    actorUserId: text(),
    agentKeyId: text(),
  },
  (t) => [
    unique('activities_expense_revision').on(t.expenseId, t.expenseRevision),
    unique('activities_group_revision').on(t.groupId, t.groupRevision),
    check('activities_snapshot_revision', sql`${t.expenseRevision} IS NULL OR (${t.expenseId} IS NOT NULL AND ${t.expenseRevision} >= 0)`),
    index().on(t.groupId, t.time.desc(), t.id.desc()),
    index().on(t.groupId, t.sequence.desc()),
  ],
)

export const receipts = pgTable(
  'receipts',
  {
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    /** The public receipt URL; its object key in R2 is derived from it. */
    url: text().notNull(),
    createdBy: text(),
    createdAt: now(),
  },
  (t) => [unique('receipts_group_url').on(t.groupId, t.url)],
)

export const expenseDocuments = pgTable(
  'expense_documents',
  {
    id: text().primaryKey(),
    expenseId: text()
      .notNull()
      .references(() => expenses.id, { onDelete: 'restrict' }),
    url: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
  },
  (t) => [index().on(t.expenseId)],
)

export const recurringLinks = pgTable(
  'recurring_links',
  {
    id: text().primaryKey(),
    groupId: text().notNull(),
    currentFrameExpenseId: text()
      .notNull()
      .unique()
      .references(() => expenses.id, { onDelete: 'restrict' }),
    // Nullable: set once the next expense in the series has been created.
    nextExpenseCreatedAt: timestamp({ withTimezone: true, mode: 'date' }),
    nextExpenseDate: date({ mode: 'string' }).notNull(),
    /** The series' day of the month. Monthly dates keep it after a shorter month (Jan 31, Feb 28, Mar 31). */
    anchorDay: smallint().notNull(),
  },
  (t) => [
    index().on(t.groupId, t.nextExpenseCreatedAt, t.nextExpenseDate.desc()),
    check('recurring_links_anchor_day', sql`${t.anchorDay} BETWEEN 1 AND 31`),
  ],
)

/** A private context holds exactly one ungrouped expense with a fixed set of people. */
export const privateContexts = pgTable('private_contexts', {
  groupId: text()
    .primaryKey()
    .references(() => groups.id, { onDelete: 'restrict' }),
  expenseId: text()
    .notNull()
    .unique()
    .references(() => expenses.id, { onDelete: 'restrict' }),
})

export const privatePeople = pgTable(
  'private_people',
  {
    participantId: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => privateContexts.groupId, { onDelete: 'restrict' }),
    email: text().notNull(),
  },
  (t) => [
    unique('private_people_group_email').on(t.groupId, t.email),
    foreignKey({ columns: [t.participantId, t.groupId], foreignColumns: [participants.id, participants.groupId] }).onDelete(
      'restrict',
    ),
  ],
)

/** One row per (principal, key): a retried write returns the stored result instead of writing twice. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    principal: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    response: jsonb().notNull(),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.principal, t.key] })],
)

/** One agent connection per OAuth authorization; revoking it ends every token of that grant. */
export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: text().primaryKey(),
    /** base64url(sha256(authorization code)), stable across refresh-token rotation. */
    authorizationCodeId: text().notNull().unique(),
    userId: text().notNull(),
    clientId: text().notNull(),
    scopes: text().array().notNull(),
    createdAt: now(),
    // Nullable: set when the user revokes the connection.
    revokedAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [index().on(t.userId, t.clientId)],
)

/** Groups created before accounts existed, which the bootstrap owner may claim once. */
export const legacyGroupClaims = pgTable('legacy_group_claims', { groupId: text().primaryKey() })

export const authBootstrap = pgTable('auth_bootstrap', {
  id: text().primaryKey(),
  userId: text().notNull(),
  createdAt: now(),
})
