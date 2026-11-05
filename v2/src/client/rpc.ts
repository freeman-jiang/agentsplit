// A small fetch client for the Worker's Effect RPC endpoint. It speaks the same
// JSON protocol as Effect's RpcClient (RpcSerialization.layerJson over HTTP), and
// takes its types from the shared contract with type-only imports, so no Effect
// runtime ships to the browser: that keeps the signed-in shell within budget.
//
// This works because every schema in the contract is JSON-identical: its
// encoded form equals its decoded form (strings, numbers, booleans, arrays and
// structs; no Date or bigint transforms). The JsonIdentical check below makes
// the type checker refuse a contract change that breaks this.
import type { Rpc, RpcGroup } from 'effect/rpc'
import type { AgentSplitApi } from '../shared/api'

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

/** A failure the server did not declare (a defect or a broken response). */
export class RpcFailure extends Error {
  readonly _tag = 'RpcFailure'
}

type Pending = { readonly id: string; readonly tag: Tag; readonly payload: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }
type ExitMessage = {
  readonly _tag: 'Exit'
  readonly requestId: string
  readonly exit: { readonly _tag: 'Success'; readonly value: unknown } | { readonly _tag: 'Failure'; readonly cause: ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }> }
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
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(batch.map((p) => ({ _tag: 'Request', id: p.id, tag: p.tag, payload: p.payload, headers: [] }))),
    })
    if (!response.ok) throw new RpcFailure(`The server answered ${response.status}`)
    const messages = (await response.json()) as ExitMessage[]
    const byId = new Map(messages.filter((m) => m._tag === 'Exit').map((m) => [m.requestId, m.exit]))
    for (const p of batch) {
      const exit = byId.get(p.id)
      if (!exit) p.reject(new RpcFailure('The response ended before this call completed'))
      else if (exit._tag === 'Success') p.resolve(exit.value)
      else {
        const failure = exit.cause.find((c) => c._tag === 'Fail')
        p.reject(failure ? failure.error : new RpcFailure('The server failed unexpectedly'))
      }
    }
  } catch (error) {
    for (const p of batch) p.reject(error instanceof RpcFailure ? error : new RpcFailure(error instanceof Error ? error.message : 'The request failed'))
  }
}

/** Calls one procedure; rejects with one of its typed errors or an RpcFailure. */
function call<T extends Tag>(tag: T, payload: PayloadOf<T>): Promise<SuccessOf<T>> {
  return new Promise((resolve, reject) => {
    queue.push({ id: String(++nextId), tag, payload: payload ?? null, resolve: resolve as (value: unknown) => void, reject })
    timer ??= setTimeout(flush, BATCH_WINDOW_MS)
  })
}

export type ApiClient = typeof call

/** Runs calls on the typed client: `rpc((api) => api("groups.list", undefined))`. */
export function rpc<A>(work: (api: ApiClient) => Promise<A>): Promise<A> {
  return work(call)
}
