// Reference data: get_reference_data, with the current app's output
// (src/trpc/routers/reference.ts), from getReference in src/server/expenses.ts.
import { Record, Schema } from 'effect'
import { FAIR_USE_LIMITS } from '../../../shared/limits'
import { CurrencyCodeSchema } from '../../../shared/money'
import { RECEIPT_CONTENT_TYPES, RECURRENCE_NAMES, SPLIT_MODE_NAMES } from '../../../shared/vocabulary'
import * as expenses from '../../expenses'
import { defineTool } from '../registry'
import { NoArguments } from './inputs'
import { NonNegativeInt, RecurrenceName, SplitModeName } from './wire'

export const getReferenceData = defineTool({
  name: 'get_reference_data',
  kind: 'read',
  description:
    'Discover category IDs, supported currencies and decimal precision, split modes, recurrence rules, whether receipt uploads are enabled with their MIME/size limits, and the fair-use limits: receipt storage per uploader, receipts per request, groups you can create, people per group, API keys, writes per minute, and OAuth client registrations per IP per hour.',
  input: NoArguments,
  strict: [''],
  output: Schema.Struct({
    categories: Schema.Array(Schema.Struct({ id: Schema.Int, name: Schema.String, grouping: Schema.String })),
    currencies: Schema.Array(Schema.Struct({ code: CurrencyCodeSchema, name: Schema.String, symbol: Schema.String, decimalPlaces: NonNegativeInt })),
    splitModes: Schema.Array(SplitModeName),
    recurrenceRules: Schema.Array(RecurrenceName),
    attachments: Schema.Struct({ enabled: Schema.Boolean, contentTypes: Schema.Array(Schema.Literals(RECEIPT_CONTENT_TYPES)), maxBytes: Schema.Int }),
    limits: Schema.Struct({
      ...Record.map(FAIR_USE_LIMITS, () => NonNegativeInt),
      receiptStorageBytes: NonNegativeInt.annotate({ description: 'Receipt storage per uploader, in bytes; see get_storage_usage.' }),
      fairUse: Schema.String,
    }),
  }),
  run: async ({ db }) => {
    const reference = await expenses.getReference(db)
    return {
      categories: reference.categories.map((c) => ({ id: c.id, name: c.name, grouping: c.grouping })),
      currencies: reference.currencies.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, decimalPlaces: c.decimals })),
      splitModes: reference.splitModes.map((m) => SPLIT_MODE_NAMES[m]),
      recurrenceRules: reference.recurrence.map((r) => RECURRENCE_NAMES[r]),
      attachments: { enabled: reference.attachments.enabled, contentTypes: [...reference.attachments.contentTypes], maxBytes: reference.attachments.maxBytes },
      limits: reference.limits,
    }
  },
})

