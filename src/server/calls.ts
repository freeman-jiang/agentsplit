// The one way a request runs domain work, for RPC (rpc.ts) and MCP
// (mcp/server.ts) alike: reads on the request's connection, writes in one
// SERIALIZABLE transaction after the fair-use budget, and every failure turned
// into a declared answer. The cause of a failure that is not an answer is
// logged here and never sent.
import { Conflict, Invalid, Unavailable } from '../shared/api'
import { BUSY, UNAVAILABLE } from '../shared/errors'
import { tooManyWritesMessage } from '../shared/limits'
import type { Principal } from './core/access'
import { retryable, serializable, sqlState, type Db } from './core/db'
import { isDomainError, type DomainError } from './core/errors'
import { takeWrite } from './rate-limit'

/** What a call fails with: a domain error, or Unavailable for everything else. */
export type CallError = DomainError | Unavailable

/** Queues work for after the write commits, on the request's connection. A failure is logged. */
export type AfterCommit = (work: (db: Db) => Promise<unknown>) => void

/** Names a call in the log: the procedure or tool, and the request ID when the transport has one. */
export type CallName = { readonly name: string; readonly requestId?: string | undefined }

/**
 * What the database refused in the request: a CHECK or invariant trigger
 * (23514), a missing referenced row (23503), a taken unique key (23505), or a
 * date or time that it cannot read, such as February 30 (22007, 22008). These
 * answer the request, so they are not outages; the text names no table.
 */
const REFUSALS: Readonly<Record<string, () => Invalid>> = {
  '23514': () => new Invalid({ message: 'The change breaks a rule of the ledger. Check the amounts, the splits and the other fields.' }),
  '23503': () => new Invalid({ message: 'The change names a record that does not exist.' }),
  '23505': () => new Invalid({ message: 'A record with this ID or name already exists. Read it before retrying.', reason: 'state' }),
  '22007': () => new Invalid({ message: 'A date or time in the request is not valid.' }),
  '22008': () => new Invalid({ message: 'A date or time in the request does not exist.' }),
}

/** The answer for a thrown value. Anything that is not an answer is logged with `call` and becomes Unavailable. */
export function answerOf(error: unknown, call: CallName): CallError {
  if (isDomainError(error) || error instanceof Unavailable) return error
  const refused = REFUSALS[sqlState(error) ?? '']
  if (refused) {
    console.warn(`${call.name}: the database refused the request`, { requestId: call.requestId }, error)
    return refused()
  }
  // serializable (core/db.ts) used all its attempts: the write rolled back, so the caller can send it again.
  if (retryable(error)) {
    console.warn(`${call.name}: concurrent writes conflicted on every attempt`, { requestId: call.requestId }, error)
    return new Invalid({ message: BUSY, reason: 'busy' })
  }
  console.error(`${call.name} failed`, { requestId: call.requestId }, error)
  return new Unavailable({ message: UNAVAILABLE })
}

/** What a read fails with: reads never check revisions, so a Conflict there is a bug and answers as Unavailable. */
export type ReadError = Exclude<CallError, Conflict>

export function readAnswerOf(error: unknown, call: CallName): ReadError {
  const answer = answerOf(error, call)
  if (!(answer instanceof Conflict)) return answer
  console.error(`${call.name}: unexpected conflict on a read`, { requestId: call.requestId }, answer)
  return new Unavailable({ message: UNAVAILABLE })
}

/** Runs a read on `db`. */
export async function runRead<A>(data: { db: Db; call: CallName; work: (db: Db) => Promise<A> }): Promise<A> {
  try {
    return await data.work(data.db)
  } catch (error) {
    throw readAnswerOf(error, data.call)
  }
}

/**
 * Runs a write: first one write from the caller's fair-use budget, outside the
 * transaction, so a refused or rolled-back write still counts and concurrent
 * writes do not conflict on the bucket row; then `check` and `work` in one
 * SERIALIZABLE transaction, retried on serialization failures. A retry starts
 * the after-commit list again; the list runs once the transaction commits.
 */
export async function runWrite<A>(data: {
  db: Db
  principal: Principal
  call: CallName
  /** A check inside the transaction before the work, such as a live OAuth connection. */
  check?: (tx: Db) => Promise<void>
  work: (tx: Db, afterCommit: AfterCommit) => Promise<A>
}): Promise<A> {
  const after: ((db: Db) => Promise<unknown>)[] = []
  let result: A
  try {
    const wait = await takeWrite(data.db, { userId: data.principal.userId })
    if (wait > 0) throw new Invalid({ message: tooManyWritesMessage(wait), reason: 'rate' })
    result = await serializable(data.db, async (tx) => {
      after.length = 0
      await data.check?.(tx)
      return data.work(tx, (work) => void after.push(work))
    })
  } catch (error) {
    throw answerOf(error, data.call)
  }
  for (const work of after)
    await work(data.db).catch((error: unknown) => console.error(`${data.call.name}: work after the commit failed`, { requestId: data.call.requestId }, error))
  return result
}
