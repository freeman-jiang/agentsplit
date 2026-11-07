// Fair-use limits. AgentSplit is free, with no paid tier: these limits exist
// only to stop abuse, and they are set high enough that a household never
// meets them. Each limit is one constant here, so it is easy to change. The
// server enforces them; the client and agents read them to explain them.
// No Effect import: the client bundle uses this module (BUILDING.md).

const MiB = 1024 * 1024

export const LIMITS = {
  /** Receipt storage per uploader, in bytes ("500 MB"). */
  receiptStorageBytes: 500 * MiB,
  /** One receipt image, in bytes (5 MiB). */
  receiptBytes: 5 * MiB,
  /** Receipt upload targets in one create_expense or update_expense call. */
  receiptsPerRequest: 10,
  /** Named groups that one account may create. */
  groupsCreated: 20,
  /** Participants in one group, the creator included. */
  participantsPerGroup: 50,
  /** API keys per account. */
  apiKeys: 10,
  /** Changes per account per minute, across the web app and agents. */
  writesPerMinute: 60,
  /** OAuth dynamic client registrations per IP address per hour. */
  clientRegistrationsPerHour: 20,
  /** New accounts per day, for the whole instance. SIGN_UP_DAILY_LIMIT overrides it. */
  signUpsPerDay: 200,
} as const

export const FAIR_USE = 'These are fair-use limits that keep AgentSplit free. A normal household never reaches them.'

/** Bytes as people read them: "42 MB", "1.5 MB", "0.2 MB". One MB is 1024 × 1024 bytes, as the 500 MB quota is. */
export function megabytes(bytes: number): string {
  const value = bytes / MiB
  if (value >= 10) return `${Math.round(value)} MB`
  if (bytes > 0 && value < 0.1) return '0.1 MB'
  return `${Number(value.toFixed(1))} MB`
}

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
