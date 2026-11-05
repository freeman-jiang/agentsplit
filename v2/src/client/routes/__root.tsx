import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <div className="mx-auto min-h-dvh max-w-5xl px-4 py-6 text-stone-900">
      <header className="mb-6 flex items-center justify-between">
        <Link to="/" className="text-lg font-semibold">
          AgentSplit
        </Link>
      </header>
      <Outlet />
    </div>
  ),
})
