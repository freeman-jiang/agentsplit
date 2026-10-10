import type { AppRouter } from '@/trpc/routers/_app'
import type { AnyTRPCProcedure, TRPCRouterRecord } from '@trpc/server'

type ProcedurePaths<T extends TRPCRouterRecord> = {
  [K in keyof T & string]: T[K] extends AnyTRPCProcedure
    ? K
    : T[K] extends TRPCRouterRecord
      ? `${K}.${ProcedurePaths<T[K]>}`
      : never
}[keyof T & string]
export type ProcedurePath = ProcedurePaths<AppRouter['_def']['record']>
export type ToolDefinition = {
  name: string
  description: string
  procedure: ProcedurePath
  required?: readonly string[]
  inputAliases?: Record<string, string>
  destructive?: boolean
  idempotent?: boolean
}
/** A reviewed resource-oriented API. Business rules stay in the shared backend. */
export const MCP_TOOL_REGISTRY = [
  {
    name: 'list_all_expenses',
    procedure: 'expenses.list',
    description:
      'List accessible expenses and repayments across groups and private ungrouped expenses, ordered by expense date, creation time, then ID, newest first. Set involvingMe=true for expenses you paid for or share. Filter by scope (all/grouped/ungrouped), groupId, personId or paidByUserId (account IDs from get_expense_options), dates, currency, category, type, or title/vendor text. Pass nextCursor unchanged for the next page. group=null means no named group; groupId is the private accounting context ID for existing expense/history/balance/payment tools. A private context settles only its original contextExpenseId; never copy that balance into a named group. Reads do not generate recurrences.',
  },
  {
    name: 'get_expense_options',
    procedure: 'expenses.options',
    description:
      'List your named groups and verified people you already share active access with, plus your account userId. Account IDs are not group participant IDs. Verified accounts have one global display name; participant names for those accounts always resolve to it. Unclaimed participants retain their invitation placeholder name. Use these accounts with create_expense (omit groupId and supply people) to create private ungrouped expenses; someone else may be invited by exact email. Does not search or disclose arbitrary accounts.',
  },
  {
    name: 'update_profile',
    procedure: 'profile.update',
    destructive: false,
    idempotent: true,
    description:
      'Set your one global display name. Requires your verified account. The name appears across all current group and ungrouped expense views, including existing expenses, and in future audit entries. Historical audit names and snapshots remain unchanged. Only your own name can change; email, IDs, memberships, splits and money are unaffected. Discover your current name and account ID with get_expense_options.',
  },
  {
    name: 'list_groups',
    procedure: 'groups.list',
    description:
      'List named groups available to your user; ungrouped private contexts are excluded. Use list_all_expenses to discover both grouped and ungrouped expenses. Keys inherit the same memberships. Page with nextCursor while hasMore is true; optionally supply a subset of groupIds.',
  },
  {
    name: 'get_group',
    procedure: 'groups.getDetails',
    description:
      'Read group or private accounting-context details (context.kind and context.expenseId distinguish them), its revision, participant IDs, member roles, pending invitations (admins only), group/export links, and participant IDs referenced by expenses. access.participantId is your fixed identity (null means an admin must bind a legacy account). Each member is tied to one participant, but any member may record another participant as payer; authenticated authorship remains separate.',
  },
  {
    name: 'create_group',
    procedure: 'groups.create',
    inputAliases: { group: 'groupFormValues' },
    destructive: false,
    description:
      'Create a group. The authenticated creator is automatically added as a participant using their account name and becomes admin. Supply name, optional unique slug, currency/default currencyCode, and OTHER participant names in group.participants (empty array allowed); do not include the creator. All keys inherit the fixed membership. An optional caller-minted 21-character groupId prevents accidental duplicate creation; check it before retrying an uncertain result.',
  },
  {
    name: 'update_group',
    procedure: 'groups.update',
    inputAliases: { changes: 'groupFormValues' },
    required: ['expectedRevision'],
    description:
      'Admins only: edit group settings (including optional unique slug) or participants using a partial changes object and the current expectedRevision from get_group. Omitted fields stay unchanged. Existing participant IDs preserve identities; entries without IDs create participants. Historical participants cannot be erased.',
  },
  {
    name: 'manage_group_access',
    procedure: 'groups.access',
    destructive: true,
    idempotent: false,
    description:
      'Manage membership: join with an email-bound invitation shareUrl; leave with groupId. Admin actions: invite with groupId, email and participantId (an existing unclaimed participant) (returns a single-use URL valid for 7 days; share it with the intended person), revoke_invitation with invitationId, remove_member with userId, set_role with userId and role=admin|member. Read members, their fixed participantId, and pending invitations with get_group. For an unbound legacy member only, an admin can bind_member with userId, verified email and participantId. For a private ungrouped expense, renew_invitation with groupId and participantId atomically replaces its invitation, including an expired one; only its original email can be invited. For a new named-group participant, first call update_group preserving all existing participants, then invite the returned participantId. This returns a link and sends no email. Identity bindings cannot be changed; removal retains the identity and history. The last admin cannot leave or be demoted. A group URL grants no access. Changes apply immediately to all user keys; ledger history is preserved. Invitations are not idempotent: do not blindly retry an uncertain invite; inspect get_group first.',
  },
  {
    name: 'list_expenses',
    procedure: 'groups.expenses.list',
    description:
      'Review all expenses with pagination and optional inclusive from/to calendar dates, currencyCode, title/vendor text filter, exact case-insensitive vendor, categoryId, paidById, participantId, isReimbursement, or recurrenceRule. Include reimbursements by default. Follow nextCursor with the same filters. Current rows include attribution.createdBy and updatedBy from the immutable audit log, independently of paidBy. Null means the original actor is not known. Amounts are exact face-value decimal strings. Optional asOf (timestamp) or atActivityId reconstructs saved historical state before applying filters. Reuse history.atActivityId for stable pages; history.complete=false identifies missing legacy snapshots. This read does not process recurrence.',
  },
  {
    name: 'get_expense',
    procedure: 'groups.expenses.get',
    description:
      'Read an expense, current revision, payer, attribution.createdBy and updatedBy (authenticated authors, separate from payer), splits and attached receipt pointers and downloadUrl values. Fetch downloadUrl with X-API-Key set to your API key; storage pointers are private and are kept unchanged in edits. Requires groupId and expenseId. Money and share values are exact decimal strings; receipts are permanent references. Optional revision, asOf timestamp, or atActivityId selects historical state (choose one). history includes the authoritative saved snapshot, recordedAt and deleted marker. A deletion revision retains the prior snapshot; expense.revision identifies the deletion event. Historical recurrence scheduling links are unavailable; use the saved recurrenceRule. Historical revisions are not current write versions.',
  },
  {
    name: 'create_expense',
    procedure: 'groups.expenses.create',
    inputAliases: { expense: 'expenseFormValues' },
    destructive: false,
    description:
      'Create a group or ungrouped expense with expense. groupId is optional: when present, use the existing participant IDs from get_group and omit people. When omitted, supply people including yourself: each has a unique local id label (1-42 characters, e.g. me or friend) plus kind=account/userId from get_expense_options, or kind=email/name/email for a new invitee. expense.paidBy and paidFor.participant then refer to these local labels. Labels may be reused across expenses; the result maps them to stored participantId values for later operations. Ungrouped creation returns groupId as a private accounting context and invitation links; it sends no messages, requires isReimbursement=false and recurrenceRule=NONE, and receipts are added after saving. Optional vendor is the merchant; title describes the purchase without repeating vendor. Money is a decimal string at face value in currencyCode. Split modes: EVENLY, BY_SHARES (relative weights), BY_PERCENTAGE (sum 100), BY_AMOUNT (sum amount). Set isReimbursement=true to record payments using sender as paidBy and recipients as paidFor. Recurrence uses NONE/DAILY/WEEKLY/MONTHLY. Optional uploads file metadata returns signed PUT targets; you may ignore them. After uploading, attach uploadIds with update_expense. No receipt is saved merely by requesting a target. Supply a stable 21-character expenseId and read it before retrying an uncertain create.',
  },
  {
    name: 'update_expense',
    procedure: 'groups.expenses.update',
    inputAliases: { changes: 'expenseFormValues' },
    required: ['expectedRevision'],
    description:
      'Partially edit an expense using changes and its current expectedRevision from get_expense. Omitted fields stay unchanged. Set vendor to null or empty string to clear it. Use documents to retain/remove existing receipt references. Optional uploads returns direct PUT targets; attachUploadIds finalizes already-uploaded images into this expense. Empty changes can request targets without changing the expense. Edits are audited; a stale revision fails rather than overwriting another edit.',
  },
  {
    name: 'delete_expense',
    procedure: 'groups.expenses.delete',
    required: ['expectedRevision'],
    description:
      'Soft-delete an expense or recorded payment using its current expectedRevision. Current balances exclude it; immutable revisions and permanent receipt references remain in list_activity.',
  },
  {
    name: 'get_balances',
    procedure: 'groups.balances.list',
    description:
      'Read balances and suggested repayments in separate currency buckets, optionally filtering currencyCode. Money is exact decimal text. Currency buckets must not be added or converted. Record suggestions through create_expense with isReimbursement=true. Optional asOf timestamp or atActivityId calculates historical balances with the same splitter; missing legacy snapshots produce PRECONDITION_FAILED rather than an incomplete total.',
  },
  {
    name: 'get_participant_balances',
    procedure: 'groups.balances.forUser',
    description:
      'Read exact per-currency net balances. Omit groups to include every accessible named group and private expense context, without a page-size cap; provide a unique groups list to restrict the scope. Omit participantId to use your fixed membership; supply it to inspect a particular participant. totals contains server-calculated net amounts per currency across the selected scope. These totals do not settle or merge debts. unboundGroupIds means the result is incomplete and must be described as partial. Do not combine different currencies. Dashboard totals are independent of expense-list filters. Discover participant IDs with get_group.',
  },
  {
    name: 'get_spending_stats',
    procedure: 'groups.stats.overview',
    description:
      'Read spending totals, participant shares, categories, monthly trends and recurrence estimates in one selected currency. Optional participantId and inclusive from/to dates select the view. Discover other available currencies in availableCurrencyCodes. Money is exact decimal text.',
  },
  {
    name: 'list_activity',
    procedure: 'groups.activities.list',
    description:
      'Paginate append-only audit history with optional expenseId, activityType, inclusive UTC from/to dates, or precise recordedFrom/recordedTo timestamps. order=asc walks evolution; desc shows newest first. asOf selects a recorded-time cutoff; atActivityId selects an exact inclusive boundary. Reuse the returned atActivityId on every subsequent page with the same filters/order for a stable view. Includes snapshots, previousSnapshot, deletion markers and actor identity from authenticated web sessions or keys; legacy labels may be unverified. Uploaded bytes are pointers only. Explicit historical queries omit the current expense convenience field.',
  },
  {
    name: 'process_recurring_expenses',
    procedure: 'groups.processRecurring',
    destructive: false,
    idempotent: true,
    description:
      'Explicitly materialize due recurring expenses only in the specified group, using the server clock. Returns created expense IDs. Reads never generate recurring entries; repeated processing does not duplicate frames.',
  },
  {
    name: 'get_reference_data',
    procedure: 'reference.get',
    description:
      'Discover category IDs, supported currencies and decimal precision, split modes, recurrence rules, and whether receipt uploads are enabled with their MIME/size limits.',
  },
  {
    name: 'export_group',
    procedure: 'groups.export',
    description:
      'Export the authorized group as CSV or JSON. Returns filename, contentType and complete UTF-8 content. JSON includes preserved audit history; deleted expenses are excluded from current expense rows. This read does not process recurrence.',
  },
] as const satisfies readonly ToolDefinition[]
