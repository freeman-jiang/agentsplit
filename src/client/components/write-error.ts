// One wording for failed writes, so a revision conflict never looks like any
// other failure (DECISIONS.md group C, P-EXP-52 and P-EXP-53).

export type WriteFailure = { readonly kind: 'conflict' | 'gone' | 'invalid' | 'unknown'; readonly message: string; readonly field?: string }

/** A rejected rpc() call: a typed domain error, or a transport failure. Caught values are untyped, so this narrows them. */
export function describeWriteError(error: unknown): WriteFailure {
  const tagged = typeof error === 'object' && error !== null && '_tag' in error ? (error as { _tag: string; message?: string; field?: string }) : null
  switch (tagged?._tag) {
    case 'Conflict':
      return { kind: 'conflict', message: 'Someone changed this after you opened it. Load the latest version, then make your change again.' }
    case 'NotFound':
      return { kind: 'gone', message: 'This entry was deleted, or you can no longer see it.' }
    case 'Invalid':
      return { kind: 'invalid', message: (tagged.message ?? 'The server refused this change.').replace(/^[\w.]+: /, ''), ...(tagged.field ? { field: tagged.field } : {}) }
    case 'Forbidden':
      return { kind: 'invalid', message: tagged.message ?? 'You cannot change this group.' }
    case 'Unauthorized':
      return { kind: 'invalid', message: 'Your session ended. Sign in again, then retry.' }
    default:
      // Unavailable, or no response: the write may or may not have happened. Retrying sends the same idempotency key.
      return { kind: 'unknown', message: 'The server did not confirm the change. Try again: a retry cannot save it twice.' }
  }
}
