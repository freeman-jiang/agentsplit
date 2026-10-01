import { getGroupExpenses } from '@/lib/api'
import {
  getBalances,
  getPublicBalances,
  getSuggestedReimbursements,
  groupExpensesByCurrency,
} from '@/lib/balances'
import { expenseCurrencySchema } from '@/lib/currency'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const listGroupBalancesProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      currencyCode: expenseCurrencySchema.optional(),
    }),
  )
  .query(async ({ ctx, input: { groupId, currencyCode } }) => {
    const expenses = await getGroupExpenses(groupId, {
      readOnly: ctx.readOnly,
      currencyCode,
    })
    return {
      currencies: groupExpensesByCurrency(expenses).map(
        ({ currencyCode, expenses }) => {
          const reimbursements = getSuggestedReimbursements(
            getBalances(expenses),
          )
          return {
            currencyCode,
            balances: getPublicBalances(reimbursements),
            reimbursements,
          }
        },
      ),
    }
  })
