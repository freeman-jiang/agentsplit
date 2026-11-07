import { Link } from '@tanstack/react-router'
import { Paperclip } from 'lucide-react'
import { cn } from '~/client/cn'
import { CategoryIcon } from '~/client/components/category-icon'
import { money } from '~/client/components/money'
import type { Attribution, FeedItem } from '~/shared/api'
import type { CurrencyCode } from '~/shared/currencies'
import { formatMinor, minor, minorOrNull, type Minor } from '~/shared/minor'

type Item = typeof FeedItem.Type
type Figure = { label: string; amount: string | null; tone: 'neutral' | 'positive' | 'negative' }

const units = (amount: string, currency: CurrencyCode): bigint => {
  return minorOrNull({ amount, currency }) ?? 0n
}
const abs = (value: bigint, currency: CurrencyCode) => formatMinor({ amount: minor(value < 0n ? -value : value) as Minor, currency })

/** The two figures of a card: what was paid, and what it means for the viewer. Ported from the current app's expenseRowFigures. */
export function rowFigures(expense: Item): { paid: Figure; personal: Figure } {
  const { currency } = expense
  const me = expense.participantId
  const total = units(expense.amount, currency)
  const income = total < 0n
  const name = (id: string) => (id === me ? 'you' : (expense.people.find((p) => p.id === id)?.name ?? 'Someone'))
  const payers = expense.payers.map((p) => name(p.participantId))
  const paid: Figure = { label: `${payers.join(' and ')} ${income ? 'received' : 'paid'}`, amount: abs(total, currency), tone: 'neutral' }
  if (!me) return { paid, personal: { label: 'identity not linked', amount: null, tone: 'neutral' } }
  const myPaid = expense.payers.filter((p) => p.participantId === me).reduce((sum, p) => sum + units(p.amount, currency), 0n)
  const share = expense.shares.filter((s) => s.participantId === me).reduce((sum, s) => sum + units(s.amount, currency), 0n)
  const isPayer = expense.payers.some((p) => p.participantId === me)
  if (!isPayer && !expense.shares.some((s) => s.participantId === me)) return { paid, personal: { label: 'not involved', amount: null, tone: 'neutral' } }
  const net = myPaid - share
  if (expense.kind === 'payment')
    return {
      paid,
      personal: { label: isPayer !== income ? 'you repaid' : 'you received', amount: abs(isPayer ? net : share, currency), tone: 'neutral' },
    }
  if (income) return { paid, personal: { label: 'your share', amount: abs(share, currency), tone: 'positive' } }
  return {
    paid,
    personal: {
      label: net > 0n ? 'you lent' : net < 0n ? 'you borrowed' : 'your share',
      amount: abs(net === 0n ? share : net, currency),
      tone: net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral',
    },
  }
}

/** "Last edited by", else "Added by"; never a time on a compact card. */
export function attributionLine(a: typeof Attribution.Type) {
  if (a.updatedBy) return `Last edited by ${a.updatedBy.name}`
  if (a.createdBy) return `Added by ${a.createdBy.name}`
  return 'Original author unavailable'
}

const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })

export function FeedCard({ expense }: { expense: Item }) {
  const figures = rowFigures(expense)
  const date = new Date(`${expense.expenseDate}T00:00:00Z`)
  const context = !expense.group && expense.kind === 'payment' && expense.contextExpenseTitle ? `Repayment for ${expense.contextExpenseTitle}` : null
  return (
    <Link
      to="/expenses/$expenseId"
      params={{ expenseId: expense.id }}
      data-testid="expense-card"
      data-expense-id={expense.id}
      className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 px-3 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[2rem_2.5rem_minmax(0,1fr)_minmax(7rem,auto)_minmax(7rem,auto)] sm:gap-x-4 sm:px-4"
    >
      <time dateTime={expense.expenseDate} className="text-center leading-tight">
        <span className="block text-xs text-muted-foreground uppercase">{month.format(date)}</span>
        <span className="block text-lg tabular-nums">{date.getUTCDate()}</span>
        <span className="sr-only">{date.getUTCFullYear()}</span>
      </time>
      <span className="hidden h-10 w-10 items-center justify-center bg-muted text-primary sm:flex">
        <CategoryIcon categoryId={expense.categoryId} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        {context && (
          <div data-testid="expense-context" className="mb-1 text-xs text-muted-foreground">
            {context}
          </div>
        )}
        {expense.vendor && (
          <div className="mb-1 truncate text-xs font-medium text-muted-foreground" data-testid="expense-vendor" title={expense.vendor}>
            {expense.vendor}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span data-testid="expense-title" title={expense.title} className={cn('truncate text-base font-medium', expense.kind === 'payment' && 'italic')}>
            {expense.title}
          </span>
          {expense.documentCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={`${expense.documentCount} receipt(s)`}>
              <Paperclip aria-hidden="true" className="h-3 w-3" />
              {expense.documentCount}
            </span>
          )}
        </div>
        {/* On narrow screens the paid figure sits under the title, so the right column holds only the viewer's figure. */}
        <p className="truncate text-xs text-muted-foreground sm:hidden">
          {figures.paid.label} <span className="tabular-nums">{figures.paid.amount === null ? '—' : money(figures.paid.amount, expense.currency)}</span>
        </p>
        {/* The group sits in the metadata line, so the title stays on the first lines of the row. */}
        <p className="truncate text-xs text-muted-foreground" data-testid="expense-metadata">
          {expense.group ? (
            <span data-testid="expense-group-badge" title={expense.group.name}>
              {expense.group.name}
            </span>
          ) : (
            <span data-testid="expense-no-group" className="italic">
              No group
            </span>
          )}{' '}
          · {attributionLine(expense.attribution)}
        </p>
      </div>
      <div className="flex flex-col items-end text-right sm:contents">
        {[figures.paid, figures.personal].map((figure, i) => (
          <div
            key={i}
            className={cn('min-w-0 sm:text-right', i === 0 && 'max-sm:hidden')}
            data-testid={i === 0 ? 'expense-paid' : 'expense-personal'}
          >
            <div
              className={cn('truncate text-xs text-muted-foreground', figure.tone === 'positive' && 'text-owed', figure.tone === 'negative' && 'text-owe')}
              title={figure.label}
            >
              {figure.label}
            </div>
            <div
              className={cn(
                'mt-0.5 text-base tabular-nums',
                i === 1 && 'font-semibold',
                figure.tone === 'positive' && 'text-owed',
                figure.tone === 'negative' && 'text-owe',
              )}
            >
              {figure.amount === null ? '—' : money(figure.amount, expense.currency)}
            </div>
          </div>
        ))}
      </div>
    </Link>
  )
}
