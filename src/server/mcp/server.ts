// The MCP server for one request: a new instance per request, so the
// credentials and responses of concurrent callers never mix.
import { McpServer, type StandardSchemaWithJSON, type Tool } from '@modelcontextprotocol/server'
import { Result } from 'effect'
import type { Bucket } from '../bucket'
import type { McpPrincipal } from '../auth/authenticate'
import { assertOAuthWrite } from '../auth/oauth-connections'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from '../../shared/account'
import { answerOf, runRead, runWrite, type AfterCommit } from '../calls'
import type { Db } from '../core/db'
import { INSTRUCTIONS } from './tools/instructions'
import { errorBody, type McpTool } from './tools/registry'
import { MCP_TOOLS } from './tools'

const SERVER_INFO = { name: 'agentsplit', version: '0.4.0' } as const

const READ = [{ type: 'oauth2' as const, scopes: [OAUTH_READ_SCOPE] }]
const WRITE = [{ type: 'oauth2' as const, scopes: [OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE] }]

const annotations = (tool: McpTool) => ({
  readOnlyHint: tool.kind === 'read',
  destructiveHint: tool.destructive,
  idempotentHint: tool.idempotent,
  openWorldHint: false,
})

/**
 * What tools/list advertises, built once per process on the first tools/list.
 * OpenAI reads securitySchemes at the top level; `_meta` mirrors it for other clients.
 */
let advertised: Tool[] | undefined
const advertisedTools = (): Tool[] =>
  (advertised ??= MCP_TOOLS.map((tool) => {
    const securitySchemes = tool.kind === 'read' ? READ : WRITE
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      outputSchema: tool.outputSchema as Tool['outputSchema'],
      annotations: annotations(tool),
      securitySchemes,
      _meta: { securitySchemes },
    }
  }))

/** The SDK validates arguments through this; decoding happens once, here. */
const inputOf = (tool: McpTool): StandardSchemaWithJSON => ({
  '~standard': {
    version: 1,
    vendor: 'agentsplit',
    validate: (value) => {
      const decoded = tool.decode(value)
      return Result.isSuccess(decoded) ? { value: decoded.success } : { issues: [{ message: decoded.failure }] }
    },
    jsonSchema: { input: () => tool.inputSchema, output: () => tool.inputSchema },
  },
})

/**
 * Outputs are typed at compile time and checked against the output schemas in
 * tests (test/db/mcp-tools.test.ts), so the request path does not decode them
 * again: a 100-row list would cost CPU for no gain.
 */
const outputOf = (tool: McpTool): StandardSchemaWithJSON => ({
  '~standard': {
    version: 1,
    vendor: 'agentsplit',
    validate: (value) => ({ value }),
    jsonSchema: { input: () => tool.outputSchema, output: () => tool.outputSchema },
  },
})

/** Reads commit nothing, so they have no work for after a commit. */
const readOnly: AfterCommit = () => {
  throw new Error('Only a write tool can run work after its commit')
}

const REGISTERED = MCP_TOOLS.map((tool) => ({ tool, input: inputOf(tool), output: outputOf(tool) }))

/** What every tool call of the process shares: the app's URL for links, and the receipts bucket. */
export type McpSettings = { readonly baseUrl: string; readonly bucket: Bucket }

export function createServer(data: { db: Db; principal: McpPrincipal; settings: McpSettings }): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS })
  for (const { tool, input, output } of REGISTERED) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: input, outputSchema: output, annotations: annotations(tool) },
      async (args: unknown) => {
        const call = { name: `MCP tool ${tool.name}` }
        const context = { principal: data.principal, ...data.settings }
        try {
          const structuredContent = (await (tool.kind === 'write'
            ? runWrite({
                db: data.db,
                principal: data.principal,
                call,
                check: (tx) => assertOAuthWrite(tx, data.principal),
                work: (tx, afterCommit) => tool.run({ ...context, db: tx, afterCommit }, args),
              })
            : runRead({ db: data.db, call, work: (db) => tool.run({ ...context, db, afterCommit: readOnly }, args) }))) as Record<string, unknown>
          return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent }
        } catch (error) {
          const body = errorBody({ error: answerOf(error, call), kind: tool.kind })
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
        }
      },
    )
  }
  // The SDK has no option for top-level securitySchemes, so tools/list is served from advertisedTools.
  server.server.setRequestHandler('tools/list', () => ({ tools: advertisedTools() }))
  return server
}

/** Whether a tool call needs write scope; unknown tools are left to the SDK's error. */
export const isWriteTool = (name: string) => MCP_TOOLS.some((tool) => tool.name === name && tool.kind === 'write')
