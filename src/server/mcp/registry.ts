// The MCP tool registry. Each area defines its tools in its own file under
// tools/ with defineTool, and adds the list to tools/index.ts. A tool maps its
// public input onto the shared domain services in src/server/; it never
// checks access itself (the services do) and never reads arguments as identity.
import { Result, Schema } from 'effect'
import { Conflict, Forbidden, GROUP_ACCESS_DENIED, Invalid, NotFound } from '../../shared/api'
import type { Bucket } from '../bucket'
import type { Db } from '../db'
import { GROUP_DENIED } from '../security'
import type { McpPrincipal } from './authenticate'

export type ToolContext = {
  readonly db: Db
  readonly principal: McpPrincipal
  readonly baseUrl: string
  /** The receipts bucket, for upload attachment. */
  readonly bucket: Bucket
  /** ENABLE_EXPENSE_DOCUMENTS: whether agents may upload receipts. */
  readonly documentsEnabled: boolean
}

export type JsonSchema = { readonly [key: string]: JsonValue }
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** A tool as the server registers it. Generic types are erased by defineTool. */
export type McpTool = {
  readonly name: string
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
 * An expected tool failure with the current app's tRPC code. Domain errors
 * (Forbidden, NotFound, Conflict, Invalid) map onto these codes too.
 */
export class ToolError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
  }
}

const INTERNAL_MESSAGE = 'Unable to complete this operation. Check the arguments; for an uncertain write, read its record before retrying.'

/** The current app's texts for what a service did not find, by NotFound entity. */
const NOT_FOUND: Readonly<Record<string, string>> = {
  expense: 'Expense not found',
  'history boundary in this group': 'History boundary not found in this group',
  'saved expense revision at this point': 'Expense revision not found at this point',
  'group at this time': 'The group did not exist at this time',
}

/**
 * The error result body `{error: {code, message, outcomeUnknown, recovery}}`.
 * Only an unexpected failure of a write leaves its outcome unknown. An access
 * denial has a certain outcome (DECISIONS.md, P-MCP-41).
 */
export function errorBody(data: { error: unknown; kind: 'read' | 'write' }) {
  const { error } = data
  const [code, message]: [string, string] =
    error instanceof ToolError
      ? [error.code, error.message]
      : error instanceof Forbidden
        ? ['FORBIDDEN', error.message === GROUP_ACCESS_DENIED ? GROUP_DENIED : error.message]
        : error instanceof NotFound
          ? ['NOT_FOUND', NOT_FOUND[error.entity] ?? 'Group not found.']
          : error instanceof Conflict
            ? ['CONFLICT', 'The record changed. Read its current revision and retry your intended changes.']
            : error instanceof Invalid
              ? [error.reason === 'state' ? 'CONFLICT' : 'BAD_REQUEST', error.message]
              : ['INTERNAL_SERVER_ERROR', INTERNAL_MESSAGE]
  const outcomeUnknown = data.kind === 'write' && code === 'INTERNAL_SERVER_ERROR'
  return {
    error: {
      code,
      message,
      outcomeUnknown,
      recovery: code === 'CONFLICT' ? 'read_current_revision' : outcomeUnknown ? 'read_before_retry' : 'correct_arguments',
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
export function jsonSchemaOf(data: { schema: Schema.Top; strict?: readonly string[] }): JsonSchema {
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

type ToolSpec<I extends Schema.Top, O extends Schema.Top> = {
  readonly name: string
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
export function defineTool<I extends Schema.Top & Schema.ConstraintDecoder<unknown>, O extends Schema.Top>(spec: ToolSpec<I, O>): McpTool {
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
