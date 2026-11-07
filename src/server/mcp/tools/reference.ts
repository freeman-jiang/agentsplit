// Reference data: get_reference_data, with the current app's output
// (src/trpc/routers/reference.ts), from getReference in src/server/expenses.ts.
import { Schema } from 'effect'
import * as expenses from '../../expenses'
import { defineTool } from '../registry'
import { CurrencyCodeInput, MODE_NAMES, NoArguments, NonNegativeInt, RecurrenceInput, RULE_NAMES, SplitModeInput } from './shared'

export const getReferenceData = defineTool({
  name: 'get_reference_data',
  kind: 'read',
  description:
    'Discover category IDs, supported currencies and decimal precision, split modes, recurrence rules, whether receipt uploads are enabled with their MIME/size limits, and the fair-use limits: receipt storage per uploader, receipts per request, groups you can create, people per group, API keys, writes per minute, and OAuth client registrations per IP per hour.',
  input: NoArguments,
  strict: [''],
  output: Schema.Struct({
    categories: Schema.Array(Schema.Struct({ id: Schema.Int, name: Schema.String, grouping: Schema.String })),
    currencies: Schema.Array(Schema.Struct({ code: CurrencyCodeInput, name: Schema.String, symbol: Schema.String, decimalPlaces: NonNegativeInt })),
    splitModes: Schema.Array(SplitModeInput),
    recurrenceRules: Schema.Array(RecurrenceInput),
    attachments: Schema.Struct({ enabled: Schema.Boolean, contentTypes: Schema.Array(Schema.String), maxBytes: Schema.Int }),
    limits: Schema.Struct({
      receiptStorageBytes: NonNegativeInt.annotate({ description: 'Receipt storage per uploader, in bytes; see get_storage_usage.' }),
      receiptBytes: NonNegativeInt,
      receiptsPerRequest: NonNegativeInt,
      groupsCreated: NonNegativeInt,
      participantsPerGroup: NonNegativeInt,
      apiKeys: NonNegativeInt,
      writesPerMinute: NonNegativeInt,
      clientRegistrationsPerHour: NonNegativeInt,
      fairUse: Schema.String,
    }),
  }),
  run: async ({ db }) => {
    const reference = await expenses.getReference(db)
    return {
      categories: reference.categories.map((c) => ({ id: c.id, name: c.name, grouping: c.grouping })),
      currencies: reference.currencies.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, decimalPlaces: c.decimals })),
      splitModes: reference.splitModes.map((m) => MODE_NAMES[m]),
      recurrenceRules: reference.recurrence.map((r) => RULE_NAMES[r]),
      attachments: { enabled: reference.attachments.enabled, contentTypes: [...reference.attachments.contentTypes], maxBytes: reference.attachments.maxBytes },
      limits: reference.limits,
    }
  },
})

export const referenceTools = [getReferenceData]
