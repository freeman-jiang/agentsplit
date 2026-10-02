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
    name: 'list_groups',
    procedure: 'groups.list',
    description:
      'List all groups available to your user. Keys inherit the same memberships. Page with nextCursor while hasMore is true; optionally supply a subset of groupIds.',
  },
  {
    name: 'get_group',
    procedure: 'groups.getDetails',
    description:
      'Read group details, its revision, participant IDs, member roles, pending invitations (admins only), group/export links, and participant IDs referenced by expenses. access.participantId is your fixed identity (null means an admin must bind a legacy account). Each member is tied to one participant, but any member may record another participant as payer; authenticated authorship remains separate.',
  },
  {
    name: 'create_group',
    procedure: 'groups.create',
    inputAliases: { group: 'groupFormValues' },
    destructive: false,
    description:
      'Create a group. The authenticated creator is automatically added as a participant using their account name and becomes admin. Supply name, currency/default currencyCode, and OTHER participant names in group.participants (empty array allowed); do not include the creator. All keys inherit the fixed membership. An optional caller-minted 21-character groupId prevents accidental duplicate creation; check it before retrying an uncertain result.',
  },
  {
    name: 'update_group',
    procedure: 'groups.update',
    inputAliases: { changes: 'groupFormValues' },
    required: ['expectedRevision'],
    description:
      'Admins only: edit group settings or participants using a partial changes object and the current expectedRevision from get_group. Omitted fields stay unchanged. Existing participant IDs preserve identities; entries without IDs create participants. Historical participants cannot be erased.',
  },
  {
    name: 'manage_group_access',
    procedure: 'groups.access',
    destructive: true,
    idempotent: false,
    description:
      'Manage membership: join with an email-bound invitation shareUrl; leave with groupId. Admin actions: invite with groupId, email and participantId (an existing unclaimed participant) (returns a single-use URL valid for 7 days; share it with the intended person), revoke_invitation with invitationId, remove_member with userId, set_role with userId and role=admin|member. Read members, their fixed participantId, and pending invitations with get_group. For an unbound legacy member only, an admin can bind_member with userId, verified email and participantId. Identity bindings cannot be changed; removal retains the identity and history. The last admin cannot leave or be demoted. A group URL grants no access. Changes apply immediately to all user keys; ledger history is preserved. Invitations are not idempotent: do not blindly retry an uncertain invite; inspect get_group first.',
  },
  {
    name: 'list_expenses',
    procedure: 'groups.expenses.list',
    description:
      'Review all expenses with pagination and optional inclusive from/to calendar dates, currencyCode, title filter, categoryId, paidById, participantId, isReimbursement, or recurrenceRule. Include reimbursements by default. Follow nextCursor with the same filters. Current rows include attribution.createdBy and updatedBy from the immutable audit log, independently of paidBy. Null means the original actor is not known. Amounts are exact face-value decimal strings. Optional asOf (timestamp) or atActivityId reconstructs saved historical state before applying filters. Reuse history.atActivityId for stable pages; history.complete=false identifies missing legacy snapshots. This read does not process recurrence.',
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
      'Create an expense with expense. Money is a decimal string at face value in currencyCode. Split modes: EVENLY, BY_SHARES (relative weights), BY_PERCENTAGE (sum 100), BY_AMOUNT (sum amount). Set isReimbursement=true to record payments using sender as paidBy and recipients as paidFor. Recurrence uses NONE/DAILY/WEEKLY/MONTHLY. Optional uploads file metadata returns signed PUT targets; you may ignore them. After uploading, attach uploadIds with update_expense. No receipt is saved merely by requesting a target. Supply a stable 21-character expenseId and read it before retrying an uncertain create.',
  },
  {
    name: 'update_expense',
    procedure: 'groups.expenses.update',
    inputAliases: { changes: 'expenseFormValues' },
    required: ['expectedRevision'],
    description:
      'Partially edit an expense using changes and its current expectedRevision from get_expense. Omitted fields stay unchanged. Use documents to retain/remove existing receipt references. Optional uploads returns direct PUT targets; attachUploadIds finalizes already-uploaded images into this expense. Empty changes can request targets without changing the expense. Edits are audited; a stale revision fails rather than overwriting another edit.',
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
      'Read net balances across selected groups. Omit participantId to use your fixed membership; supply it to inspect a particular participant. unboundGroupIds lists legacy groups needing admin identity setup, so a partial result must not be reported as a complete total. Discover IDs with get_group. Each result includes its currency; never sum unlike currencies.',
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
