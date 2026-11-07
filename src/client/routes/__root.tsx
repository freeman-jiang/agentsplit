import type { QueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import { AccountMenu } from '~/client/components/account-menu'
import { Brand } from '~/client/components/brand'
import { useDocumentTitle } from '~/client/components/page-title'
import { meQuery } from '~/client/queries'
import { cn } from '~/client/cn'
import { Button } from '~/client/ui/button'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
})

function Root() {
  useDocumentTitle()
  const { data: me } = useQuery(meQuery)
  // Group pages live at /$group, outside /groups, so they mark Groups themselves.
  const inGroup = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === '/$group') })
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b bg-background/95 px-4 py-3 backdrop-blur-sm sm:px-8">
        {/* min-h-10 matches the avatar, so the header keeps its height after sign-in. */}
        <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <Link className="flex items-center gap-2" to="/">
            <Brand />
          </Link>
          {me && (
            <>
              <nav aria-label="Workspace" className="col-span-full row-start-2 flex flex-wrap gap-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-end">
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'bg-accent text-accent-foreground' }}>
                    Dashboard
                  </Link>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/groups" className={cn(inGroup && 'bg-accent text-accent-foreground')} activeProps={{ className: 'bg-accent text-accent-foreground' }}>
                    Groups
                  </Link>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/agents" activeProps={{ className: 'bg-accent text-accent-foreground' }}>
                    Agents
                  </Link>
                </Button>
              </nav>
              <div className="col-start-2 row-start-1 flex justify-end sm:col-start-3">
                <AccountMenu name={me.name} />
              </div>
            </>
          )}
        </div>
      </header>
      <div className="flex flex-1 flex-col">
        <Outlet />
      </div>
      <footer className="mt-16 flex flex-col gap-2 px-4 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>
          <span className="font-medium text-foreground">AgentSplit</span> · A little less keeping track. ·{' '}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy
          </Link>
        </p>
        <p>Built on Spliit, by Sebastien Castiel and contributors.</p>
      </footer>
      <Toaster position="bottom-center" />
    </div>
  )
}
