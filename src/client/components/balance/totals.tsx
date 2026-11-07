import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import type { CurrencyCode } from '~/shared/currencies'
import { magnitude, netLabel, netTone } from './net'

/**
 * The caller's total per currency, a label over a large amount: the Dashboard
 * balance and the Groups balance. A zero total reads "Net balance", in ink.
 */
export function TotalAmounts(props: { totals: ReadonlyArray<{ readonly currency: CurrencyCode; readonly net: string }> }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-12 gap-y-5 sm:mt-2">
      {props.totals.map(({ currency, net }) => {
        const tone = netTone(net)
        return (
          <li key={currency} className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-2 sm:space-y-1" data-currency={currency}>
            <p className="text-xs text-muted-foreground max-sm:text-sm">
              {tone === 'zero' ? 'Net balance' : netLabel(net, 'you')} · {currency}
            </p>
            <p className={cn('text-3xl font-semibold tabular-nums sm:text-4xl', tone === 'owe' && 'text-owe', tone === 'owed' && 'text-owed')}>
              {money(magnitude(net), currency)}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
