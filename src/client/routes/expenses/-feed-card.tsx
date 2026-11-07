import { Link } from '@tanstack/react-router'
import { cn } from '~/client/cn'
import { expenseRowClass, RowCategory, RowDate, RowFigure, RowMetadata, RowNarrowLine, RowTitle, RowVendor } from '~/client/components/expense-row-parts'
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

export function FeedCard({ expense }: { expense: Item }) {
  const figures = rowFigures(expense)
  const context = !expense.group && expense.kind === 'payment' && expense.contextExpenseTitle ? `Repayment for ${expense.contextExpenseTitle}` : null
  const tone = (figure: Figure) => cn(figure.tone === 'positive' && 'text-owed', figure.tone === 'negative' && 'text-owe')
  const amount = (figure: Figure) => (figure.amount === null ? '—' : money(figure.amount, expense.currency))
  return (
    <Link to="/expenses/$expenseId" params={{ expenseId: expense.id }} data-testid="expense-card" data-expense-id={expense.id} className={expenseRowClass}>
      <RowDate date={expense.expenseDate} />
      <RowCategory categoryId={expense.categoryId} />
      <div className="min-w-0">
        {context && (
          <div data-testid="expense-context" className="mb-0.5 truncate text-xs text-muted-foreground sm:hidden">
            {context}
          </div>
        )}
        <RowVendor vendor={expense.vendor} />
        <RowTitle title={expense.title} payment={expense.kind === 'payment'} documentCount={expense.documentCount} testId="expense-title" />
        {/* One metadata line: what the title is about, where it is, and who wrote it. */}
        <RowMetadata
          testId="expense-metadata"
          parts={[
            context && { key: 'context', node: context },
            expense.vendor && {
              key: 'vendor',
              node: (
                <span data-testid="expense-vendor" title={expense.vendor}>
                  {expense.vendor}
                </span>
              ),
            },
            {
              key: 'group',
              node: expense.group ? (
                <span data-testid="expense-group-badge" title={expense.group.name}>
                  {expense.group.name}
                </span>
              ) : (
                <span data-testid="expense-no-group" className="italic">
                  No group
                </span>
              ),
            },
            { key: 'author', node: attributionLine(expense.attribution) },
          ]}
        />
      </div>
      <RowFigure className="max-sm:hidden" testId="expense-paid" label={figures.paid.label} amount={amount(figures.paid)} labelClass={tone(figures.paid)} amountClass={tone(figures.paid)} />
      <RowFigure testId="expense-personal" label={figures.personal.label} amount={amount(figures.personal)} labelClass={tone(figures.personal)} amountClass={cn('font-semibold', tone(figures.personal))} />
      {/* On narrow screens the paid figure and the group sit under the title and use the width under the viewer's figure too. */}
      <RowNarrowLine>
        <span className="shrink-0">
          {figures.paid.label} <span className="tabular-nums">{amount(figures.paid)}</span>
        </span>
        <span className="min-w-0 truncate">· {expense.group?.name ?? 'No group'}</span>
      </RowNarrowLine>
    </Link>
  )
}
