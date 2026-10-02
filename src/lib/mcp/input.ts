import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { TRPCError } from '@trpc/server'
import * as z from 'zod'
import type { ToolDefinition } from './registry'

/** Public names are declared in the registry; the existing procedure owns validation. */
export function toolInput(
  parser: unknown,
  definition: ToolDefinition,
  mutation: boolean,
): {
  schema: StandardSchemaWithJSON
  map: (value: unknown) => Record<string, unknown>
} {
  if (!(parser instanceof z.ZodObject)) {
    if (parser === undefined)
      return {
        schema: z.strictObject({}),
        map: (value: unknown) => z.strictObject({}).parse(value),
      }
    throw new Error('MCP inputs must be object schemas')
  }
  const aliases = definition.inputAliases ?? {}
  const reverse = Object.fromEntries(
    Object.entries(aliases).map(([publicName, internal]) => [
      internal,
      publicName,
    ]),
  )
  const shape: Record<string, z.ZodType> = {}
  for (const [internal, raw] of Object.entries(parser.shape)) {
    if (
      mutation &&
      internal === 'participantId' &&
      definition.procedure !== 'groups.access'
    )
      continue
    let field = raw as z.ZodType
    if (internal === 'expenseFormValues') {
      const defaulted = field instanceof z.ZodDefault
      const object =
        field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field
      if (object instanceof z.ZodObject) {
        const publicFields = { ...object.shape }
        for (const name of [
          'saveDefaultSplittingOptions',
          'originalAmount',
          'originalCurrency',
          'conversionRate',
        ])
          delete publicFields[name]
        field = z.strictObject(publicFields)
        if (defaulted) field = field.default({})
      }
    }
    const name = reverse[internal] ?? internal
    shape[name] =
      (definition.required ?? []).includes(name) &&
      field instanceof z.ZodOptional
        ? (field.unwrap() as z.ZodType)
        : field
  }
  const publicSchema = z.strictObject(shape)
  const map = (value: unknown): Record<string, unknown> => {
    const parsed = publicSchema.safeParse(value)
    if (!parsed.success)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: parsed.error.message,
      })
    // Keep original values: tRPC applies its transforms once when dispatching.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        aliases[key] ?? key,
        item,
      ]),
    )
  }
  const jsonSchema = z.toJSONSchema(publicSchema, {
    io: 'input',
    unrepresentable: 'any',
  })
  const schema: StandardSchemaWithJSON = {
    '~standard': {
      version: 1,
      vendor: 'agentsplit',
      validate: (value) => {
        try {
          const mapped = map(value)
          const checked = parser.safeParse(mapped)
          return checked.success ? { value } : { issues: checked.error.issues }
        } catch (error) {
          return {
            issues: [
              {
                message:
                  error instanceof Error ? error.message : 'Invalid arguments',
              },
            ],
          }
        }
      },
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }
  return { schema, map }
}
