import { appRouter } from '@/trpc/routers/_app'
import {
  McpServer,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import { callTRPCProcedure, TRPCError, type AnyTRPCRouter } from '@trpc/server'
import * as z from 'zod'
import { assertGroupAccess, type McpPrincipal } from './access'
import { MCP_TOOL_REGISTRY } from './registry'

/**
 * Advertise the existing parser without applying its transforms twice.
 * tRPC remains responsible for validation when dispatching the procedure.
 */
function advertiseInput(parser: unknown): StandardSchemaWithJSON {
  const schema =
    parser === undefined
      ? { type: 'object' as const, properties: {} }
      : parser instanceof z.ZodType
        ? z.toJSONSchema(parser, { io: 'input', unrepresentable: 'any' })
        : undefined
  if (!schema || schema.type !== 'object') {
    throw new Error('MCP tool inputs must have an object schema')
  }
  return {
    '~standard': {
      version: 1,
      vendor: 'agentsplit',
      validate: (value) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  }
}

/** New instance for each request, so credentials/response streams are isolated. */
export function createAgentSplitMcpServer(principal: McpPrincipal) {
  const server = new McpServer(
    { name: 'agentsplit', version: '0.1.0' },
    {
      instructions:
        "Read-only AgentSplit access. Call list_groups to discover the authenticated user's groups; each agent key inherits that user's access. Amounts are currency minor units. Page expenses and activity until hasMore is false. Never claim a write succeeded: this endpoint has no write tools.",
    },
  )

  for (const definition of MCP_TOOL_REGISTRY) {
    const router: AnyTRPCRouter = appRouter
    const procedure = router._def.procedures[definition.procedure]
    if (!procedure || procedure._def.type !== 'query') {
      throw new Error(`MCP registry must map a query: ${definition.name}`)
    }
    if (procedure._def.inputs.length > 1) {
      throw new Error(
        `Chained MCP input schemas need review: ${definition.name}`,
      )
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: advertiseInput(procedure._def.inputs[0]),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args, context) => {
        try {
          assertGroupAccess(definition.procedure, args, principal)
          const output: unknown = await callTRPCProcedure({
            router: appRouter,
            path: definition.procedure,
            type: 'query',
            ctx: {
              readOnly: true,
              principal: {
                userId: principal.userId,
                connectionId: principal.id,
                groupIds: principal.groupIds,
              },
            },
            getRawInput: async () => args,
            signal: context.mcpReq.signal,
            batchIndex: 0,
          })
          const text = JSON.stringify(output ?? null)
          const structuredContent = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(text))
          return { content: [{ type: 'text', text }], structuredContent }
        } catch (error) {
          // Never expose database/connection errors or private configuration.
          const text =
            error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR'
              ? error.message
              : error instanceof Error &&
                  error.message ===
                    'This connection cannot access the requested group'
                ? error.message
                : 'Unable to complete this read. Check the arguments and retry.'
          return { isError: true, content: [{ type: 'text', text }] }
        }
      },
    )
  }
  return server
}
