import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { AgentSplitApi } from '../shared/api'

const makeClient = RpcClient.make(AgentSplitApi, { flatten: true })
class Api extends Context.Service<Api, Effect.Success<typeof makeClient>>()('agentsplit/ApiClient') {}

const runtime = ManagedRuntime.make(
  Layer.effect(Api)(makeClient).pipe(
    // Calls made in the same few milliseconds share one HTTP request: one round trip per screen.
    Layer.provide(RpcClient.layerProtocolHttp({ url: '/api/rpc', batch: { window: '5 millis' } })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  ),
)

export type ApiClient = Context.Service.Shape<typeof Api>

/** Runs calls on the typed client: `rpc((api) => api("groups.list", undefined))`. Typed errors reject with the error object. */
export function rpc<A, E>(work: (api: ApiClient) => Effect.Effect<A, E>): Promise<A> {
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* work(yield* Api)
    }),
  )
}
