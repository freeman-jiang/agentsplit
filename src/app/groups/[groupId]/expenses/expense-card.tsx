'use client'

import { CategoryIcon } from '@/app/groups/[groupId]/expenses/category-icon'
import { DocumentsCount } from '@/app/groups/[groupId]/expenses/documents-count'
import { Locale } from '@/i18n/request'
import { getGroupExpenses } from '@/lib/api'
import { Currency } from '@/lib/currency'
import { expenseRowFigures } from '@/lib/expense-row'
import { useActiveUser } from '@/lib/hooks'
import { cn, formatCurrency, formatDateOnly } from '@/lib/utils'
import { useLocale } from 'next-intl'
import Link from 'next/link'

type Expense = Awaited<ReturnType<typeof getGroupExpenses>>[number]
type Props = {
  expense: Expense
  currency: Currency
  groupId: string
  participantCount: number
}

export function ExpenseCard({ expense, currency, groupId }: Props) {
  const locale = useLocale() as Locale
  const participantId = useActiveUser(groupId)
  const figures = expenseRowFigures(expense, participantId)
  const attribution = expense.attribution
  return (
    <Link
      href={`/groups/${groupId}/expenses/${expense.id}/edit`}
      data-testid="expense-card"
      data-expense-id={expense.id}
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-3 border-b px-3 py-4 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[2rem_2.5rem_minmax(0,1fr)_minmax(7rem,auto)_minmax(7rem,auto)] sm:items-center sm:gap-x-4"
    >
      <time
        dateTime={expense.expenseDate.toISOString().slice(0, 10)}
        className="row-span-2 text-center text-muted-foreground sm:row-span-1"
      >
        <span className="block text-[10px] uppercase tracking-wide">
          {formatDateOnly(expense.expenseDate, locale, { month: 'short' })}
        </span>
        <span className="block text-xl leading-tight tabular-nums">
          {formatDateOnly(expense.expenseDate, locale, { day: 'numeric' })}
        </span>
        <span className="sr-only">
          {formatDateOnly(expense.expenseDate, locale, { year: 'numeric' })}
        </span>
      </time>
      <span className="hidden h-10 w-10 items-center justify-center bg-muted text-primary sm:flex">
        <CategoryIcon category={expense.category} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-sm font-semibold sm:text-base',
              expense.isReimbursement && 'italic',
            )}
          >
            {expense.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <DocumentsCount count={expense._count.documents} />
          </span>
        </div>
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={
            attribution?.updatedBy
              ? `Last edited by ${attribution.updatedBy.name}`
              : undefined
          }
        >
          {attribution?.createdBy
            ? `Added by ${attribution.createdBy.name}`
            : 'Original author unavailable'}
          {attribution?.updatedBy &&
            ` · Edited by ${attribution.updatedBy.name}`}
        </p>
      </div>
      <div className="col-start-2 grid grid-cols-2 gap-3 sm:contents">
        {[figures.paid, figures.personal].map((figure, i) => (
          <div
            key={i}
            className="min-w-0 sm:text-right"
            data-testid={i === 0 ? 'expense-paid' : 'expense-personal'}
          >
            <div
              className="truncate text-xs text-muted-foreground"
              title={figure.label}
            >
              {figure.label}
            </div>
            <div
              className={cn(
                'mt-0.5 text-sm font-semibold tabular-nums sm:text-base',
                figure.tone === 'positive' &&
                  'text-green-700 dark:text-green-400',
                figure.tone === 'negative' && 'text-red-700 dark:text-red-400',
              )}
            >
              {figure.amount === null
                ? '—'
                : formatCurrency(currency, figure.amount, locale)}
            </div>
          </div>
        ))}
      </div>
    </Link>
  )
}
