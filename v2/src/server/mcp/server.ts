// The MCP server for one request: a new instance per request, so the
// credentials and responses of concurrent callers never mix.
import { McpServer, type StandardSchemaWithJSON, type Tool } from '@modelcontextprotocol/server'
import { Result } from 'effect'
import type { Db } from '../db'
import { assertOAuthWrite, type McpPrincipal } from './authenticate'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from './constants'
import { INSTRUCTIONS } from './instructions'
import { errorBody, type McpTool } from './registry'
import { MCP_TOOLS } from './tools'

export const SERVER_INFO = { name: 'agentsplit', version: '0.4.0' } as const

const READ = [{ type: 'oauth2' as const, scopes: [OAUTH_READ_SCOPE] }]
const WRITE = [{ type: 'oauth2' as const, scopes: [OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE] }]

const annotations = (tool: McpTool) => ({
  readOnlyHint: tool.kind === 'read',
  destructiveHint: tool.destructive,
  idempotentHint: tool.idempotent,
  openWorldHint: false,
})

/**
 * What tools/list advertises, built once per isolate on the first tools/list.
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

const SCHEMAS = new Map(MCP_TOOLS.map((tool) => [tool.name, { input: inputOf(tool), output: outputOf(tool) }]))

/** Serialization failures and deadlocks retry, as the RPC path's transaction helper does. */
const RETRYABLE = new Set(['40001', '40P01'])
async function serializable<A>(db: Db, work: (tx: Db) => Promise<A>): Promise<A> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work, { isolationLevel: 'serializable' })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (attempt >= 4 || !RETRYABLE.has(code)) throw error
    }
  }
}

export function createServer(data: { db: Db; principal: McpPrincipal; baseUrl: string }): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS })
  for (const tool of MCP_TOOLS) {
    const schemas = SCHEMAS.get(tool.name)
    if (!schemas) throw new Error(`No schemas for ${tool.name}`)
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: schemas.input, outputSchema: schemas.output, annotations: annotations(tool) },
      async (args: unknown) => {
        try {
          const run = (db: Db) => tool.run({ db, principal: data.principal, baseUrl: data.baseUrl }, args)
          const write = async (tx: Db) => {
            await assertOAuthWrite(tx, data.principal)
            return run(tx)
          }
          const structuredContent = (tool.kind === 'write' ? await serializable(data.db, write) : await run(data.db)) as Record<string, unknown>
          return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent }
        } catch (error) {
          const body = errorBody({ error, kind: tool.kind })
          // Never return database, storage or configuration details; log them instead.
          if (body.error.code === 'INTERNAL_SERVER_ERROR') console.error(`MCP tool ${tool.name} failed`, error)
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
