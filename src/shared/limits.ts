// Every limit that a person or an agent can meet, in one table. The contract
// schemas, the Drizzle CHECKs, the MCP schemas and descriptions, the rule
// messages and the client derive from it, and the server enforces it.
// Technical buffers (body envelopes, header reads) stay beside their code.
// The fair-use limits exist only to stop abuse: AgentSplit is free, with no
// paid tier, and they are set high enough that a household never meets them.
// No Effect import: the client bundle uses this module (BUILDING.md).

const MiB = 1024 * 1024

/** The fair-use limits that reference.get and get_reference_data publish. */
export const FAIR_USE_LIMITS = {
  /** Receipt storage per uploader, in bytes ("500 MB"). */
  receiptStorageBytes: 500 * MiB,
  /** One receipt image, in bytes (5 MiB). */
  receiptBytes: 5 * MiB,
  /** Receipt upload targets in one create_expense or update_expense call. */
  receiptsPerRequest: 10,
  /** Named groups that one account may create. */
  groupsCreated: 20,
  /** People in one group or one expense, the creator included. */
  participantsPerGroup: 50,
  /** API keys per account. */
  apiKeys: 10,
  /** Changes per account per minute, across the web app and agents. */
  writesPerMinute: 60,
  /** OAuth dynamic client registrations per IP address per hour. */
  clientRegistrationsPerHour: 20,
} as const

export const LIMITS = {
  ...FAIR_USE_LIMITS,
  /** New accounts per day, for the whole instance. SIGN_UP_DAILY_LIMIT overrides it, so it is not published. */
  signUpsPerDay: 200,
  /** MCP requests per user per minute: the current app's token bucket, refilled at 2 per second (P-MCP-85). */
  mcpRequestsPerMinute: 120,
  /** Requests per API key per minute (Better Auth's per-key rate limit). */
  apiKeyRequestsPerMinute: 120,

  // Expense fields, as the current app's src/lib/schemas.ts.
  titleMin: 2,
  titleMax: 200,
  vendorMax: 100,
  notesMax: 5_000,
  /** The largest absolute amount, in major units of any currency. */
  amountMax: 10_000_000,
  /** The longest decimal text of an amount or a share. */
  decimalMax: 32,
  /** Receipt pointers on one expense. */
  documentsPerExpense: 100,
  /** The file name of a receipt upload. */
  receiptFilenameMax: 255,
  /** The pixels of one receipt image (width × height). */
  receiptPixelsMax: 40_000_000,
  /** A receipt URL or an invitation link as a person pastes it. */
  urlMax: 2000,
  /** The local label of a person of a new ungrouped expense, such as "me". */
  localIdMax: 42,
  /** An account ID as a client sends it. */
  userIdMax: 128,
  /** An OAuth client ID. */
  clientIdMax: 2048,

  // Names and group settings.
  /** Group, person and profile names. */
  nameMax: 50,
  /** The text of a name that the server trims before it checks nameMax. */
  nameInputMax: 200,
  /** An email address (RFC 5321). */
  emailMax: 254,
  groupNameMin: 2,
  apiKeyNameMax: 32,
  informationMax: 10_000,
  slugMin: 3,
  slugMax: 63,
  searchMax: 200,

  // Pages.
  /** The most rows that one list request reads, or one delete request names. */
  pageMax: 100,
  /** Expense lists, payments and the dashboard feed. */
  expensePage: 30,
  /** The group Log (P-HIST-65). */
  logPage: 20,
  /** The receipts on the storage page. */
  receiptPage: 20,
  /** Groups per page of the directory. */
  directoryPage: 100,
  /** The most saved expenses that one historical list request reads. */
  historyPageMax: 200,
  // The current app's MCP page sizes, when an agent gives no limit.
  agentExpensePage: 10,
  agentActivityPage: 5,
  agentReceiptPage: 50,

  // Times.
  invitationDays: 7,
  /** An upload target is valid this long for its PUT, as the current app's presigned URLs (P-RECEIPT-33). */
  uploadTargetSeconds: 300,
  /** A stored upload can be attached this long after its PUT (P-RECEIPT-39). */
  uploadAttachHours: 24,
  /** An OAuth access token, as in the current app. */
  accessTokenSeconds: 300,
  /** An OAuth refresh token; each refresh rotates it. */
  refreshTokenDays: 30,
  /** A web session, which Better Auth extends once a day while it is used. */
  sessionDays: 7,
} as const

/** What each fair-use limit limits, as get_reference_data's description and MCP.md's table name it. */
export const FAIR_USE_LABELS = {
  receiptStorageBytes: 'Receipt storage per uploader',
  receiptBytes: 'One receipt image',
  receiptsPerRequest: 'Upload targets per request',
  groupsCreated: 'Named groups that one account creates',
  participantsPerGroup: 'People in one group',
  apiKeys: 'API keys per account',
  writesPerMinute: 'Writes per account',
  clientRegistrationsPerHour: 'Client registrations per IP address',
} as const satisfies Record<keyof typeof FAIR_USE_LIMITS, string>

export const FAIR_USE = 'These are fair-use limits that keep AgentSplit free. A normal household never reaches them.'

/** Bytes as people read them: "42 MB", "1.5 MB", "0.2 MB". One MB is 1024 × 1024 bytes, as the 500 MB quota is. */
export function megabytes(bytes: number): string {
  const value = bytes / MiB
  if (value >= 10) return `${Math.round(value)} MB`
  if (bytes > 0 && value < 0.1) return '0.1 MB'
  return `${Number(value.toFixed(1))} MB`
}

/** A size limit as the current app's receipt messages state it: "5 MiB". */
export const mebibytes = (bytes: number) => `${Number((bytes / MiB).toFixed(1))} MiB`

/** A count as English text: words below ten ("two"), digits with separators above ("5,000"). */
export const numberText = (value: number) =>
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][value] ?? value.toLocaleString('en-US')

/** The answer to an upload that does not fit the uploader's receipt storage. */
export const storageFullMessage = (usedBytes: number) =>
  `You're out of receipt space (${megabytes(usedBytes)} of ${megabytes(LIMITS.receiptStorageBytes)}). Download or delete old receipts in Settings, under Storage and limits, to free space. ${FAIR_USE}`

export const tooManyWritesMessage = (seconds: number) =>
  `You're making changes too quickly. Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} and try again. ${FAIR_USE}`

export const groupLimitMessage = `You have created ${LIMITS.groupsCreated} groups, the most one account can create. Use one of your groups, or ask someone else to create the new one. ${FAIR_USE}`

export const participantLimitMessage = `A group can have at most ${LIMITS.participantsPerGroup} people. ${FAIR_USE}`

export const apiKeyLimitMessage = `You have ${LIMITS.apiKeys} API keys, the most one account can have. Revoke a key you no longer use, then create the new one. ${FAIR_USE}`

/** The error code that the sign-in page explains. */
export const SIGN_UP_LIMIT_CODE = 'SIGN_UP_LIMIT'
export const signUpLimitMessage = `AgentSplit has reached today's limit for new accounts. Please try again tomorrow. Existing accounts can still sign in. ${FAIR_USE}`
