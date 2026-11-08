// A JSON-RPC client of the MCP endpoint, in the 2025 (legacy) protocol that
// Claude Code and Codex send today. `send` delivers a request: the app in
// process for the database tests, the network for the end-to-end tests.
import { MCP_PATH } from '../../src/shared/mcp'

export const LEGACY = '2025-06-18'
/** The code failure() reports for the SDK's plain-text refusal, which is not one of the tools' own codes. */
export const SDK_INPUT_REFUSED = 'SDK_INPUT_REFUSED'

/** The OAuth scopes that the protected-resource metadata and every 401 challenge name, in order. */
export const OAUTH_SCOPES = ['agentsplit:read', 'agentsplit:write', 'offline_access'] as const
/** The WWW-Authenticate challenge of a 401 from the MCP endpoint at `baseUrl`. */
export const mcpChallenge = (baseUrl: string) =>
  `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}", scope="${OAUTH_SCOPES.join(' ')}"`

export type Reply = { status: number; headers: Headers; body: unknown }
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] }
export type ToolError = { code: string; message: string; outcomeUnknown: boolean; recovery: string }
export type Call = { name: string; args?: object; headers: Record<string, string> }

export function mcpClient(data: { baseUrl: string; send: (request: Request) => Promise<Response> }) {
  let nextId = 1
  const url = new URL(MCP_PATH, data.baseUrl).href

  async function rpc(call: { method: string; params?: object; headers?: Record<string, string> }): Promise<Reply> {
    const response = await data.send(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY, ...call.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: call.method, params: call.params ?? {} }),
      }),
    )
    const text = await response.text()
    // Legacy exchanges may answer as one SSE event.
    const json = text.match(/^data: (.*)$/m)?.[1] ?? text
    return { status: response.status, headers: response.headers, body: json ? (JSON.parse(json) as unknown) : null }
  }

  /** Calls a tool and returns its result, or the HTTP answer when the call never ran. */
  async function callTool(call: Call) {
    const reply = await rpc({ method: 'tools/call', params: { name: call.name, arguments: call.args ?? {} }, headers: call.headers })
    return { ...reply, result: (reply.body as { result?: ToolResult } | null)?.result }
  }

  /** The structured result of a successful call; throws with the answer otherwise. */
  async function ok(call: Call): Promise<Record<string, unknown>> {
    const reply = await callTool(call)
    if (reply.status !== 200 || !reply.result || reply.result.isError || !reply.result.structuredContent)
      throw new Error(`${call.name} failed: ${reply.status} ${JSON.stringify(reply.body)}`)
    return reply.result.structuredContent
  }

  /** The `{error}` body of a failed call; throws when the call did not fail. */
  async function failure(call: Call): Promise<ToolError> {
    const reply = await callTool(call)
    if (reply.status !== 200 || !reply.result?.isError) throw new Error(`${call.name} did not fail: ${reply.status} ${JSON.stringify(reply.body)}`)
    const text = reply.result.content[0]?.text ?? ''
    // The MCP SDK refuses arguments that do not match the advertised input schema with plain text, before the tool runs.
    if (!text.startsWith('{')) return { code: SDK_INPUT_REFUSED, message: text, outcomeUnknown: false, recovery: 'correct_arguments' }
    return (JSON.parse(text) as { error: ToolError }).error
  }

  return { url, rpc, callTool, ok, failure }
}
