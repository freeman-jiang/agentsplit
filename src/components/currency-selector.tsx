import { Button, ButtonProps } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Currency } from '@/lib/currency'
import { useMediaQuery } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { forwardRef, useEffect, useState } from 'react'

type Props = Pick<ButtonProps, 'id' | 'aria-describedby' | 'aria-invalid'> & {
  compact?: boolean
  currencies: Currency[]
  onValueChange: (currencyCode: Currency['code']) => void
  /** Currency code to be selected by default. Overwriting this value will update current selection, too. */
  defaultValue: Currency['code']
  isLoading: boolean
}

export function CurrencySelector({
  currencies,
  onValueChange,
  defaultValue,
  isLoading,
  compact = false,
  ...buttonProps
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<string>(defaultValue)
  const isDesktop = useMediaQuery('(min-width: 768px)')

  // allow overwriting currently selected currency from outside
  useEffect(() => {
    setValue(defaultValue)
    onValueChange(defaultValue)
  }, [defaultValue])

  const selectedCurrency =
    currencies.find((currency) => (currency.code ?? '') === value) ??
    currencies[0]

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <CurrencyButton
            currency={selectedCurrency}
            compact={compact}
            {...buttonProps}
            open={open}
            isLoading={isLoading}
          />
        </PopoverTrigger>
        <PopoverContent className="p-0" align="start">
          <CurrencyCommand
            currencies={currencies}
            onValueChange={(code) => {
              setValue(code)
              onValueChange(code)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <CurrencyButton
          currency={selectedCurrency}
          compact={compact}
          {...buttonProps}
          open={open}
          isLoading={isLoading}
        />
      </DrawerTrigger>
      <DrawerContent className="p-0">
        <CurrencyCommand
          currencies={currencies}
          onValueChange={(id) => {
            setValue(id)
            onValueChange(id)
            setOpen(false)
          }}
        />
      </DrawerContent>
    </Drawer>
  )
}

function CurrencyCommand({
  currencies,
  onValueChange,
}: {
  currencies: Currency[]
  onValueChange: (currencyId: Currency['code']) => void
}) {
  const currencyGroup = (currency: Currency) => {
    switch (currency.code) {
      case 'USD':
      case 'EUR':
      case 'JPY':
      case 'GBP':
      case 'CNY':
        return 'common'
      default:
        if (currency.code === '') return 'custom'
        return 'other'
    }
  }
  const t = useTranslations('Currencies')
  const currenciesByGroup = currencies.reduce<Record<string, Currency[]>>(
    (acc, currency) => ({
      ...acc,
      [currencyGroup(currency)]: (acc[currencyGroup(currency)] ?? []).concat([
        currency,
      ]),
    }),
    {},
  )

  return (
    <Command>
      <CommandInput placeholder={t('search')} className="text-base" />
      <CommandList>
        <CommandEmpty>{t('noCurrency')}</CommandEmpty>
        {Object.entries(currenciesByGroup).map(
          ([group, groupCurrencies], index) => (
            <CommandGroup key={index} heading={t(`${group}.heading`)}>
              {groupCurrencies.map((currency) => (
                <CommandItem
                  key={currency.code}
                  value={`${currency.code} ${currency.name} ${currency.symbol}`}
                  onSelect={(currentValue) => {
                    onValueChange(currency.code)
                  }}
                >
                  <CurrencyLabel currency={currency} />
                </CommandItem>
              ))}
            </CommandGroup>
          ),
        )}
      </CommandList>
    </Command>
  )
}

type CurrencyButtonProps = {
  compact?: boolean
  currency: Currency
  open: boolean
  isLoading: boolean
}
const CurrencyButton = forwardRef<HTMLButtonElement, CurrencyButtonProps>(
  (
    {
      currency,
      open,
      isLoading,
      compact,
      ...props
    }: ButtonProps & CurrencyButtonProps,
    ref,
  ) => {
    const iconClassName = 'h-4 w-4 shrink-0 opacity-60'
    return (
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className={cn(
          'flex w-full min-w-0 justify-between gap-3 px-3',
          compact && 'h-12 w-28 border-s-0 bg-card',
        )}
        ref={ref}
        {...props}
      >
        {compact ? (
          <span>{currency.code}</span>
        ) : (
          <CurrencyLabel currency={currency} />
        )}
        {isLoading ? (
          <Loader2 className={`animate-spin ${iconClassName}`} />
        ) : (
          <ChevronDown className={iconClassName} />
        )}
      </Button>
    )
  },
)
CurrencyButton.displayName = 'CurrencyButton'

function CurrencyLabel({ currency }: { currency: Currency }) {
  return (
    <div className="min-w-0 truncate text-start">
      {currency.name}
      {currency.code ? ` (${currency.code})` : ''}
    </div>
  )
}
