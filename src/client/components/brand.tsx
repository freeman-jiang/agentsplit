import { cn } from '~/client/cn'

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-display text-xl sm:text-2xl', className)}>
      <span aria-hidden="true" className="brand-mark h-8 w-10 shrink-0 text-primary" />
      <span>AgentSplit</span>
    </span>
  )
}
