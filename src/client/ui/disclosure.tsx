import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '~/client/cn'

/** The chevron turns when its own `<details>` opens, so a disclosure inside another keeps its state. */
const OPEN_DOWN = 'transition-transform [details[open]>summary_&]:rotate-180'
const OPEN_RIGHT = 'transition-transform [details[open]>summary_&]:rotate-90'

/**
 * The one `<summary>` style: no browser marker, and a chevron that turns when
 * the `<details>` opens. `quiet` is the small inline form, with the chevron first.
 * `hint` is a small muted word beside the chevron, such as "Details".
 */
export function DisclosureSummary(props: { children: ReactNode; className?: string; quiet?: boolean; hint?: string }) {
  const down = <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground', OPEN_DOWN)} />
  return (
    <summary
      className={cn(
        'flex cursor-pointer list-none items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden',
        props.quiet ? 'w-fit gap-1 text-xs text-muted-foreground hover:text-foreground' : 'min-h-11 justify-between text-sm font-medium',
        props.className,
      )}
    >
      {props.quiet && <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', OPEN_RIGHT)} />}
      <span className="min-w-0">{props.children}</span>
      {!props.quiet &&
        (props.hint ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {props.hint}
            {down}
          </span>
        ) : (
          down
        ))}
    </summary>
  )
}
