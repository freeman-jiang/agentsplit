import type { LucideIcon } from 'lucide-react'
import { cn } from '~/client/cn'

/**
 * One choice of a few, as buttons in an input-shaped frame: the expense list's
 * sort and the monthly chart's type. An option with an icon shows only the
 * icon, with its label as the name.
 */
export function Segmented<V extends string>(props: {
  label: string
  value: V
  options: ReadonlyArray<{ readonly value: V; readonly label: string; readonly icon?: LucideIcon }>
  onChange: (value: V) => void
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className={cn('inline-flex items-stretch rounded-xl border border-input p-1', props.className)}>
      {props.options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          {...(Icon ? { title: label, 'aria-label': label } : {})}
          onClick={() => props.onChange(value)}
          className={cn(
            'hit-area relative rounded-[0.5rem] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            // On touch an icon option is 44 px wide, so the hit areas of two options do not overlap.
            Icon ? 'flex items-center px-2.5 pointer-coarse:px-3.5' : 'px-3',
            props.value === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : label}
        </button>
      ))}
    </div>
  )
}
