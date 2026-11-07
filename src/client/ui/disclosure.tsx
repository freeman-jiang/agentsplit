import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '~/client/cn'

/** Put this on the `<details>`, so the summary's chevron turns when it opens. */
export const disclosure = 'group/disclosure'

/**
 * The one `<summary>` style: no browser marker, and a chevron that turns when
 * the `<details>` opens. `quiet` is the small inline form, with the chevron first.
 */
export function DisclosureSummary(props: { children: ReactNode; className?: string; quiet?: boolean }) {
  return (
    <summary
      className={cn(
        'flex cursor-pointer list-none items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden',
        props.quiet ? 'w-fit gap-1 text-xs text-muted-foreground hover:text-foreground' : 'min-h-11 justify-between text-sm font-medium',
        props.className,
      )}
    >
      {props.quiet && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/disclosure:rotate-90" />}
      <span className="min-w-0">{props.children}</span>
      {!props.quiet && <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-180" />}
    </summary>
  )
}
