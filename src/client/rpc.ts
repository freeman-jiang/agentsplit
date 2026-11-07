// A small fetch client for the server's Effect RPC endpoint. It speaks the same
// JSON protocol as Effect's RpcClient (RpcSerialization.layerJson over HTTP), and
// takes its types from the shared contract with type-only imports, so no Effect
// runtime ships to the browser: that keeps the signed-in shell within budget.
//
// This works because every schema in the contract is JSON-identical: its
// encoded form equals its decoded form (strings, numbers, booleans, arrays and
// structs; no Date or bigint transforms). The JsonIdentical check below makes
// the type checker refuse a contract change that breaks this.
import type { Schema } from 'effect'
import type { Rpc, RpcGroup } from 'effect/rpc'
import type { AgentSplitApi } from '../shared/api'
import { REQUEST_ID_RESPONSE_HEADER } from '../shared/ids'
import { RPC_PATH } from '../shared/paths'

type Rpcs = RpcGroup.Rpcs<typeof AgentSplitApi>
type Tag = Rpcs['_tag']
type ByTag<T extends Tag> = Extract<Rpcs, { readonly _tag: T }>
type PayloadOf<T extends Tag> = Rpc.Payload<ByTag<T>>
type SuccessOf<T extends Tag> = Rpc.Success<ByTag<T>>

// Branded types (DecimalString) are narrower than their encoded string but identical at runtime;
// a transform such as Date or bigint makes the decoded type unassignable to the encoded one.
type JsonIdentical<T extends Tag> = Rpc.Success<ByTag<T>> extends Rpc.SuccessEncoded<ByTag<T>> ? true : false
// A compile error here means a procedure's output has a transforming schema.
const _jsonIdentical: { [T in Tag]: JsonIdentical<T> } extends { [T in Tag]: true } ? true : never = true
void _jsonIdentical

/** An error that a procedure of the contract declares, as JSON. */
type DeclaredError = Schema.Codec.Encoded<Rpc.ErrorSchema<Rpcs>>

const DECLARED: Readonly<Record<DeclaredError['_tag'], true>> = { Unauthorized: true, Forbidden: true, NotFound: true, Conflict: true, Invalid: true, Unavailable: true }

/** A failure the server did not declare (a defect or a broken response), or no response at all. */
export class RpcFailure extends Error {
  readonly _tag = 'RpcFailure'
  /** The server's ID of the request, when a response came back. */
  readonly requestId: string | null
  constructor(message: string, requestId: string | null = null) {
    super(message)
    this.requestId = requestId
  }
}

/** What rpc() rejects with: a declared error with the server's ID of the request, or an RpcFailure. */
export type RpcError = (DeclaredError & { readonly requestId: string | null }) | RpcFailure

/** The RpcError a caught value is. rpc() rejects only with these; anything else becomes an RpcFailure. */
export function rpcError(cause: unknown): RpcError {
  if (cause instanceof RpcFailure) return cause
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string' && Object.hasOwn(DECLARED, cause._tag))
    return cause as RpcError
  return new RpcFailure(cause instanceof Error ? cause.message : 'The request failed')
}

/** The server's ID of the request that failed with `error`, or null if no response came back. */
export function requestIdOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('requestId' in error)) return null
  return typeof error.requestId === 'string' ? error.requestId : null
}

type Pending = { readonly id: string; readonly tag: Tag; readonly payload: unknown; resolve: (value: unknown) => void; reject: (error: RpcError) => void }
type ExitMessage = {
  readonly _tag: 'Exit'
  readonly requestId: string
  readonly exit:
    | { readonly _tag: 'Success'; readonly value: unknown }
    | { readonly _tag: 'Failure'; readonly cause: ReadonlyArray<{ readonly _tag: string; readonly error?: DeclaredError }> }
}

let nextId = 0
let queue: Pending[] = []
let timer: ReturnType<typeof setTimeout> | undefined

/** Calls made within the same 5 ms share one HTTP request: one round trip per screen. */
const BATCH_WINDOW_MS = 5

async function flush() {
  const batch = queue
  queue = []
  timer = undefined
  let requestId: string | null = null
  try {
    const response = await fetch(RPC_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(batch.map((p) => ({ _tag: 'Request', id: p.id, tag: p.tag, payload: p.payload, headers: [] }))),
    })
    requestId = response.headers.get(REQUEST_ID_RESPONSE_HEADER)
    if (!response.ok) throw new RpcFailure(`The server answered ${response.status}`, requestId)
    const messages = (await response.json()) as ExitMessage[]
    const byId = new Map(messages.filter((m) => m._tag === 'Exit').map((m) => [m.requestId, m.exit]))
    for (const p of batch) {
      const exit = byId.get(p.id)
      if (!exit) p.reject(new RpcFailure('The response ended before this call completed', requestId))
      else if (exit._tag === 'Success') p.resolve(exit.value)
      else {
        const failure = exit.cause.find((c) => c._tag === 'Fail')?.error
        p.reject(failure ? { ...failure, requestId } : new RpcFailure('The server failed unexpectedly', requestId))
      }
    }
  } catch (error) {
    for (const p of batch) p.reject(error instanceof RpcFailure ? error : new RpcFailure(error instanceof Error ? error.message : 'The request failed', requestId))
  }
}

function call<T extends Tag>(tag: T, payload: PayloadOf<T>): Promise<SuccessOf<T>> {
  return new Promise((resolve, reject: (error: RpcError) => void) => {
    queue.push({ id: String(++nextId), tag, payload: payload ?? null, resolve: resolve as (value: unknown) => void, reject })
    timer ??= setTimeout(flush, BATCH_WINDOW_MS)
  })
}

type ApiClient = typeof call

/** Runs calls on the typed client: `rpc((api) => api("groups.list", undefined))`. Rejects with an RpcError. */
export function rpc<A>(work: (api: ApiClient) => Promise<A>): Promise<A> {
  return work(call)
}

/** A fresh key for one write; a retry of the same request reuses it. */
export const newIdempotencyKey = () => crypto.randomUUID()
