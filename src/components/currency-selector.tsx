import { NativeSelect } from '@/components/ui/native-select'
import { Currency } from '@/lib/currency'
import { useTranslations } from 'next-intl'
import { forwardRef, SelectHTMLAttributes } from 'react'

type Props = Pick<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> & {
  currencies: Currency[]
  onValueChange: (currencyCode: Currency['code']) => void
  defaultValue: Currency['code']
  isLoading: boolean
  compact?: boolean
}

export const CurrencySelector = forwardRef<HTMLSelectElement, Props>(
  (
    {
      currencies,
      onValueChange,
      defaultValue,
      isLoading,
      compact = false,
      ...props
    },
    ref,
  ) => {
    const t = useTranslations('Currencies')
    const groups = currencies.reduce<Record<string, Currency[]>>(
      (result, currency) => {
        const key =
          currency.code === ''
            ? 'custom'
            : ['USD', 'EUR', 'JPY', 'GBP', 'CNY'].includes(currency.code)
              ? 'common'
              : 'other'
        ;(result[key] ??= []).push(currency)
        return result
      },
      {},
    )
    return (
      <NativeSelect
        ref={ref}
        {...props}
        value={defaultValue}
        onChange={(event) => onValueChange(event.target.value)}
        disabled={isLoading}
        aria-busy={isLoading}
        displayValue={compact && defaultValue ? defaultValue : undefined}
        wrapperClassName={compact ? 'w-28' : undefined}
        className={compact ? 'h-12 border-s-0' : undefined}
      >
        {!currencies.some((currency) => currency.code === '') && (
          <option value="" disabled>
            {t('select')}
          </option>
        )}
        {Object.entries(groups).map(([key, options]) => (
          <optgroup key={key} label={t(`${key}.heading`)}>
            {options.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.name}
                {currency.code ? ` (${currency.code})` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </NativeSelect>
    )
  },
)
CurrencySelector.displayName = 'CurrencySelector'
