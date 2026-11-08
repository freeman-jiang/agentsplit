// The one text for a failed call. Declared errors read as src/shared/errors.ts
// words them for every transport; a revision conflict never looks like any
// other failure (DECISIONS.md group C, P-EXP-52 and P-EXP-53).
import { errorText } from '~/shared/errors'
import { RpcFailure, rpcError } from './rpc'

export type Failure = {
  /** `conflict`: someone saved first; `refused`: the server answered no; `unknown`: no answer, so a write may or may not have happened. */
  readonly kind: 'conflict' | 'refused' | 'unknown'
  readonly message: string
}

const CONFLICT = 'Someone changed this after you opened it. Load the latest version, then make your change again.'
const NO_ANSWER = 'The server did not answer. Try again.'

/**
 * What to show for a failed call. A Better Auth error or a local Error keeps
 * its message; a call without an answer shows `unanswered`, such as a write's
 * promise that a retry is safe.
 */
export function describeError(cause: unknown, unanswered: string = NO_ANSWER): Failure {
  const isOther = !(cause instanceof RpcFailure) && typeof cause === 'object' && cause !== null && !('_tag' in cause) && 'message' in cause
  if (isOther) return { kind: 'unknown', message: typeof cause.message === 'string' && cause.message ? cause.message : unanswered }
  const error = rpcError(cause)
  switch (error._tag) {
    case 'Conflict':
      // A revision conflict arrives with an empty message (errorText in src/shared/errors.ts).
      return { kind: 'conflict', message: error.message || CONFLICT }
    case 'NotFound':
    case 'Invalid':
    case 'Forbidden':
    case 'Unauthorized':
      return { kind: 'refused', message: errorText(error) }
    case 'Unavailable':
    case 'RpcFailure':
      return { kind: 'unknown', message: unanswered }
  }
}
