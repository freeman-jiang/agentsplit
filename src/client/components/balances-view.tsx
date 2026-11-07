// The Balances card and the suggested payments, ported from the current app's
// balances-list.tsx and reimbursement-list.tsx. Shared by the Balances and Payments tabs.
import { Link } from '@tanstack/react-router'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { Button } from '~/client/ui/button'
import type { CurrencyBalances } from '~/shared/api'

type Currencies = ReadonlyArray<typeof CurrencyBalances.Type>
type Names = ReadonlyMap<string, string>

/** Minor-unit magnitude of a decimal string, for bar widths only. */
const size = (amount: string) => Math.abs(Number(amount.replace('.', '')))

/** The name column and the chart column of the balance chart; the header, the zero line and the rows share it. */
const columns = 'grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4'

export function BalancesCard(props: { currencies: Currencies; names: Names }) {
  return (
    <section className="rounded-2xl border bg-card p-6" aria-labelledby="balances-title">
      <h2 id="balances-title" className="text-base font-semibold leading-tight">
        Balances
      </h2>
      <p className="mt-1.5 mb-4 text-sm text-muted-foreground">Net balance per person, across all group expenses.</p>
      {props.currencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No expenses yet. Your balances will appear here.</p>
      ) : (
        props.currencies.map((c) => {
          const largest = Math.max(1, ...c.balances.map((b) => size(b.net)))
          return (
            <div key={c.currency} className="mb-4 last:mb-0">
              <h3 className={cn('eyebrow', props.currencies.length === 1 && 'sr-only')}>{c.currency}</h3>
              {/* Names sit in one fixed column; the chart beside it keeps debts left of zero and credits right of it. */}
              <div aria-hidden="true" className={cn(columns, 'text-xs text-muted-foreground')}>
                <span />
                <span className="grid grid-cols-2">
                  <span className="px-2 text-right">Owes</span>
                  <span className="px-2">Gets back</span>
                </span>
              </div>
              <div className="relative">
                {/* The center line of the chart column marks zero. */}
                <div aria-hidden="true" className={cn(columns, 'pointer-events-none absolute inset-0')}>
                  <span />
                  <span className="relative">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {c.balances.map((b) => {
                    const positive = !b.net.startsWith('-') && size(b.net) > 0
                    const width = `${(size(b.net) / largest) * 100}%`
                    return (
                      <li key={b.participantId} className={cn(columns, 'items-center text-sm')} data-testid="balance-row">
                        <span className="truncate">{props.names.get(b.participantId) ?? 'Unknown'}</span>
                        <span className="grid grid-cols-2">
                          <span className="relative flex h-8 items-center justify-end px-2">
                            {!positive && size(b.net) > 0 && <span aria-hidden="true" className="absolute inset-y-1 right-0 rounded-s-md bg-owe/15 dark:bg-owe/20" style={{ width }} />}
                            {!positive && <span className="relative text-owe tabular-nums">{money(b.net, c.currency)}</span>}
                          </span>
                          <span className="relative flex h-8 items-center px-2">
                            {positive && (
                              <>
                                <span aria-hidden="true" className="absolute inset-y-1 left-0 rounded-e-md bg-owed/15 dark:bg-owed/20" style={{ width }} />
                                <span className="relative text-owed tabular-nums">{money(b.net, c.currency)}</span>
                              </>
                            )}
                          </span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          )
        })
      )}
    </section>
  )
}

/** "<from> owes <to>" per currency with a "Record payment" link that prefills the payment (P-BAL-47..49). */
export function SuggestedPayments(props: { currencies: Currencies; names: Names; group: string; viewer: string | null }) {
  const name = (id: string) => (id === props.viewer ? 'You' : (props.names.get(id) ?? 'Unknown'))
  const pending = props.currencies.filter((c) => c.settlements.length > 0)
  return (
    <section className="rounded-2xl border bg-card p-6" aria-labelledby="suggested-title">
      <h2 id="suggested-title" className="text-base font-semibold leading-tight">
        Suggested payments
      </h2>
      <p className="mt-1.5 mb-4 text-sm text-muted-foreground">Record these payments to settle the group.</p>
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments needed.</p>
      ) : (
        pending.map((c) => (
          <div key={c.currency} className="mb-4 last:mb-0">
            <h3 className={cn('eyebrow', pending.length === 1 && 'sr-only')}>{c.currency}</h3>
            <ul className="divide-y">
              {c.settlements.map((s) => (
                <li key={`${s.from}-${s.to}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm" data-testid="suggestion">
                  <span>
                    <span className="font-medium">{name(s.from)}</span> {s.from === props.viewer ? 'owe' : 'owes'}{' '}
                    <span className="font-medium">{name(s.to)}</span>
                  </span>
                  <span className="flex w-full items-center justify-between gap-3 sm:w-auto">
                    <span className={cn('text-lg font-semibold tabular-nums', s.from === props.viewer && 'text-owe')}>{money(s.amount, c.currency)}</span>
                    <Button variant={s.from === props.viewer ? 'default' : 'outline'} size="sm" className="min-w-36" asChild>
                      <Link to="/$group/payments/create" params={{ group: props.group }} search={{ from: s.from, to: s.to, amount: s.amount, currencyCode: c.currency }}>
                        Record payment
                      </Link>
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}
