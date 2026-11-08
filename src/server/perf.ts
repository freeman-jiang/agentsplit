// Per-request counts of database work for performance runs, as the current
// app reports them (P-PWA-49). Only PERF_INSTRUMENTATION turns this on:
// otherwise no connection is wrapped and no response gets the headers.
import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'

export type PerfCounters = {
  /** SQL statements sent, Better Auth's included. */
  queries: number
  /** Milliseconds until those statements answered. */
  dbMs: number
}

const scope = new AsyncLocalStorage<PerfCounters>()

/** Runs `work` with `counters` in scope. Every statement that it awaits counts into them. */
export const withPerfCounters = <A>(counters: PerfCounters, work: () => Promise<A>): Promise<A> => scope.run(counters, work)

/**
 * Counts each statement of `client` into the request in scope. Call it once
 * for each new connection (instrumentPool).
 */
function countQueries(client: pg.PoolClient): void {
  // pg's overloads cannot be named in one signature; arguments and results pass through unchanged.
  type Query = (...args: unknown[]) => unknown
  const query = client.query.bind(client) as Query
  const counted: Query = (...args) => {
    const counters = scope.getStore()
    if (!counters) return query(...args)
    counters.queries += 1
    const start = performance.now()
    const done = () => void (counters.dbMs += performance.now() - start)
    // pool.query (Better Auth) passes a callback; Drizzle on a connection uses the promise.
    const callback = args.at(-1)
    if (typeof callback === 'function')
      return query(...args.slice(0, -1), (...result: unknown[]) => {
        done()
        return Reflect.apply(callback, undefined, result)
      })
    const result = query(...args)
    return result instanceof Promise ? result.finally(done) : result
  }
  client.query = counted as typeof client.query
}

/** Counts the statements of every connection that `pool` opens from now on. */
export const instrumentPool = (pool: pg.Pool) => void pool.on('connect', countQueries)

/** The response of `work`, with the statements and database time it took in the current app's headers. */
export async function withPerfHeaders(work: () => Promise<Response>): Promise<Response> {
  const counters: PerfCounters = { queries: 0, dbMs: 0 }
  const response = await withPerfCounters(counters, work)
  const copy = new Response(response.body, response)
  copy.headers.set('x-perf-db-queries', String(counters.queries))
  copy.headers.set('server-timing', `db;dur=${counters.dbMs.toFixed(1)}`)
  return copy
}
