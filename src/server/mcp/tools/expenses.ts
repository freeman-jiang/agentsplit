// Expense tools: list_expenses, get_expense, create_expense, update_expense and
// delete_expense, with the current app's inputs, outputs and errors
// (src/trpc/routers/groups/expenses/*). They call the ledger and history
// services, which check membership, validate, record history and check
// revisions. Multiple payers are new: `payers` beside the current single `paidBy`.
import { Schema } from 'effect'
import { CategoryId, Conflict, Documents, ExpenseInput, Id as IdInput, Invalid, NewId, SearchText } from '../../../shared/api'
import { PrivatePeople } from '../../../shared/api/feed'
import type { ExpenseDraft } from '../../../shared/expense-rules'
import { LIMITS, mebibytes } from '../../../shared/limits'
import { formatMinor, minorOf } from '../../../shared/minor'
import { CATEGORY, RECEIPT_CONTENT_TYPES, RECURRENCE_BY_NAME, RECURRENCE_LIST, RECURRENCE_NAMES, SPLIT_MODE_BY_NAME, SPLIT_MODE_NAMES } from '../../../shared/vocabulary'
import { randomId } from '../../../shared/ids'
import { attributionOf } from '../../activity'
import type { ExpenseFilter } from '../../expense-read'
import * as history from '../../history'
import * as ledger from '../../ledger'
import { attachUploads, prepareUploads } from '../../receipt-uploads'
import { createUngroupedExpense } from '../../ungrouped'
import { PAYMENT_RULES, RECORDING_RULES } from './instructions'
import { CurrencyCodeSchema, DecimalString } from '../../../shared/money'
import { defineTool } from './registry'
import { boundaryOf, CalendarDate, HistoryFields, PageLimit } from './inputs'
import {
  DateTime,
  ExpenseDetail,
  expenseDetail,
  ExpenseSnapshot,
  expenseSnapshot,
  ExpenseSummary,
  expenseSummary,
  HistoryView,
  Id,
  liveSource,
  Money,
  NonNegativeInt,
  NullableString,
  optional,
  RecurrenceName,
  Revision,
  savedSource,
  SplitModeName,
} from './wire'

// ---------- inputs ----------

/** Every expense field, each optional; create requires some of them. */
const expenseFields = {
  currencyCode: CurrencyCodeSchema,
  expenseDate: CalendarDate.annotate({ description: 'Calendar date in YYYY-MM-DD format' }),
  title: ExpenseInput.fields.title.annotate({
    description: 'A short title for the purchase, such as "Dinner at Nopa". Keep it short; put the calculation in notes.',
  }),
  vendor: ExpenseInput.fields.vendor.annotate({
    description:
      'Optional merchant name, e.g. Costco. Keep the purchase description in title without repeating vendor. Set null or empty string to clear.',
  }),
  category: CategoryId,
  amount: DecimalString.annotate({
    description:
      'The full amount paid, as an exact decimal string in currencyCode, including the payer’s own share. A negative amount records income. Never record only what other people owe.',
  }),
  paidBy: IdInput.annotate({ description: 'The participant ID of the one person who paid the whole amount. Use payers instead when several people paid.' }),
  payers: Schema.Array(Schema.Struct({ participant: IdInput, amount: DecimalString }))
    .check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup))
    .annotate({
      description:
        'Instead of paidBy, when several people paid: each payer’s participant ID and exact amount. The amounts add up to amount.',
    }),
  paidFor: Schema.Array(Schema.Struct({ participant: IdInput, shares: DecimalString }))
    .check(Schema.isBetweenLength(1, LIMITS.participantsPerGroup))
    .annotate({
      description: `Everyone who shares the cost, with their share. Include the payer with their share, unless the payer paid only for other people. shares: "1" each for ${SPLIT_MODE_NAMES.evenly}, relative weights for ${SPLIT_MODE_NAMES.shares}, percentages summing to "100" for ${SPLIT_MODE_NAMES.percentage}, exact amounts summing to amount for ${SPLIT_MODE_NAMES.amount}.`,
    }),
  splitMode: SplitModeName,
  isReimbursement: Schema.Boolean,
  documents: Documents,
  notes: ExpenseInput.fields.notes.annotate({
    description:
      'The full calculation, so that a person can recalculate every number: each item, tax, tip, discount, and how each person’s share was found.',
  }),
  recurrenceRule: RecurrenceName,
}

const ExpenseCreateInput = Schema.Struct({
  currencyCode: expenseFields.currencyCode,
  expenseDate: expenseFields.expenseDate,
  title: expenseFields.title,
  vendor: optional(expenseFields.vendor),
  category: optional(
    expenseFields.category.annotate({ description: `Category ID from get_reference_data. Default ${CATEGORY.general} (General), or ${CATEGORY.payment} (Payment) when isReimbursement is true.` }),
  ),
  amount: expenseFields.amount,
  paidBy: optional(expenseFields.paidBy),
  payers: optional(expenseFields.payers),
  paidFor: expenseFields.paidFor,
  splitMode: optional(expenseFields.splitMode.annotate({ default: SPLIT_MODE_NAMES.evenly })),
  isReimbursement: expenseFields.isReimbursement,
  documents: optional(expenseFields.documents.annotate({ default: [] })),
  notes: optional(expenseFields.notes),
  recurrenceRule: optional(expenseFields.recurrenceRule.annotate({ default: RECURRENCE_NAMES.none })),
}).annotate({ description: `The expense. ${RECORDING_RULES}` })
/** The `expense` argument of create_expense as an agent sends it. */
export type ExpenseCreateArgument = typeof ExpenseCreateInput.Encoded

const ExpenseChanges = Schema.Struct(
  Object.fromEntries(Object.entries(expenseFields).map(([key, schema]) => [key, optional(schema)])) as {
    [K in keyof typeof expenseFields]: Schema.optionalKey<(typeof expenseFields)[K]>
  },
).annotate({ description: `Only the fields to change. ${RECORDING_RULES}` })

const Uploads = Schema.Array(
  Schema.Struct({
    filename: Schema.String.check(Schema.isBetweenLength(1, LIMITS.receiptFilenameMax)),
    contentType: Schema.Literals(RECEIPT_CONTENT_TYPES),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.receiptBytes })),
  }),
).check(Schema.isMaxLength(LIMITS.receiptsPerRequest))

// ---------- outputs ----------

const RevisionHistory = Schema.Struct({
  activityId: Id,
  recordedAt: DateTime,
  revision: Schema.Int,
  deleted: Schema.Boolean,
  snapshot: ExpenseSnapshot,
})

const UploadTarget = Schema.Struct({
  uploadId: Id,
  filename: Schema.String,
  method: Schema.Literal('PUT'),
  url: Schema.String,
  headers: Schema.Struct({ 'Content-Type': Schema.String, 'Content-Length': Schema.String }),
  expiresAt: DateTime,
})
const ExpenseWrite = {
  expenseId: Id,
  revision: Revision,
  amount: Money,
  currencyCode: Schema.String,
  uploads: Schema.Array(UploadTarget),
  uploadError: NullableString,
}

// ---------- reading ----------

/**
 * The page is the current app's offset page: `cursor` is the offset, and
 * nextCursor is the offset of the next page. The live list pages by offset
 * through ledger.listExpenses; the historical one through listSavedExpenses.
 */
export const listExpenses = defineTool({
  name: 'list_expenses',
  kind: 'read',
  description:
    'Review all expenses with pagination and optional inclusive from/to calendar dates, currencyCode, title/vendor/notes text filter, exact case-insensitive vendor, categoryId, paidById, participantId, isReimbursement, or recurrenceRule. Include reimbursements by default. Follow nextCursor with the same filters while hasMore is true. Current rows include attribution.createdBy and updatedBy from the immutable audit log, independently of paidBy. Null means the original actor is not known. Amounts are exact face-value decimal strings. paidBy is the payer who paid the most; payers lists every payer when several people paid. Optional asOf (timestamp) or atActivityId reconstructs saved historical state before applying filters. Reuse history.atActivityId for stable pages; history.complete=false identifies missing legacy snapshots. This read does not process recurrence.',
  input: Schema.Struct({
    ...HistoryFields,
    groupId: IdInput,
    cursor: optional(NonNegativeInt.annotate({ default: 0, description: 'The offset of the page: nextCursor of the previous page.' })),
    limit: optional(PageLimit(LIMITS.agentExpensePage)),
    filter: optional(SearchText),
    vendor: optional(SearchText.annotate({ description: 'Exact merchant name, case-insensitive.' })),
    currencyCode: optional(CurrencyCodeSchema),
    categoryId: optional(CategoryId),
    paidById: optional(IdInput),
    participantId: optional(IdInput),
    isReimbursement: optional(Schema.Boolean),
    recurrenceRule: optional(RecurrenceName),
    from: optional(CalendarDate.annotate({ description: 'Inclusive expense date, YYYY-MM-DD' })),
    to: optional(CalendarDate.annotate({ description: 'Inclusive expense date, YYYY-MM-DD' })),
  }).check(Schema.makeFilter((i) => !i.from || !i.to || i.from <= i.to || 'from must be on or before to')),
  strict: [''],
  output: Schema.Struct({ history: optional(HistoryView), expenses: Schema.Array(ExpenseSummary), hasMore: Schema.Boolean, nextCursor: NonNegativeInt }),
  run: async ({ db, principal }, input) => {
    const offset = input.cursor ?? 0
    const limit = input.limit ?? LIMITS.agentExpensePage
    const filter: ExpenseFilter = {
      ...(input.filter === undefined ? {} : { search: input.filter }),
      ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
      ...(input.currencyCode === undefined ? {} : { currency: input.currencyCode }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.paidById === undefined ? {} : { payerId: input.paidById }),
      ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
      ...(input.isReimbursement === undefined ? {} : { kind: input.isReimbursement ? ('payment' as const) : ('expense' as const) }),
      ...(input.recurrenceRule === undefined ? {} : { recurrence: RECURRENCE_BY_NAME[input.recurrenceRule] }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    }
    if (input.asOf !== undefined || input.atActivityId !== undefined) {
      const saved = await history.listSavedExpenses(db, { principal, groupId: input.groupId, ...boundaryOf(input), cursor: offset, limit, filter })
      return {
        history: saved.history,
        expenses: saved.expenses.map((e) => expenseSummary(savedSource(e), { attribution: null })),
        hasMore: saved.hasMore,
        nextCursor: saved.nextCursor,
      }
    }
    const page = await ledger.listExpenses(db, { principal, groupId: input.groupId, filter, cursor: null, offset, limit, parts: { names: true, attribution: true } })
    return {
      expenses: page.expenses.map((e) => expenseSummary(liveSource(e), { attribution: attributionOf({ events: e.attributionEvents ?? [], viewer: principal.userId }) })),
      hasMore: page.nextCursor !== null,
      nextCursor: offset + limit,
    }
  },
})

export const getExpense = defineTool({
  name: 'get_expense',
  kind: 'read',
  description:
    'Read an expense, current revision, payer, attribution.createdBy and updatedBy (authenticated authors, separate from payer), splits and attached receipt pointers and downloadUrl values. Fetch downloadUrl with X-API-Key set to your API key and follow its redirect; storage pointers are private and are kept unchanged in edits. Requires groupId and expenseId. Money and share values are exact decimal strings. A receipt deleted for good has deleted { by, at } and no downloadUrl; documents[].receiptId names a receipt for delete_receipts. paidBy is the payer who paid the most; payers lists every payer. Optional revision, asOf timestamp, or atActivityId selects historical state (choose one). history includes the authoritative saved snapshot, recordedAt and deleted marker. A deletion revision retains the prior snapshot; expense.revision identifies the deletion event. Historical recurrence scheduling links are unavailable; use the saved recurrenceRule. Historical revisions are not current write versions.',
  input: Schema.Struct({
    groupId: IdInput,
    expenseId: IdInput,
    ...HistoryFields,
    revision: optional(NonNegativeInt.annotate({ description: 'Exact saved expense revision; exclusive with asOf/atActivityId.' })),
  }),
  strict: [''],
  output: Schema.Struct({ history: optional(RevisionHistory), expense: ExpenseDetail }),
  run: async ({ db, principal, baseUrl }, input) => {
    const viewer = principal.userId
    if (input.revision !== undefined || input.asOf !== undefined || input.atActivityId !== undefined) {
      const saved = await history.getSavedExpense(db, {
        principal,
        groupId: input.groupId,
        expenseId: input.expenseId,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...boundaryOf(input),
        attribution: true,
      })
      const { groupId, expense } = saved
      return {
        history: { ...saved.history, snapshot: expenseSnapshot({ expense, groupId }) },
        expense: expenseDetail(savedSource(expense), {
          groupId,
          revision: saved.history.revision,
          baseUrl,
          attribution: attributionOf({ events: saved.attributionEvents ?? [], viewer: viewer }),
          documents: expense.documents,
          link: null,
          deletedAt: saved.deletedAt,
        }),
      }
    }
    const e = await ledger.getExpense(db, { principal, groupId: input.groupId, expenseId: input.expenseId, parts: { names: true, documents: true, attribution: true } })
    return {
      expense: expenseDetail(liveSource(e), {
        groupId: e.groupId,
        revision: e.revision,
        baseUrl,
        attribution: attributionOf({ events: e.attributionEvents ?? [], viewer: viewer }),
        documents: e.documents ?? [],
        link: e.link,
        deletedAt: null,
      }),
    }
  },
})

// ---------- writing ----------

type ExpenseInputs = typeof ExpenseCreateInput.Type
type Changes = typeof ExpenseChanges.Type

const DUPLICATE_ID = 'Expense ID already exists. Read it before retrying; use a new ID only for a distinct expense.'

/** paidBy (one payer of the whole amount) or payers (each with an amount), never both. */
function payersOf(data: { paidBy: string | undefined; payers: ExpenseInputs['payers'] }): ledger.ExpensePatch['payers'] {
  if (data.paidBy !== undefined && data.payers !== undefined)
    throw new Invalid({ message: 'Use paidBy for one payer or payers for several people, not both.' })
  if (data.payers) return data.payers.map((p) => ({ participantId: p.participant, amount: p.amount }))
  return data.paidBy === undefined ? undefined : { sole: data.paidBy }
}

const sharesOf = (paidFor: ExpenseInputs['paidFor']) => paidFor.map((p) => ({ participantId: p.participant, weight: p.shares }))

function draftOf(input: ExpenseInputs): ExpenseDraft {
  const payers = payersOf({ paidBy: input.paidBy, payers: input.payers })
  if (payers === undefined) throw new Invalid({ message: 'Choose who paid: paidBy, or payers with each amount.' })
  return {
    kind: input.isReimbursement ? 'payment' : 'expense',
    title: input.title,
    vendor: input.vendor ?? null,
    notes: input.notes ?? '',
    // Payments store Payment on every path (DECISIONS.md, P-BAL-92).
    categoryId: input.category ?? (input.isReimbursement ? CATEGORY.payment : CATEGORY.general),
    expenseDate: input.expenseDate,
    currency: input.currencyCode,
    amount: input.amount,
    payers: 'sole' in payers ? [{ participantId: payers.sole, amount: input.amount }] : payers,
    splitMode: SPLIT_MODE_BY_NAME[input.splitMode ?? SPLIT_MODE_NAMES.evenly],
    shares: sharesOf(input.paidFor),
    recurrence: RECURRENCE_BY_NAME[input.recurrenceRule ?? RECURRENCE_NAMES.none],
  }
}

/** The changes under the ledger's names. Only the given fields are in the patch. */
function patchOf(c: Changes): ledger.ExpensePatch {
  const payers = payersOf({ paidBy: c.paidBy, payers: c.payers })
  return {
    ...(c.isReimbursement === undefined ? {} : { kind: c.isReimbursement ? ('payment' as const) : ('expense' as const) }),
    ...(c.title === undefined ? {} : { title: c.title }),
    ...(c.vendor === undefined ? {} : { vendor: c.vendor }),
    ...(c.notes === undefined ? {} : { notes: c.notes }),
    ...(c.category === undefined ? {} : { categoryId: c.category }),
    ...(c.expenseDate === undefined ? {} : { expenseDate: c.expenseDate }),
    ...(c.currencyCode === undefined ? {} : { currency: c.currencyCode }),
    ...(c.amount === undefined ? {} : { amount: c.amount }),
    ...(payers === undefined ? {} : { payers }),
    ...(c.splitMode === undefined ? {} : { splitMode: SPLIT_MODE_BY_NAME[c.splitMode] }),
    ...(c.paidFor === undefined ? {} : { shares: sharesOf(c.paidFor) }),
    ...(c.recurrenceRule === undefined ? {} : { recurrence: RECURRENCE_BY_NAME[c.recurrenceRule] }),
    ...(c.documents === undefined ? {} : { documents: c.documents }),
  }
}

export const createExpense = defineTool({
  name: 'create_expense',
  kind: 'write',
  destructive: false,
  description: `Create a group or ungrouped expense with expense. ${RECORDING_RULES} groupId is optional: when present, use the existing participant IDs from get_group and omit people. When omitted, supply people including yourself: each has a unique local id label (1-${LIMITS.localIdMax} characters, e.g. me or friend) plus kind=account/userId from get_expense_options, or kind=email/name/email for a new invitee. expense.paidBy and paidFor.participant then refer to these local labels. Labels may be reused across expenses; the result maps them to stored participantId values for later operations. Ungrouped creation returns groupId as a private accounting context and invitation links; it sends no messages, requires isReimbursement=false and recurrenceRule=NONE, and receipts are added after saving. Optional vendor is the merchant; title describes the purchase without repeating vendor. Money is a decimal string at face value in currencyCode. One payer: paidBy. Several payers: payers with each exact amount, adding up to amount. Split modes: ${SPLIT_MODE_NAMES.evenly}, ${SPLIT_MODE_NAMES.shares} (relative weights), ${SPLIT_MODE_NAMES.percentage} (sum 100), ${SPLIT_MODE_NAMES.amount} (sum amount). ${PAYMENT_RULES} Recurrence uses ${RECURRENCE_LIST.join('/')}. Optional uploads file metadata (JPEG or PNG, at most ${mebibytes(LIMITS.receiptBytes)}, at most ${LIMITS.receiptsPerRequest} files) returns PUT targets; you may ignore them. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (${LIMITS.uploadTargetSeconds} seconds); a used or expired url is refused. Then attach the uploadIds within ${LIMITS.uploadAttachHours} hours with update_expense, the current revision and attachUploadIds. No receipt is saved merely by requesting a target or uploading. Supply a stable 21-character expenseId and read it before retrying an uncertain create.`,
  input: Schema.Struct({
    groupId: optional(
      IdInput.annotate({
        description: 'Named group ID, or a private context ID when recording its repayment. Omit for a new ungrouped expense and supply people.',
      }),
    ),
    people: optional(PrivatePeople),
    expense: ExpenseCreateInput,
    uploads: optional(Uploads),
    expenseId: optional(NewId),
  }),
  strict: ['', 'expense', 'uploads[]'],
  output: Schema.Struct({
    groupId: Id,
    ...ExpenseWrite,
    participants: optional(Schema.Array(Schema.Struct({ localId: Id, participantId: Id, name: Schema.String }))),
    invitations: optional(Schema.Array(Schema.Struct({ email: Schema.String, url: Schema.String, expiresAt: DateTime }))),
  }),
  run: async ({ db, principal, baseUrl }, input) => {
    if (input.groupId === undefined && !input.people) throw new Invalid({ message: 'Supply groupId for a group expense, or people for an ungrouped expense.' })
    if (input.groupId !== undefined && input.people) throw new Invalid({ message: 'With groupId, use its existing participant IDs and omit people.' })
    const expenseId = input.expenseId ?? randomId()
    const draft = draftOf(input.expense)
    // The stable create ID is the idempotency guard: a reused ID is a Conflict, never a second expense.
    // So the tool sends no idempotency key, and the write skips the key's lookup and row.
    const duplicate = (error: unknown) => (error instanceof Conflict && error.id === expenseId ? new Conflict({ ...error, message: DUPLICATE_ID }) : error)
    const idempotencyKey = null
    if (input.groupId === undefined) {
      if (input.uploads?.length || input.expense.documents?.length) throw new Invalid({ message: 'Save an ungrouped expense first, then attach its receipts.' })
      const created = await createUngroupedExpense(db, { principal, baseUrl, expenseId, idempotencyKey, people: input.people ?? [], expense: draft }).catch((error: unknown) => {
        throw duplicate(error)
      })
      return {
        groupId: created.groupId,
        expenseId: created.expenseId,
        revision: created.revision,
        // The ledger accepted the amount, so it has the currency's precision.
        amount: formatMinor({ amount: minorOf(draft.amount, draft.currency), currency: draft.currency }),
        currencyCode: draft.currency,
        participants: created.participants,
        invitations: created.invitations,
        uploads: [],
        uploadError: null,
      }
    }
    const saved = await ledger
      .createExpense(db, { principal, groupId: input.groupId, expenseId, idempotencyKey, expense: draft, documents: input.expense.documents ?? [] })
      .catch((error: unknown) => {
        throw duplicate(error)
      })
    const targets = await prepareUploads(db, { principal, groupId: saved.groupId, expenseId: saved.id, requests: input.uploads, baseUrl })
    return { groupId: saved.groupId, expenseId: saved.id, revision: saved.revision, amount: saved.amount, currencyCode: saved.currency, ...targets }
  },
})

export const updateExpense = defineTool({
  name: 'update_expense',
  kind: 'write',
  description: `Partially edit an expense using changes and its current expectedRevision from get_expense. Omitted fields stay unchanged. ${RECORDING_RULES} Set vendor to null or empty string to clear it. To change who paid, send paidBy (one payer) or payers (several, each with an amount); an expense with several payers needs payers again when its amount changes. Use documents to retain/remove existing receipt references. Optional uploads returns PUT targets for this expense. PUT the file bytes once to each target url with exactly its headers, no API key, before expiresAt (${LIMITS.uploadTargetSeconds} seconds); a used or expired url is refused. attachUploadIds then adds those uploaded images to this expense in one audited revision; only your own uploads for this expense can be attached, each once. Empty changes can request targets without changing the expense. Edits are audited; a stale revision fails rather than overwriting another edit.`,
  input: Schema.Struct({
    expenseId: IdInput,
    groupId: IdInput,
    changes: optional(ExpenseChanges.annotate({ default: {} })),
    expectedRevision: NonNegativeInt,
    uploads: optional(Uploads),
    attachUploadIds: optional(Schema.Array(NewId).check(Schema.isMaxLength(LIMITS.receiptsPerRequest))),
  }),
  strict: ['', 'changes', 'uploads[]'],
  output: Schema.Struct(ExpenseWrite),
  run: async ({ db, principal, baseUrl, bucket }, input) => {
    const uploadIds = input.attachUploadIds ?? []
    const saved = await ledger.patchExpense(db, {
      principal,
      groupId: input.groupId,
      expenseId: input.expenseId,
      expectedRevision: input.expectedRevision,
      patch: patchOf(input.changes ?? {}),
      attach: (current) => attachUploads(db, { principal, groupId: current.groupId, expenseId: current.id, uploadIds, bucket }),
    })
    const targets = await prepareUploads(db, { principal, groupId: saved.groupId, expenseId: saved.id, requests: input.uploads, baseUrl })
    return { expenseId: saved.id, revision: saved.revision, amount: saved.amount, currencyCode: saved.currency, ...targets }
  },
})

export const deleteExpense = defineTool({
  name: 'delete_expense',
  kind: 'write',
  description:
    'Soft-delete an expense or recorded payment using its current expectedRevision. Current balances exclude it; immutable revisions and permanent receipt references remain in list_activity.',
  input: Schema.Struct({ expenseId: IdInput, groupId: IdInput, expectedRevision: NonNegativeInt }),
  strict: [''],
  output: Schema.Struct({ expenseId: Id, revision: Revision, deleted: Schema.Literal(true) }),
  run: async ({ db, principal }, input) => {
    const { revision } = await ledger.deleteExpense(db, {
      principal,
      groupId: input.groupId,
      expenseId: input.expenseId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: null,
    })
    return { expenseId: input.expenseId, revision, deleted: true as const }
  },
})
