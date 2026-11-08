// AgentSplit ledger tables. Money columns are integer minor units (bigint).
// Invariants that span rows (sums, append-only history) live in SQL triggers,
// which only the migrations hold (0001_invariants.sql and later; Drizzle cannot
// declare them). The value lists and limits come from src/shared, and
// test/db/database-rules.test.ts compares the CHECKs with them and tests the triggers.
import { sql, type SQL } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
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
import { CURRENCY_CODES, type CurrencyCode } from '../../src/shared/currencies'
import { LIMITS } from '../../src/shared/limits'
import { DECIMAL } from '../../src/shared/minor'
import { WEIGHT } from '../../src/shared/split'
import {
  ACTIVITY_TYPES,
  EXPENSE_KINDS,
  GROUP_KINDS,
  RECEIPT_CONTENT_TYPES,
  RECURRENCES,
  ROLES,
  SPLIT_MODES,
  STORED_ACTIVITY_SOURCES,
  UPLOAD_STATES,
} from '../../src/shared/vocabulary'
import { oauthClient, user } from './auth'

/** `column IN ('a', 'b')`, written as drizzle-kit keeps it in the migration snapshots. */
const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL => sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`

const now = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow()
const money = () => bigint({ mode: 'bigint' }).notNull()

export const groups = pgTable(
  'groups',
  {
    id: text().primaryKey(),
    kind: text({ enum: GROUP_KINDS }).notNull(),
    // Nullable: a slug is an optional URL alias.
    slug: text().unique(),
    name: text().notNull(),
    information: text().notNull().default(''),
    defaultCurrency: text().$type<CurrencyCode>().notNull(),
    revision: integer().notNull().default(0),
    createdAt: now(),
  },
  (t) => [
    check('groups_revision_nonnegative', sql`${t.revision} >= 0`),
    check('groups_kind', oneOf(t.kind, GROUP_KINDS)),
    check('groups_currency_supported', oneOf(t.defaultCurrency, CURRENCY_CODES)),
  ],
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
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    role: text({ enum: ROLES }).notNull().default('member'),
    active: boolean().notNull().default(true),
    // Nullable: a member may not be bound to a participant yet.
    participantId: text(),
    createdAt: now(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.groupId] }),
    unique('memberships_group_participant').on(t.groupId, t.participantId),
    check('memberships_role', oneOf(t.role, ROLES)),
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
    kind: text({ enum: EXPENSE_KINDS }).notNull(),
    title: text().notNull(),
    // Nullable: vendor is optional.
    vendor: text(),
    notes: text().notNull().default(''),
    categoryId: integer()
      .notNull()
      .default(0)
      .references(() => categories.id),
    expenseDate: date({ mode: 'string' }).notNull(),
    currency: text().$type<CurrencyCode>().notNull(),
    amount: money(),
    splitMode: text({ enum: SPLIT_MODES }).notNull(),
    // Nullable as a set: present only for an amount converted from another currency.
    originalAmount: bigint({ mode: 'bigint' }),
    originalCurrency: text().$type<CurrencyCode>(),
    conversionRate: text(),
    recurrence: text({ enum: RECURRENCES }).notNull().default('none'),
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
    check('expenses_split_mode', oneOf(t.splitMode, SPLIT_MODES)),
    check('expenses_recurrence', oneOf(t.recurrence, RECURRENCES)),
    check('expenses_kind', oneOf(t.kind, EXPENSE_KINDS)),
    check('expenses_currency_supported', oneOf(t.currency, CURRENCY_CODES)),
    check('expenses_original_currency_supported', sql`${t.originalCurrency} IS NULL OR ${oneOf(t.originalCurrency, CURRENCY_CODES)}`),
    unique('expenses_id_group').on(t.id, t.groupId),
    index('expenses_group_date').on(t.groupId, t.deletedAt, t.expenseDate.desc(), t.createdAt.desc(), t.id.desc()),
    index('expenses_group_updated').on(t.groupId, t.deletedAt, t.updatedAt.desc(), t.id.desc()),
    index('expenses_feed').on(t.expenseDate.desc(), t.createdAt.desc(), t.id.desc()),
    // Balances and expense lists for one currency (P-DB-49).
    index('expenses_group_currency').on(t.groupId, t.currency, t.deletedAt),
  ],
)

const allocation = (name: 'expense_payers' | 'expense_shares', weightRule: RegExp) =>
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
      check(`${name}_weight_decimal`, sql`${t.weight} ~ ${sql.raw(`'${weightRule.source}'`)}`),
    ],
  )

export const expensePayers = allocation('expense_payers', WEIGHT)
// A share's weight takes the sign of a negative amount split by amount, such as a refund (DECISIONS.md, P-BAL-93, P-MONEY-52).
export const expenseShares = allocation('expense_shares', DECIMAL)

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
    type: text({ enum: ACTIVITY_TYPES }).notNull(),
    // Nullable: only some activity types refer to a participant or an expense.
    participantId: text(),
    expenseId: text(),
    expenseRevision: integer(),
    // Nullable: set by group changes that bump groups.revision (create_group, update_group).
    groupRevision: integer(),
    data: text(),
    snapshot: jsonb(),
    source: text({ enum: STORED_ACTIVITY_SOURCES }).notNull().default('web'),
    actorName: text(),
    actorUserId: text(),
    agentKeyId: text(),
  },
  (t) => [
    unique('activities_expense_revision').on(t.expenseId, t.expenseRevision),
    unique('activities_group_revision').on(t.groupId, t.groupRevision),
    check('activities_snapshot_revision', sql`${t.expenseRevision} IS NULL OR (${t.expenseId} IS NOT NULL AND ${t.expenseRevision} >= 0)`),
    check('activities_type', oneOf(t.type, ACTIVITY_TYPES)),
    check('activities_source', oneOf(t.source, STORED_ACTIVITY_SOURCES)),
    // An activity refers only to an expense and a participant of its own group.
    foreignKey({ name: 'activities_expense_fk', columns: [t.expenseId, t.groupId], foreignColumns: [expenses.id, expenses.groupId] }).onDelete(
      'restrict',
    ),
    foreignKey({
      name: 'activities_participant_fk',
      columns: [t.participantId, t.groupId],
      foreignColumns: [participants.id, participants.groupId],
    }).onDelete('restrict'),
    index().on(t.groupId, t.time.desc(), t.id.desc()),
    index().on(t.groupId, t.sequence.desc()),
    // The participant foreign key's RESTRICT check reads this when a participant is deleted.
    index()
      .on(t.participantId, t.groupId)
      .where(sql`${t.participantId} IS NOT NULL`),
  ],
)

export const receipts = pgTable(
  'receipts',
  {
    id: text().primaryKey(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    /** The public receipt URL; its object key in the bucket is derived from it. */
    url: text().notNull(),
    // Nullable: receipts imported from before accounts have no known uploader, and count against no one.
    createdBy: text(),
    createdAt: now(),
    /**
     * The stored object's size, which counts against the uploader's storage.
     * Receipts stored before this column keep 0 and count against no quota.
     */
    bytes: integer().notNull().default(0),
  },
  (t) => [
    unique('receipts_group_url').on(t.groupId, t.url),
    check('receipts_bytes_nonnegative', sql`${t.bytes} >= 0`),
    // Storage usage per uploader.
    index().on(t.createdBy),
  ],
)

/**
 * Receipts deleted for good. The receipt row and every history snapshot that
 * names it stay, so history remains append-only; readers show a tombstone for
 * these receipts instead of the image, and the object leaves storage.
 */
export const deletedReceipts = pgTable('deleted_receipts', {
  receiptId: text()
    .primaryKey()
    .references(() => receipts.id, { onDelete: 'restrict' }),
  deletedBy: text()
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  deletedAt: now(),
  // Nullable: set once the object is removed from storage. The hourly job retries until then.
  purgedAt: timestamp({ withTimezone: true, mode: 'date' }),
})

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
    /** The receipt's place in the expense's list, from 0, in the order the receipts were attached. */
    position: integer().notNull(),
  },
  // The unique key also serves lookups by expense.
  (t) => [unique('expense_documents_expense_position').on(t.expenseId, t.position)],
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
    // The link's group is the group of its current expense.
    foreignKey({
      name: 'recurring_links_expense_group_fk',
      columns: [t.currentFrameExpenseId, t.groupId],
      foreignColumns: [expenses.id, expenses.groupId],
    }).onDelete('restrict'),
  ],
)

/** A private context holds exactly one ungrouped expense with a fixed set of people. */
export const privateContexts = pgTable('private_contexts', {
  groupId: text()
    .primaryKey()
    .references(() => groups.id, { onDelete: 'restrict' }),
  // DEFERRABLE INITIALLY DEFERRED (0015), which Drizzle cannot declare: the context is written before its expense.
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
    // A connection ends with its user or its client, as Better Auth's own token rows do.
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
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

/**
 * Upload targets that an agent asked for with create_expense or update_expense
 * (v1's pending-receipts objects). The agent PUTs the bytes once
 * to /api/receipt-uploads/<token>, and update_expense attaches them. A row is
 * deleted when its receipt is attached, or by the hourly cleanup.
 */
export const receiptUploads = pgTable(
  'receipt_uploads',
  {
    /** The uploadId that attachUploadIds names. */
    id: text().primaryKey(),
    /** Hex SHA-256 of the secret in the upload URL; the secret itself is never stored. */
    tokenHash: text().notNull().unique(),
    userId: text().notNull(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    expenseId: text()
      .notNull()
      .references(() => expenses.id, { onDelete: 'restrict' }),
    /** The final object key, receipts/<id>.jpg|png. Only the one PUT writes it. */
    key: text().notNull().unique(),
    contentType: text({ enum: RECEIPT_CONTENT_TYPES }).notNull(),
    bytes: integer().notNull(),
    /** The PUT must start before this time. */
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    state: text({ enum: UPLOAD_STATES }).notNull().default('pending'),
    // Nullable: set when the PUT is complete.
    uploadedAt: timestamp({ withTimezone: true, mode: 'date' }),
    createdAt: now(),
  },
  (t) => [
    index().on(t.createdAt),
    check('receipt_uploads_content_type', oneOf(t.contentType, RECEIPT_CONTENT_TYPES)),
    check('receipt_uploads_bytes', sql`${t.bytes} BETWEEN 1 AND ${sql.raw(String(LIMITS.receiptBytes))}`),
    check('receipt_uploads_state', sql`${oneOf(t.state, UPLOAD_STATES)} AND (${t.state} = 'stored') = (${t.uploadedAt} IS NOT NULL)`),
  ],
)

/**
 * Per-user token buckets (rate-limit.ts): the MCP request budget (0007) and
 * the write budget (0012). Tokens are fractional, because a bucket refills
 * continuously. `allowed` records whether the latest request took a token:
 * RETURNING sees only the new row.
 */
const tokenBucket = (name: 'mcp_rate_limits' | 'write_rate_limits') =>
  pgTable(name, {
    userId: text().primaryKey(),
    tokens: doublePrecision().notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    allowed: boolean().notNull(),
  })

export const mcpRateLimits = tokenBucket('mcp_rate_limits')
export const writeRateLimits = tokenBucket('write_rate_limits')
