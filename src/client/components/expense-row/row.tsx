// The one expense row of the Dashboard feed and a group's expense list: date,
// category, two text lines, the paid figure and the viewer's figure.
import { Link } from '@tanstack/react-router'
import { Paperclip } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { CategoryIcon } from '~/client/components/category-icon'
import { money } from '~/client/components/money'
import { dayParts } from '~/client/dates'
import type { editorLink } from '~/client/editor-link'
import { expenseRowFigures, type RowExpense, type Tone } from './figures'

/**
 * The row grid. Narrow: date, text, the viewer's figure, and a second line
 * under the text. Wide: date, category, text, the paid figure, the viewer's figure.
 */
const rowClass =
  'grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring sm:min-h-16 sm:grid-cols-[2.5rem_2rem_minmax(0,1fr)_minmax(7rem,auto)_7rem] sm:items-center sm:gap-x-4 sm:px-4 sm:py-2.5'

/** Only the viewer's amount carries red or green. */
const TONES: Record<Tone, string> = { neutral: '', positive: 'text-owed', negative: 'text-owe' }

type RowEntry = RowExpense & {
  readonly id: string
  readonly title: string
  readonly vendor: string | null
  readonly categoryId: number
  readonly expenseDate: string
  readonly documentCount: number
}

type EntryLink = ReturnType<typeof editorLink> | { readonly to: '/expenses/$expenseId'; readonly params: { readonly expenseId: string } }

/**
 * `place` is the row's group on the Dashboard (null: "No group"), and absent in
 * a group's own list. `context` says what a private repayment repays.
 */
export function ExpenseRow(props: {
  expense: RowEntry
  link: EntryLink
  viewer: string | null
  names: ReadonlyMap<string, string>
  attribution: string
  place?: { readonly name: string } | null
  context?: string | null
}) {
  const { expense: e, place, context } = props
  const figures = expenseRowFigures({ expense: e, viewer: props.viewer, names: props.names })
  const amount = (value: string | null) => (value === null ? '—' : money(value, e.currency))
  const paid = amount(figures.paid.amount)
  const shown = place !== undefined
  const placeName = place?.name ?? 'No group'
  return (
    <Link {...props.link} data-testid="expense-card" data-expense-id={e.id} className={rowClass}>
      <RowDate date={e.expenseDate} />
      <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground sm:flex">
        <CategoryIcon categoryId={e.categoryId} className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        {context && (
          <div data-testid="expense-context" className="mb-0.5 truncate text-xs text-muted-foreground sm:hidden">
            {context}
          </div>
        )}
        {/* The vendor sits above the title on narrow screens; wide screens show it in the metadata line. */}
        {e.vendor && (
          <div className="truncate text-xs font-medium text-muted-foreground sm:hidden" title={e.vendor}>
            {e.vendor}
          </div>
        )}
        <RowTitle title={e.title} payment={e.kind === 'payment'} documentCount={e.documentCount} />
        <Metadata
          parts={[
            context && { key: 'context', node: context },
            e.vendor && {
              key: 'vendor',
              node: (
                <span data-testid="expense-vendor" title={e.vendor}>
                  {e.vendor}
                </span>
              ),
            },
            shown && {
              key: 'group',
              node: place ? (
                <span data-testid="expense-group-badge" title={place.name}>
                  {place.name}
                </span>
              ) : (
                <span data-testid="expense-no-group" className="italic">
                  No group
                </span>
              ),
            },
            { key: 'author', node: props.attribution },
          ]}
        />
      </div>
      {/* At most 11rem, so a long list of payers truncates and the title keeps its room. */}
      <RowFigure className="max-sm:hidden sm:max-w-44" testId="expense-paid" label={figures.paid.label} amount={paid} amountClass={cn('text-sm text-foreground/80', TONES[figures.paid.tone])} />
      <RowFigure testId="expense-personal" label={figures.personal.label} amount={amount(figures.personal.amount)} amountClass={cn('font-semibold', TONES[figures.personal.tone])} />
      {/* On narrow screens the paid figure, and the group, sit under the title and use the width under the viewer's figure too. */}
      <p className="col-span-2 col-start-2 flex min-w-0 gap-1 text-sm text-muted-foreground sm:hidden">
        {/* A long list of payers truncates; the amount always shows. */}
        <span className="min-w-0 truncate" title={figures.paid.label}>
          {figures.paid.label}
        </span>{' '}
        <span className="shrink-0 tabular-nums">{paid}</span>
        {shown && <span className="min-w-0 truncate">· {placeName}</span>}
      </p>
    </Link>
  )
}

function RowDate({ date }: { date: string }) {
  const parts = dayParts(date)
  return (
    <time dateTime={date} className="row-span-2 text-center leading-tight sm:row-span-1">
      <span className="block text-xs text-muted-foreground uppercase">{parts.month}</span>
      <span className="block text-lg tabular-nums">{parts.day}</span>
      <span className="sr-only">{parts.year}</span>
    </time>
  )
}

/** The title line: a payment's title is italic, and receipts show as a paperclip count. */
function RowTitle(props: { title: string; payment: boolean; documentCount: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span data-testid="expense-title" title={props.title} className={cn('truncate text-base font-medium', props.payment && 'italic')}>
        {props.title}
      </span>
      {props.documentCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={`${props.documentCount} receipt(s)`}>
          <Paperclip aria-hidden="true" className="h-3 w-3" />
          {props.documentCount}
        </span>
      )}
    </div>
  )
}

/** One muted line on wide screens: the given parts joined with " · ". */
function Metadata(props: { parts: ReadonlyArray<{ key: string; node: ReactNode } | false | null | undefined | ''> }) {
  const parts = props.parts.filter((p) => !!p)
  return (
    <p className="truncate text-xs text-muted-foreground max-sm:hidden sm:text-[13px] sm:leading-[18px]" data-testid="expense-metadata">
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 && ' · '}
          {part.node}
        </Fragment>
      ))}
    </p>
  )
}

/** A muted label over an amount, right-aligned. The paid amount is smaller, so the viewer's figure leads. */
function RowFigure(props: { label: string; amount: string; amountClass: string; className?: string; testId: string }) {
  return (
    <div className={cn('min-w-0 text-right', props.className)} data-testid={props.testId}>
      <div className="truncate text-xs text-muted-foreground" title={props.label}>
        {props.label}
      </div>
      <div className={cn('mt-0.5 text-base tabular-nums', props.amountClass)}>{props.amount}</div>
    </div>
  )
}
