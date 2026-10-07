import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import { forwardRef, SelectHTMLAttributes } from 'react'

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  /** Optional compact display; the native option menu keeps complete labels. */
  displayValue?: string
  wrapperClassName?: string
}

export const NativeSelect = forwardRef<HTMLSelectElement, Props>(
  ({ className, wrapperClassName, displayValue, children, ...props }, ref) => (
    <div className={cn('relative min-w-0', wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          'h-10 w-full min-w-0 appearance-none rounded-none border border-input bg-card ps-3 pe-10 text-base text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm [&_option]:bg-card [&_option]:text-foreground [&_optgroup]:bg-card [&_optgroup]:text-foreground',
          displayValue !== undefined && 'text-transparent',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {displayValue !== undefined && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-foreground">
          {displayValue}
        </span>
      )}
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  ),
)
NativeSelect.displayName = 'NativeSelect'
