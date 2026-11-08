// The MCP answers that are the same for every caller: initialize, tools/list
// and notifications/initialized. An agent session sends all three before its
// first tool call, and tools/list is about 90 KB of JSON. The SDK answers the
// first request with a given message; later requests with the same message and
// headers get the stored answer with their own JSON-RPC ID, and the gzip of
// its unchanging part is made once (compression.ts). The endpoint's checks
// (host, authentication, the rate limit, the protocol header) run before this.
import { accepts, gzipEligible, gzipWithTail } from '../compression'

/** The methods whose answer depends on the message and its headers only, never on the caller or the data. */
const STATIC_METHODS: ReadonlySet<string> = new Set(['initialize', 'tools/list', 'notifications/initialized'])

/** The request headers that the SDK reads. A different value is a different stored answer. */
const KEY_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name'] as const

/** At most this many stored answers: one per client version and protocol, so a caller cannot grow the store without limit. */
const MAX_ANSWERS = 64

type JsonRpcId = string | number

/** A stored answer. `head` is the body before the request's ID, and `tail` after it; a notification's body has no ID. */
type Stored = {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: { readonly head: Uint8Array; readonly tail: string } | { readonly whole: Uint8Array }
  readonly gzip: ((tail: Uint8Array) => Uint8Array<ArrayBuffer>) | null
}

const stored = new Map<string, Stored>()
const encoder = new TextEncoder()

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is JsonRpcId => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/** The store key of a POST body that may have a stored answer, or null. A batch never has one. */
function keyOf(request: Request, body: unknown): string | null {
  if (request.method !== 'POST' || !isObject(body) || typeof body['method'] !== 'string' || !STATIC_METHODS.has(body['method'])) return null
  const { id, ...message } = body
  // A request has an ID; a notification has none. Anything else is left to the SDK's own error.
  if (id !== undefined && !isId(id)) return null
  return JSON.stringify([KEY_HEADERS.map((name) => request.headers.get(name)), id === undefined, message])
}

/**
 * The JSON message of an answer and the text around it: a JSON body, or one
 * SSE event of one data line, as the SDK answers a 2025 (legacy) request.
 * Null for any other form.
 */
function framing(data: { contentType: string | null; text: string }): { before: string; json: string; after: string } | null {
  const type = data.contentType?.split(';')[0]?.trim()
  if (type === 'application/json') return { before: '', json: data.text, after: '' }
  const event = type === 'text/event-stream' ? data.text.match(/^(event: message\ndata: )([^\n]*)(\n\n)$/) : null
  return event?.[1] && event[2] && event[3] ? { before: event[1], json: event[2], after: event[3] } : null
}

/** The answer to store from the SDK's response, or null when it must not be stored (an error, or a form this module does not rebuild). */
async function toStored(data: { request: Request; response: Response; hasId: boolean }): Promise<{ stored: Stored | null; bytes: Uint8Array<ArrayBuffer> }> {
  const { response } = data
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers = [...response.headers].filter(([name]) => name !== 'content-length')
  if (!data.hasId) return { stored: response.status === 202 && bytes.length === 0 ? { status: 202, headers, body: { whole: bytes }, gzip: null } : null, bytes }
  if (response.status !== 200) return { stored: null, bytes }
  const framed = framing({ contentType: response.headers.get('content-type'), text: new TextDecoder().decode(bytes) })
  if (!framed) return { stored: null, bytes }
  const parsed: unknown = JSON.parse(framed.json)
  if (!isObject(parsed) || !isObject(parsed['result'])) return { stored: null, bytes }
  // The same members in the SDK's order, with the ID last, so that only the end of the body changes.
  const { id: _id, ...rest } = parsed
  const head = encoder.encode(`${framed.before}${JSON.stringify(rest).slice(0, -1)},"id":`)
  const tail = `}${framed.after}`
  const eligible = gzipEligible({ request: data.request, status: 200, headers: response.headers, byteLength: head.length + tail.length })
  return { stored: { status: 200, headers, body: { head, tail }, gzip: eligible ? gzipWithTail(head) : null }, bytes }
}

/** The response of a stored answer for this request: its own ID, gzipped when the client accepts gzip. */
function respond(data: { request: Request; answer: Stored; id: JsonRpcId | undefined }): Response {
  const { answer } = data
  const headers = new Headers(answer.headers.map(([name, value]) => [name, value]))
  if ('whole' in answer.body) return new Response(answer.body.whole.slice(), { status: answer.status, headers })
  const { head, tail } = answer.body
  const idAndTail = encoder.encode(`${JSON.stringify(data.id)}${tail}`)
  // A plain body gets its Vary header where every buffered answer gets it (compressed() in compression.ts).
  if (answer.gzip && accepts(data.request.headers.get('accept-encoding') ?? '', 'gzip')) {
    headers.append('Vary', 'Accept-Encoding')
    headers.set('Content-Encoding', 'gzip')
    return new Response(answer.gzip(idAndTail), { status: answer.status, headers })
  }
  const body = new Uint8Array(head.length + idAndTail.length)
  body.set(head, 0)
  body.set(idAndTail, head.length)
  return new Response(body, { status: answer.status, headers })
}

/**
 * The answer to `body` from the store, or from `serve` (the SDK) when the
 * store has none yet. Requests that never have a stored answer go to `serve`.
 */
export async function staticAnswer(data: { request: Request; body: unknown; serve: () => Promise<Response> }): Promise<Response> {
  const key = keyOf(data.request, data.body)
  if (key === null) return data.serve()
  const id = isObject(data.body) && isId(data.body['id']) ? data.body['id'] : undefined
  const found = stored.get(key)
  if (found) return respond({ request: data.request, answer: found, id })
  const response = await data.serve()
  const { stored: answer, bytes } = await toStored({ request: data.request, response, hasId: id !== undefined })
  if (answer && stored.size < MAX_ANSWERS) stored.set(key, answer)
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
}
