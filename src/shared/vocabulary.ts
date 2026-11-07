// The value lists of the ledger, in one place. The contract schemas, the
// Drizzle enums and CHECKs, the MCP tools and the client derive from these;
// test/db/database-rules.test.ts compares them with the database's CHECKs.
// No Effect import: the client bundle uses this module (BUILDING.md).

export const EXPENSE_KINDS = ['expense', 'payment'] as const
export type ExpenseKind = (typeof EXPENSE_KINDS)[number]

export const SPLIT_MODES = ['evenly', 'shares', 'percentage', 'amount'] as const
export type SplitMode = (typeof SPLIT_MODES)[number]

/** The current app's names of the split modes, as its form and its CSV export show them. */
export const SPLIT_MODE_LABELS = {
  evenly: 'Evenly',
  shares: 'Unevenly – By shares',
  percentage: 'Unevenly – By percentage',
  amount: 'Unevenly – By amount',
} as const satisfies Record<SplitMode, string>

/** The rules of a recurring expense. */
export const RECURRING_PERIODS = ['daily', 'weekly', 'monthly'] as const
export const RECURRENCES = ['none', ...RECURRING_PERIODS] as const
export type Recurrence = (typeof RECURRENCES)[number]
export const RECURRENCE_LABELS = { none: 'None', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' } as const satisfies Record<Recurrence, string>

/**
 * The fixed categories that code names, from db/migrations/0002_categories.sql.
 * General is the default; payments store Payment on every path (DECISIONS.md, P-BAL-92).
 */
export const CATEGORY = { general: 0, payment: 1 } as const

export const ROLES = ['admin', 'member'] as const
export type Role = (typeof ROLES)[number]

/** 'named' groups appear in the directory; 'private' contexts hold one ungrouped expense. */
export const GROUP_KINDS = ['named', 'private'] as const
export type GroupKind = (typeof GROUP_KINDS)[number]

export const ACTIVITY_TYPES = ['create_group', 'join_group', 'leave_group', 'update_group', 'create_expense', 'update_expense', 'delete_expense'] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** The sources v2 writes: `agent` for an API key or OAuth connection, as in the current app (P-DB-79). */
export const ACTIVITY_SOURCES = ['web', 'agent', 'system'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]
/**
 * Every source a stored row can have: the current app's baselines are
 * `baseline`, and early v2 agent writes are `mcp`, which readers show as `agent`.
 */
export const STORED_ACTIVITY_SOURCES = [...ACTIVITY_SOURCES, 'baseline', 'mcp'] as const
export type StoredActivitySource = (typeof STORED_ACTIVITY_SOURCES)[number]

/** pending: no PUT yet; writing: a PUT is running; stored: the bytes are in storage. */
export const UPLOAD_STATES = ['pending', 'writing', 'stored'] as const

export const RECEIPT_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const
export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number]
/** Each receipt type: the format that the image header names, and the extension of its object key. */
export const RECEIPT_FORMATS = {
  'image/jpeg': { format: 'jpeg', extension: 'jpg' },
  'image/png': { format: 'png', extension: 'png' },
} as const satisfies Record<ReceiptContentType, { format: string; extension: string }>
export type ReceiptFormat = (typeof RECEIPT_FORMATS)[ReceiptContentType]['format']
/** The receipt type of an image format. */
export const receiptTypeOf = (format: ReceiptFormat): ReceiptContentType => (format === RECEIPT_FORMATS['image/png'].format ? 'image/png' : 'image/jpeg')

// ---------- the current app's names ----------
// Its MCP tools, its exports, its history snapshots and its saved form defaults use them.

type Inverse<T extends Record<string, string>> = { readonly [K in keyof T as T[K]]: K }
const invert = <T extends Record<string, string>>(names: T) => Object.fromEntries(Object.entries(names).map(([value, name]) => [name, value])) as Inverse<T>

export const SPLIT_MODE_NAMES = { evenly: 'EVENLY', shares: 'BY_SHARES', percentage: 'BY_PERCENTAGE', amount: 'BY_AMOUNT' } as const satisfies Record<SplitMode, string>
export const SPLIT_MODE_BY_NAME = invert(SPLIT_MODE_NAMES)
export const SPLIT_MODE_LIST = SPLIT_MODES.map((mode) => SPLIT_MODE_NAMES[mode])

export const RECURRENCE_NAMES = { none: 'NONE', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const satisfies Record<Recurrence, string>
export const RECURRENCE_BY_NAME = invert(RECURRENCE_NAMES)
export const RECURRENCE_LIST = RECURRENCES.map((rule) => RECURRENCE_NAMES[rule])

export const ACTIVITY_TYPE_NAMES = {
  create_group: 'CREATE_GROUP',
  join_group: 'JOIN_GROUP',
  leave_group: 'LEAVE_GROUP',
  update_group: 'UPDATE_GROUP',
  create_expense: 'CREATE_EXPENSE',
  update_expense: 'UPDATE_EXPENSE',
  delete_expense: 'DELETE_EXPENSE',
} as const satisfies Record<ActivityType, string>
export const ACTIVITY_TYPE_BY_NAME = invert(ACTIVITY_TYPE_NAMES)
export const ACTIVITY_TYPE_LIST = ACTIVITY_TYPES.map((type) => ACTIVITY_TYPE_NAMES[type])
