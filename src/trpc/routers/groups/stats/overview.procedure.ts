import {
  getActiveRecurringExpenses,
  getGroup,
  getGroupExpenses,
} from '@/lib/api'
import { expenseCurrencySchema } from '@/lib/currency'
import { getMonthlyCategorySpending } from '@/lib/monthly-spending'
import {
  filterExpensesByDateRange,
  getRecurringSpending,
  getSpendingByCategory,
  getSpendingByParticipant,
  getSpendingOverTime,
  getSpendingSummary,
  getTotalActiveUserPaidFor,
  getTotalActiveUserShare,
  getTotalGroupSpending,
} from '@/lib/totals'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

/**
 * Single data-loader for the whole stats page. Fetches the group's expenses
 * once and derives every stats section from them, so loading the page (and
 * changing the date range) costs one request instead of one per card.
 *
 * Recurring stats are range-independent (they reflect the currently active
 * subscriptions) and come from a separate query.
 */
export const getStatsOverviewProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      participantId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      currencyCode: expenseCurrencySchema.optional(),
    }),
  )
  .query(
    async ({
      ctx,
      input: { groupId, participantId, from, to, currencyCode },
    }) => {
      // getGroupExpenses and getActiveRecurringExpenses both materialize due
      // recurring frames; run them sequentially so the two passes don't race
      // each other (the second is a no-op once the first has materialized).
      const [group, allExpenses] = await Promise.all([
        getGroup(groupId),
        getGroupExpenses(groupId, { readOnly: ctx.readOnly }),
      ])
      const recurringExpenses = await getActiveRecurringExpenses(groupId, {
        readOnly: ctx.readOnly,
      })

      const availableCurrencyCodes = [
        ...new Set(
          [...allExpenses, ...recurringExpenses].map(
            (expense) => expense.currencyCode,
          ),
        ),
      ].sort()
      const defaultCurrency = expenseCurrencySchema.safeParse(
        group?.currencyCode,
      )
      if (availableCurrencyCodes.length === 0 && defaultCurrency.success)
        availableCurrencyCodes.push(defaultCurrency.data)
      const selectedCurrency =
        currencyCode ??
        (defaultCurrency.success &&
        availableCurrencyCodes.includes(defaultCurrency.data)
          ? defaultCurrency.data
          : availableCurrencyCodes.length
            ? availableCurrencyCodes[0]
            : null)
      const expenses = filterExpensesByDateRange(
        allExpenses.filter(
          (expense) => expense.currencyCode === selectedCurrency,
        ),
        from,
        to,
      )
      const participants = group?.participants ?? []

      return {
        currencyCode: selectedCurrency ?? null,
        availableCurrencyCodes,
        totalGroupSpendings: getTotalGroupSpending(expenses),
        totalParticipantSpendings:
          participantId !== undefined
            ? getTotalActiveUserPaidFor(participantId, expenses)
            : undefined,
        totalParticipantShare:
          participantId !== undefined
            ? getTotalActiveUserShare(participantId, expenses)
            : undefined,
        summary: getSpendingSummary(expenses),
        months: getSpendingOverTime(expenses),
        monthlyCategorySpending: getMonthlyCategorySpending(expenses, {
          grouping: 'category',
          from,
          to,
        }),
        participants: getSpendingByParticipant(participants, expenses),
        categories: getSpendingByCategory(expenses),
        recurring: getRecurringSpending(
          recurringExpenses.filter(
            (expense) => expense.currencyCode === selectedCurrency,
          ),
        ),
      }
    },
  )
