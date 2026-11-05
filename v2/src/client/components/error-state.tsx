import { useMatch, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { Button } from '~/client/ui/button'

/**
 * The fallback of every route without its own error component (P-GROUP-53).
 * As in the current app, the exception message is never shown: it stays in
 * the browser console. Inside a group it renders under the group's tabs.
 * The server returns no request ID, so the reference is made here and logged
 * with the error: a person can quote it, and the console line matches it (P-PWA-36).
 */
export function ErrorState({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const inGroup = useMatch({ from: '/$group', shouldThrow: false }) !== undefined
  const reference = useMemo(() => crypto.randomUUID().slice(0, 8), [error])
  useEffect(() => {
    console.error(`Error reference ${reference}`, error)
  }, [error, reference])
  return (
    <div className={inGroup ? 'space-y-4 py-10 text-center' : 'mx-auto max-w-lg space-y-4 px-4 py-16 text-center'} role="alert">
      <h2 className="text-xl font-semibold">{inGroup ? 'Couldn’t load this group' : 'Something went wrong'}</h2>
      <p className="text-sm text-muted-foreground">Please try again. If this keeps happening, reload the page.</p>
      <p className="font-mono text-xs text-muted-foreground" data-testid="error-reference">
        Reference: {reference}
      </p>
      <Button
        type="button"
        onClick={() => {
          // Reload the route data before resetting, so a failed load is not rendered again.
          void router.invalidate().then(reset)
        }}
      >
        Try again
      </Button>
    </div>
  )
}
