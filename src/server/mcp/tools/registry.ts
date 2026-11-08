// The MCP tool registry. Each area defines its tools in its own file in this
// folder with defineTool, and index.ts lists them. A tool maps its public
// input onto the shared domain services in src/server/; it never checks
// access itself (the services do) and never reads arguments as identity.
import { Result, Schema } from 'effect'
import { ERROR_ANSWERS, errorKind, errorText, MCP_INTERNAL } from '../../../shared/errors'
import type { McpToolName } from '../../../shared/mcp'
import type { Bucket } from '../../bucket'
import type { AfterCommit, CallError } from '../../calls'
import type { Db } from '../../core/db'
import type { McpPrincipal } from '../../auth/authenticate'

export type ToolContext = {
  readonly db: Db
  readonly principal: McpPrincipal
  readonly baseUrl: string
  /** The receipts bucket, for upload attachment. */
  readonly bucket: Bucket
  /** Work for after a write tool's transaction commits, such as removing deleted receipts from storage. */
  readonly afterCommit: AfterCommit
}

export type JsonSchema = { readonly [key: string]: JsonValue }
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** A tool as the server registers it. Generic types are erased by defineTool. */
export type McpTool = {
  readonly name: McpToolName
  readonly description: string
  /** Reads need agentsplit:read; writes also need agentsplit:write and run in one transaction. */
  readonly kind: 'read' | 'write'
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  /** Decodes raw arguments; fails with every issue, as text. */
  readonly decode: (args: unknown) => Result.Result<unknown, string>
  readonly run: (context: ToolContext, args: unknown) => Promise<object>
  /** The output schema, for tests that check every result against it. */
  readonly output: Schema.Top
}

/**
 * The error result body `{error: {code, message, outcomeUnknown, recovery}}`
 * of a failed call, from the error registry (src/shared/errors.ts). The
 * runner (calls.ts) has turned every failure into a declared error. Only an
 * unexpected failure of a write leaves its outcome unknown; an access denial
 * has a certain outcome (DECISIONS.md, P-MCP-41).
 */
export function errorBody(data: { error: CallError; kind: 'read' | 'write' }) {
  const { error } = data
  const { mcp: code, recovery, answer } = ERROR_ANSWERS[errorKind(error)]
  const outcomeUnknown = data.kind === 'write' && !answer
  return {
    error: {
      code,
      message: answer ? errorText(error) : MCP_INTERNAL,
      outcomeUnknown,
      // An unexpected failure of a read keeps the current app's correct_arguments (P-MCP-37); only a write's outcome can be unknown.
      recovery: answer || outcomeUnknown ? recovery : ('correct_arguments' as const),
    },
  }
}

// ---------- JSON Schema ----------

type Node = { [key: string]: JsonValue }

const isNode = (value: JsonValue | undefined): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Effect marks every object open; a strict object (the current app's z.strictObject) rejects unknown keys. */
function close(node: Node, path: string, strict: ReadonlySet<string>): Node {
  const out: Node = { ...node }
  if (node['type'] === 'object') {
    const extra = node['additionalProperties']
    if (strict.has(path)) out['additionalProperties'] = false
    // A record keeps the schema of its values; only the open-object marker goes.
    else if (isNode(extra)) out['additionalProperties'] = close(extra, `${path}[*]`, strict)
    else delete out['additionalProperties']
    const properties = node['properties']
    if (isNode(properties))
      out['properties'] = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, isNode(value) ? close(value, path ? `${path}.${key}` : key, strict) : value]),
      )
  }
  const items = node['items']
  if (isNode(items)) out['items'] = close(items, `${path}[]`, strict)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = node[key]
    if (Array.isArray(options)) out[key] = options.map((option) => (isNode(option) ? close(option, path, strict) : option))
  }
  return out
}

/** The draft 2020-12 JSON Schema of an Effect schema, with the given object paths closed. */
function jsonSchemaOf(data: { schema: Schema.Top; strict?: readonly string[] }): JsonSchema {
  const document = Schema.toJsonSchemaDocument(data.schema)
  if (Object.keys(document.definitions).length > 0) throw new Error('MCP schemas must not use shared definitions')
  const root = document.schema as Node
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...close(root, '', new Set(data.strict ?? [])) }
}

/** Rejects keys that a closed object of the JSON Schema does not list, before decoding drops them. */
function excessKeys(schema: JsonValue | undefined, value: unknown, path: string, found: string[]) {
  if (!isNode(schema)) return
  if (schema['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = isNode(schema['properties']) ? schema['properties'] : {}
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) {
        if (schema['additionalProperties'] === false) found.push(`Unrecognized key "${key}"${path ? ` at ${path}` : ''}`)
      } else excessKeys(properties[key], item, path ? `${path}.${key}` : key, found)
    }
  }
  if (Array.isArray(value)) value.forEach((item, index) => excessKeys(schema['items'], item, `${path}[${index}]`, found))
}

type ToolSpec<N extends McpToolName, I extends Schema.Top, O extends Schema.Top> = {
  readonly name: N
  readonly description: string
  readonly kind: 'read' | 'write'
  /** Writes are destructive unless they say otherwise; reads never are. */
  readonly destructive?: boolean
  /** Reads are idempotent; writes are not unless they say so. */
  readonly idempotent?: boolean
  readonly input: I
  /** Object paths that reject unknown keys, such as '' (the arguments) or 'expense'. */
  readonly strict: readonly string[]
  readonly output: O
  readonly run: (context: ToolContext, args: I['Type']) => Promise<O['Encoded'] & object>
}

/**
 * The JSON Schemas are built on first use, not at definition, so a server
 * start builds none of them and a tool call builds only that tool's input schema.
 */
export function defineTool<N extends McpToolName, I extends Schema.Top & Schema.ConstraintDecoder<unknown>, O extends Schema.Top>(spec: ToolSpec<N, I, O>): McpTool & { readonly name: N } {
  let input: JsonSchema | undefined
  let output: JsonSchema | undefined
  const inputSchema = () => (input ??= jsonSchemaOf({ schema: spec.input, strict: spec.strict }))
  const decoder = Schema.decodeUnknownResult(spec.input, { errors: 'all' })
  return {
    name: spec.name,
    description: spec.description,
    kind: spec.kind,
    destructive: spec.kind === 'write' && (spec.destructive ?? true),
    idempotent: spec.kind === 'read' || (spec.idempotent ?? false),
    get inputSchema() {
      return inputSchema()
    },
    get outputSchema() {
      return (output ??= jsonSchemaOf({ schema: spec.output }))
    },
    output: spec.output,
    decode: (args) => {
      const excess: string[] = []
      excessKeys(inputSchema(), args ?? {}, '', excess)
      if (excess.length) return Result.fail(excess.join('; '))
      const decoded = decoder(args ?? {})
      return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(decoded.failure.message)
    },
    // The SDK passes only values that decode succeeded on, so args has the decoded type.
    run: (context, args) => spec.run(context, args as I['Type']),
  }
}
