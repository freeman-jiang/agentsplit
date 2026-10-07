import { RecurrenceRule, SplitMode } from '@/generated/prisma/browser'
import { getCategories } from '@/lib/api'
import { getCurrency, supportedCurrencyCodes } from '@/lib/currency'
import { MAX_RECEIPT_BYTES } from '@/lib/expense-uploads'
import { getRuntimeFeatureFlags } from '@/lib/featureFlags'
import { baseProcedure, createTRPCRouter } from '@/trpc/init'
import { z } from 'zod'

export const referenceRouter = createTRPCRouter({
  get: baseProcedure.input(z.strictObject({})).query(async () => ({
    categories: await getCategories(),
    currencies: supportedCurrencyCodes.map((code) => {
      const currency = getCurrency(code)
      return {
        code,
        name: currency.name,
        symbol: currency.symbol,
        decimalPlaces: currency.decimal_digits,
      }
    }),
    splitModes: Object.values(SplitMode),
    recurrenceRules: Object.values(RecurrenceRule),
    attachments: {
      enabled: (await getRuntimeFeatureFlags()).enableExpenseDocuments,
      contentTypes: ['image/jpeg', 'image/png'],
      maxBytes: MAX_RECEIPT_BYTES,
    },
  })),
})
