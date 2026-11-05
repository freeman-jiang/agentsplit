// Service-worker registration, in production builds only. A waiting update is
// offered in a toast; Reload activates it, and the page reloads once when the
// new worker takes control (but not on the first install).
import { toast } from 'sonner'

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000

export async function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const hadController = !!navigator.serviceWorker.controller
  const registration = await navigator.serviceWorker.register('/sw.js')
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return
    refreshing = true
    window.location.reload()
  })
  const promptUpdate = (worker: ServiceWorker) =>
    toast('Update available', {
      description: 'A new version of AgentSplit is available.',
      duration: Infinity,
      action: { label: 'Reload', onClick: () => worker.postMessage('SKIP_WAITING') },
    })
  if (registration.waiting && navigator.serviceWorker.controller) promptUpdate(registration.waiting)
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(worker)
    })
  })
  window.setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update()
  })
}
