// What each declared error means to a caller, for both transports. The error
// classes are in src/shared/api/core.ts; this module holds no Effect, so the
// client can read the same texts (BUILDING.md).

/**
 * The one answer for a group that does not exist or that the caller is not a
 * member of, on RPC, MCP and the HTTP routes. It does not say which, so a group
 * ID reveals nothing (DECISIONS.md, parity audit: agent output).
 */
export const GROUP_DENIED = 'Group not found, or you are not a member'

/** What a NotFound names, with the current app's text for each (MCP agents read these). */
export const NOT_FOUND_MESSAGES = {
  expense: 'Expense not found',
  group: 'Group not found.',
  invitation: 'Invitation not found or no longer valid',
  pendingInvitation: 'Pending invitation not found',
  member: 'Member not found',
  account: 'Account not found',
  apiKey: 'API key not found',
  receipt: 'Receipt not found',
  boundary: 'History boundary not found in this group',
  revision: 'Expense revision not found at this point',
  groupAtTime: 'The group did not exist at this time',
} as const

export type NotFoundEntity = keyof typeof NOT_FOUND_MESSAGES
export const NOT_FOUND_ENTITIES = Object.keys(NOT_FOUND_MESSAGES) as [NotFoundEntity, ...NotFoundEntity[]]

/**
 * Why an Invalid request cannot apply, when it is not the arguments:
 * - `state`: it conflicts with the current state (the last admin, a used invitation, a taken ID); read again.
 * - `rate`: the caller's fair-use write budget is spent; nothing changed, wait.
 * - `precondition`: the request is well formed but the data does not allow it (incomplete history, a full receipt quota).
 */
export const INVALID_REASONS = ['state', 'rate', 'precondition'] as const
export type InvalidReason = (typeof INVALID_REASONS)[number]

/** The text of a revision Conflict that names no other cause. */
export const REVISION_CONFLICT = 'The record changed. Read its current revision and retry your intended changes.'

/** The text of every failure that is not an answer to the request; the cause is logged, never sent. */
export const UNAVAILABLE = 'The server could not complete this request. For a change, read the record before retrying.'

/** The MCP text of an unexpected failure. */
export const MCP_INTERNAL = 'Unable to complete this operation. Check the arguments; for an uncertain write, read its record before retrying.'

export type McpCode = 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED' | 'TOO_MANY_REQUESTS' | 'INTERNAL_SERVER_ERROR'
export type Recovery = 'correct_arguments' | 'read_current_revision' | 'retry_later' | 'read_before_retry'

type Answer = {
  /** An answer to the caller's own request (logged as a warning), or a failure of the server (logged as an error). */
  readonly answer: boolean
  /** The current app's tRPC code, which MCP results keep. */
  readonly mcp: McpCode
  readonly recovery: Recovery
  /** The status of a plain HTTP route (receipts, uploads, exports). */
  readonly http: number
}

/**
 * Every declared error, by tag (and by reason for Invalid): how RPC logs it,
 * and the code and recovery of an MCP error result. Unavailable is every
 * failure that is not an answer; only a write can leave its outcome unknown.
 */
export const ERROR_ANSWERS = {
  Unauthorized: { answer: true, mcp: 'FORBIDDEN', recovery: 'correct_arguments', http: 401 },
  Forbidden: { answer: true, mcp: 'FORBIDDEN', recovery: 'correct_arguments', http: 403 },
  NotFound: { answer: true, mcp: 'NOT_FOUND', recovery: 'correct_arguments', http: 404 },
  Conflict: { answer: true, mcp: 'CONFLICT', recovery: 'read_current_revision', http: 409 },
  Invalid: { answer: true, mcp: 'BAD_REQUEST', recovery: 'correct_arguments', http: 400 },
  'Invalid.state': { answer: true, mcp: 'CONFLICT', recovery: 'read_current_revision', http: 409 },
  'Invalid.rate': { answer: true, mcp: 'TOO_MANY_REQUESTS', recovery: 'retry_later', http: 429 },
  // The only precondition of an HTTP route is a full receipt quota, which the current app answered 413.
  'Invalid.precondition': { answer: true, mcp: 'PRECONDITION_FAILED', recovery: 'correct_arguments', http: 413 },
  Unavailable: { answer: false, mcp: 'INTERNAL_SERVER_ERROR', recovery: 'read_before_retry', http: 503 },
} as const satisfies Record<string, Answer>

export type ErrorKind = keyof typeof ERROR_ANSWERS

/** A declared error as it crosses a transport: its tag, and the fields that decide its answer. */
export type DeclaredError =
  | { readonly _tag: 'Unauthorized' }
  | { readonly _tag: 'Forbidden'; readonly message: string }
  | { readonly _tag: 'NotFound'; readonly entity: NotFoundEntity }
  | { readonly _tag: 'Conflict'; readonly message?: string | undefined }
  | { readonly _tag: 'Invalid'; readonly message: string; readonly reason?: InvalidReason | undefined }
  | { readonly _tag: 'Unavailable'; readonly message: string }

export const errorKind = (error: DeclaredError): ErrorKind =>
  error._tag === 'Invalid' && error.reason !== undefined ? `Invalid.${error.reason}` : error._tag

/** The Invalid text of several field problems, each as "<field>: <message>"; MCP agents read the field names. */
export const fieldProblemsText = (problems: ReadonlyArray<{ readonly field: string; readonly message: string }>) =>
  problems.map((p) => `${p.field}: ${p.message}`).join('; ')

/** An Invalid text without the "<field>: " that fieldProblemsText puts before its first problem, for a form that marks the field itself. */
export const withoutField = (data: { message: string; field: string | undefined }) =>
  data.field !== undefined && data.message.startsWith(`${data.field}: `) ? data.message.slice(data.field.length + 2) : data.message

/** The JSON body of a refused request on a plain HTTP route (receipts, uploads, exports). */
export type HttpErrorBody = { readonly error: string }

/** The text a caller sees for a declared error. */
export function errorText(error: DeclaredError): string {
  switch (error._tag) {
    case 'Unauthorized':
      return 'Sign in required'
    case 'NotFound':
      return NOT_FOUND_MESSAGES[error.entity]
    case 'Conflict':
      return error.message ?? REVISION_CONFLICT
    default:
      return error.message
  }
}
