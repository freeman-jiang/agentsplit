// The parts that the Dashboard feed and a group's expense list share, so the
// two lists keep one row layout: date, category, two text lines, two figures.
import { Paperclip } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { CategoryIcon } from '~/client/components/category-icon'

/**
 * The row grid. Narrow: date, text, the viewer's figure, and a second line
 * under the text. Wide: date, category, text, the paid figure, the viewer's figure.
 */
export const expenseRowClass =
  'grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring sm:min-h-16 sm:grid-cols-[2.5rem_2rem_minmax(0,1fr)_minmax(7rem,auto)_7rem] sm:items-center sm:gap-x-4 sm:px-4 sm:py-2.5'

const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })

export function RowDate({ date }: { date: string }) {
  const day = new Date(`${date}T00:00:00Z`)
  return (
    <time dateTime={date} className="row-span-2 text-center leading-tight sm:row-span-1">
      <span className="block text-xs text-muted-foreground uppercase">{monthFormat.format(day)}</span>
      <span className="block text-lg tabular-nums">{day.getUTCDate()}</span>
      <span className="sr-only">{day.getUTCFullYear()}</span>
    </time>
  )
}

export function RowCategory({ categoryId }: { categoryId: number }) {
  return (
    <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground sm:flex">
      <CategoryIcon categoryId={categoryId} className="h-4 w-4" />
    </span>
  )
}

/** The title line: a payment's title is italic, and receipts show as a paperclip count. */
export function RowTitle(props: { title: string; payment: boolean; documentCount: number; testId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span data-testid={props.testId} title={props.title} className={cn('truncate text-base font-medium', props.payment && 'italic')}>
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

/** The vendor above the title on narrow screens; wide screens show it in the metadata line. */
export function RowVendor({ vendor }: { vendor: string | null | undefined }) {
  if (!vendor) return null
  return (
    <div className="truncate text-xs font-medium text-muted-foreground sm:hidden" title={vendor}>
      {vendor}
    </div>
  )
}

/** One muted line on wide screens: the given parts joined with " · ". */
export function RowMetadata(props: { parts: ReadonlyArray<{ key: string; node: ReactNode } | false | null | undefined | ''>; testId?: string }) {
  const parts = props.parts.filter((p) => !!p)
  return (
    <p className="mt-0.5 truncate text-xs text-muted-foreground max-sm:hidden sm:text-[13px] sm:leading-5" data-testid={props.testId}>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 && ' · '}
          {part.node}
        </Fragment>
      ))}
    </p>
  )
}

/** A label over an amount, right-aligned. The paid figure passes a smaller, muted amount, so the viewer's figure leads. */
export function RowFigure(props: { label: string; amount: string; labelClass?: string; amountClass?: string; className?: string; testId?: string }) {
  return (
    <div className={cn('min-w-0 text-right', props.className)} data-testid={props.testId}>
      <div className={cn('truncate text-xs text-muted-foreground', props.labelClass)} title={props.label}>
        {props.label}
      </div>
      <div className={cn('mt-0.5 text-base tabular-nums', props.amountClass)}>{props.amount}</div>
    </div>
  )
}

/** The narrow-screen second line, under the text and the viewer's figure. */
export function RowNarrowLine({ children }: { children: ReactNode }) {
  return <p className="col-span-2 col-start-2 flex min-w-0 gap-1 text-sm text-muted-foreground sm:hidden">{children}</p>
}
