import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorState } from '../components/error-state'
import { groupUrls } from './group-urls'
import { addAppleSplashImages, registerServiceWorker } from './pwa'
import { routeTree } from '../routeTree.gen'
import { AUTH_PATH } from '~/shared/paths'
// Geist, self-hosted: the browser fetches only the subsets a page uses (Latin is 29 KB).
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '../styles.css'

// Every visit refetches its data, as the current app does (P-EXP-20, Freeman 2026-11-05).
// A screen first shows what this tab already holds, then the fresh answer.
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 0, retry: false } } })

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Hovering a link loads its data, so the next screen opens from the cache.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultErrorComponent: ErrorState,
  // /groups/<id>/… and /<slug> stay as the current app has them.
  rewrite: groupUrls,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Better Auth refreshes the session's expiry here; RPC calls only read the session.
void fetch(`${AUTH_PATH}/get-session`, { credentials: 'same-origin' }).catch((error: unknown) => console.error('Session refresh failed', error))
void registerServiceWorker().catch((error: unknown) => console.error('Service worker registration failed', error))

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)

// The startup images are for the next launch from the home screen, so they wait
// until the browser is idle after the first render. Not every browser has
// requestIdleCallback.
// The brand color is index.html's theme-color, which the manifest repeats.
const brand = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content
const splash = () => {
  if (brand) addAppleSplashImages({ icon: '/logo-with-text.png', color: brand })
  else console.error('index.html has no theme-color meta tag, so the iOS startup images are skipped')
}
if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(splash)
else window.setTimeout(splash, 0)
