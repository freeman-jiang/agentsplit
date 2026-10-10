import { z } from 'zod'
import { expenseCurrencySchema } from './currency'

export const expenseFeedInput = z
  .object({
    cursor: z
      .object({
        date: z.iso.datetime(),
        createdAt: z.iso.datetime(),
        id: z.string(),
      })
      .nullish(),
    limit: z.number().int().min(1).max(100).default(30),
    scope: z.enum(['all', 'grouped', 'ungrouped']).default('all'),
    groupId: z.string().min(1).optional(),
    filter: z.string().trim().max(200).optional(),
    involvingMe: z.boolean().default(false),
    personId: z.string().min(1).optional(),
    paidByUserId: z.string().min(1).optional(),
    currencyCode: expenseCurrencySchema.optional(),
    categoryId: z.number().int().nonnegative().optional(),
    isReimbursement: z.boolean().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine(({ from, to }) => !from || !to || from <= to, {
    message: 'The start date must be on or before the end date.',
    path: ['to'],
  })
