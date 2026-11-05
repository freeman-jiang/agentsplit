import { Link } from '@tanstack/react-router'
import { Paperclip, Users } from 'lucide-react'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { Badge } from '~/client/ui/badge'
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
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-3 border-b px-3 py-4 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[2rem_minmax(0,1fr)_minmax(7rem,auto)_minmax(7rem,auto)] sm:items-center sm:gap-x-4"
    >
      <time dateTime={expense.expenseDate} className="row-span-2 text-center text-muted-foreground sm:row-span-1">
        <span className="block text-[10px] uppercase tracking-wide">{month.format(date)}</span>
        <span className="block text-xl leading-tight tabular-nums">{date.getUTCDate()}</span>
        <span className="sr-only">{date.getUTCFullYear()}</span>
      </time>
      <div className="min-w-0">
        {expense.group ? (
          <Badge
            variant="outline"
            data-testid="expense-group-badge"
            className="mb-1 max-w-full gap-1 rounded border-border/60 bg-muted/20 px-1.5 py-0 text-[10px] font-normal leading-4 text-muted-foreground"
            title={expense.group.name}
          >
            <Users aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{expense.group.name}</span>
          </Badge>
        ) : (
          <div data-testid="expense-no-group" className="mb-1 text-[10px] italic leading-4 text-muted-foreground">
            No group
          </div>
        )}
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
          <span data-testid="expense-title" title={expense.title} className={cn('truncate text-sm font-semibold sm:text-base', expense.kind === 'payment' && 'italic')}>
            {expense.title}
          </span>
          {expense.documentCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={`${expense.documentCount} receipt(s)`}>
              <Paperclip aria-hidden="true" className="h-3 w-3" />
              {expense.documentCount}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="expense-metadata">
          {attributionLine(expense.attribution)}
        </p>
      </div>
      <div className="col-start-2 grid grid-cols-2 gap-3 sm:col-start-auto sm:contents">
        {[figures.paid, figures.personal].map((figure, i) => (
          <div key={i} className="min-w-0 sm:text-right" data-testid={i === 0 ? 'expense-paid' : 'expense-personal'}>
            <div className="truncate text-xs text-muted-foreground" title={figure.label}>
              {figure.label}
            </div>
            <div
              className={cn(
                'mt-0.5 text-sm font-semibold tabular-nums sm:text-base',
                figure.tone === 'positive' && 'text-green-700 dark:text-green-400',
                figure.tone === 'negative' && 'text-red-700 dark:text-red-400',
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
