// The suggested payments that settle a balance, in the three places that list
// them: the Balances and Payments tabs, the group's balance rail, and the
// repayments of a private expense.
import { Link } from '@tanstack/react-router'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { Button } from '~/client/ui/button'
import type { CurrencyBalances } from '~/shared/api'
import type { CurrencyCode } from '~/shared/currencies'

type Currencies = ReadonlyArray<typeof CurrencyBalances.Type>
type Settlement = { readonly from: string; readonly to: string; readonly amount: string }
type People = { readonly names: ReadonlyMap<string, string>; readonly viewer: string | null }

/** A person in a settlement: "You" for the viewer. */
const nameOf = (id: string, people: People) => (id === people.viewer ? 'You' : (people.names.get(id) ?? 'Unknown'))

/** "<from> owes <to>" per currency with a "Record payment" link that prefills the payment (P-BAL-47..49). */
export function SuggestedPayments(props: People & { currencies: Currencies; group: string }) {
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
                    <span className="font-medium">{nameOf(s.from, props)}</span> {s.from === props.viewer ? 'owe' : 'owes'}{' '}
                    <span className="font-medium">{nameOf(s.to, props)}</span>
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

/** The rail's short list: "<from> → <to>" over the amount. */
export function RailSettlements(props: People & { currency: CurrencyCode; settlements: readonly Settlement[] }) {
  if (props.settlements.length === 0) return null
  return (
    <div className="border-t pt-4">
      <h3 className="eyebrow">Suggested payments</h3>
      <ul className="space-y-3 text-sm">
        {props.settlements.map((s) => (
          <li key={`${s.from}-${s.to}`} data-testid="summary-payment">
            <span className="block break-words">
              {nameOf(s.from, props)} → {nameOf(s.to, props)}
            </span>
            <strong className="tabular-nums">{money(s.amount, props.currency)}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A private expense's transfers, each with a link that prefills the repayment (P-UNGROUP-72). Names only: no "You". */
export function RepaymentSettlements(props: { names: ReadonlyMap<string, string>; expenseId: string; settlements: ReadonlyArray<{ readonly currency: CurrencyCode; readonly transfers: readonly Settlement[] }> }) {
  const people = { names: props.names, viewer: null }
  return props.settlements.map(({ currency, transfers }) => (
    <div key={currency} className="space-y-3">
      {transfers.length === 0 ? (
        <p className="text-sm">Settled in {currency}.</p>
      ) : (
        transfers.map((t) => (
          <div key={`${t.from}-${t.to}`} className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm">
            <span>
              {nameOf(t.from, people)} owes {nameOf(t.to, people)} <strong>{money(t.amount, currency)}</strong>
            </span>
            <Link className="underline" to="/expenses/$expenseId/payments/create" params={{ expenseId: props.expenseId }} search={{ from: t.from, to: t.to, amount: t.amount, currencyCode: currency }}>
              Record repayment
            </Link>
          </div>
        ))
      )}
    </div>
  ))
}
