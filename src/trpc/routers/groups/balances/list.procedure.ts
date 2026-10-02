import { getGroupExpenses } from '@/lib/api'
import {
  getBalances,
  getPublicBalances,
  getSuggestedReimbursements,
  groupExpensesByCurrency,
} from '@/lib/balances'
import { expenseCurrencySchema } from '@/lib/currency'
import {
  exclusiveHistorySelection,
  historicalFields,
  historicalLedger,
  type HistoricalView,
} from '@/lib/history-query'
import { baseProcedure } from '@/trpc/init'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const listGroupBalancesProcedure = baseProcedure
  .input(
    z
      .object({
        ...historicalFields,
        groupId: z.string().min(1),
        currencyCode: expenseCurrencySchema.optional(),
      })
      .refine(exclusiveHistorySelection, {
        message: 'Choose asOf or atActivityId',
      }),
  )
  .query(
    async ({ ctx, input: { groupId, currencyCode, asOf, atActivityId } }) => {
      let history: HistoricalView | undefined
      let expenses: Awaited<ReturnType<typeof getGroupExpenses>>
      if (asOf || atActivityId) {
        const ledger = await historicalLedger(groupId, { asOf, atActivityId })
        if (!ledger.history.complete)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Historical balances are unavailable because some expenses have no saved state at this point. Read list_expenses at the same boundary to inspect history coverage.',
          })
        history = ledger.history
        expenses = ledger.expenses.filter(
          (expense) => !currencyCode || expense.currencyCode === currencyCode,
        )
      } else
        expenses = await getGroupExpenses(groupId, {
          readOnly: ctx.readOnly,
          currencyCode,
        })
      return {
        history,
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
    },
  )
