import type { SelectHTMLAttributes } from 'react'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { NativeSelect } from './native-select'

const COMMON = ['USD', 'EUR', 'JPY', 'GBP', 'CNY'] as const satisfies readonly CurrencyCode[]
const OTHERS = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => !(COMMON as readonly string[]).includes(code)).sort()
const GROUPS = [
  ['Common', COMMON],
  ['Other', OTHERS],
] as const

type Base = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> & {
  wrapperClassName?: string
  /** Shows only the code when closed; the open list keeps the names. */
  compact?: boolean
}

/**
 * Every currency of the registry, the common ones first. With `any`, an empty
 * first option stands for no currency, as in a filter.
 */
export function CurrencySelect(
  props: Base & ({ any?: undefined; value: CurrencyCode; onChange: (currency: CurrencyCode) => void } | { any: string; value: CurrencyCode | ''; onChange: (currency: CurrencyCode | '') => void }),
) {
  const { any, value, onChange, compact, ...rest } = props
  return (
    <NativeSelect
      {...rest}
      value={value}
      {...(compact && value ? { displayValue: value } : {})}
      onChange={(event) => {
        const code = Object.hasOwn(CURRENCIES, event.target.value) ? (event.target.value as CurrencyCode) : null
        if (props.any !== undefined) props.onChange(code ?? '')
        else if (code) props.onChange(code)
      }}
    >
      {any !== undefined && <option value="">{any}</option>}
      {GROUPS.map(([label, codes]) => (
        <optgroup key={label} label={label}>
          {codes.map((code) => (
            <option key={code} value={code}>
              {code} · {CURRENCIES[code].name}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  )
}
