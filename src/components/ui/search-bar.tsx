import * as React from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslations } from 'next-intl'
import { Search, XCircle } from 'lucide-react'

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  onValueChange?: (value: string) => void
}

const SearchBar = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onValueChange, ...props }, ref) => {
    const t = useTranslations('Expenses')
    const [value, _setValue] = React.useState('')

    const setValue = (v: string) => {
      _setValue(v)
      onValueChange && onValueChange(v)
    }

    return (
      <div className="relative flex min-w-0">
        <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type={type}
          className={cn(
            'h-11 ps-10 pe-11 text-base sm:text-sm bg-card text-foreground',
            className,
          )}
          ref={ref}
          placeholder={t("searchPlaceholder")}
          aria-label={t('searchLabel')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...props}
        />
        {value && (
          <button type="button" aria-label={t('clearSearch')} className="absolute end-0 top-0 flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => setValue('')}>
            <XCircle aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  },
)
SearchBar.displayName = 'SearchBar'

export { SearchBar }
