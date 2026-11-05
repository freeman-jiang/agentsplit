import { Link } from '@tanstack/react-router'

/** Local initials keep the avatar independent of third-party image requests. */
export function AccountMenu({ name }: { name: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''
  const initials = (first + last).toLocaleUpperCase() || 'U'
  return (
    <Link
      to="/settings"
      aria-label="Profile and settings"
      title={`${name || 'Your profile'} · Settings`}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-sm font-medium text-primary transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <span aria-hidden="true">{initials}</span>
    </Link>
  )
}
