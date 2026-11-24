// The whole body of a request, read before any other work. A route that takes
// a database connection first holds it for as long as the client takes to send
// the body: five slow POSTs to /api/rpc held the whole pool, and every page
// answered 503. The body is then bytes in memory, not a stream of the socket:
// Bun 1.4.4 never frees a socket's stream that Better Auth copies and leaves
// unread.
import { jsonError } from './errors'

/** How long a client may take to send a body. */
const BODY_MS = 15_000
/** Each body may hold this much outside the budget, so a flood of large bodies refuses no ordinary call. */
const FREE_BYTES = 64 * 1024
/** What all bodies together may hold above FREE_BYTES. The server has 320 MB for everything (nix/host/default.nix). */
const BUDGET_BYTES = 32 * 1024 * 1024
let budgetUsed = 0

/**
 * `request` with its body in memory, or the refusal to send: 413 for more than
 * `maxBytes`, 408 for a body that is not complete after `timeoutMs`, 400 for
 * one that the client broke off, and 503 when large bodies of other requests
 * fill the budget. A request without a body comes back as it is.
 */
export async function withWholeBody(request: Request, data: { maxBytes: number; timeoutMs?: number }): Promise<Request | Response> {
  const { maxBytes } = data
  if (!request.body) return request
  const tooLarge = () => jsonError({ status: 413, message: 'Request body is too large', headers: { Connection: 'close' } })
  if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge()
  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), data.timeoutMs ?? BODY_MS)
  })
  const chunks: Uint8Array[] = []
  let size = 0
  let budgeted = 0
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late])
      if (next === 'late') {
        void reader.cancel().catch(() => undefined)
        return jsonError({ status: 408, message: 'The request body took too long', headers: { Connection: 'close' } })
      }
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined)
        return tooLarge()
      }
      const more = Math.max(0, size - FREE_BYTES) - budgeted
      if (budgetUsed + more > BUDGET_BYTES) {
        void reader.cancel().catch(() => undefined)
        return jsonError({ status: 503, message: 'AgentSplit is busy. Try again in a moment.', headers: { Connection: 'close', 'Retry-After': '5' } })
      }
      budgetUsed += more
      budgeted += more
      chunks.push(next.value)
    }
  } catch {
    return jsonError({ status: 400, message: 'The request body is incomplete', headers: { Connection: 'close' } })
  } finally {
    clearTimeout(timer)
    budgetUsed -= budgeted
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body })
}
