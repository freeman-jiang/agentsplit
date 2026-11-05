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

/**
 * iOS startup images for the home-screen app (P-PWA-04), ported from the
 * current app's apple-pwa-splash.tsx (ios-pwa-splash by Avadhesh B., MIT).
 * It draws the logo on the brand color at the screen's own size, in portrait
 * and in landscape. Only iOS reads these links, and only iOS has
 * `navigator.standalone`, so other browsers skip the canvas work.
 */
export function addAppleSplashImages(data: { icon: string; color: string }) {
  if (!('standalone' in navigator)) return
  const image = new Image()
  image.addEventListener('load', () => {
    const ratio = window.devicePixelRatio || 1
    const width = image.width / (3 / ratio)
    const height = image.height / (3 / ratio)
    const draw = (canvasWidth: number, canvasHeight: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No 2D canvas for the splash image')
      context.fillStyle = data.color
      context.fillRect(0, 0, canvasWidth, canvasHeight)
      context.drawImage(image, (canvasWidth - width) / 2, (canvasHeight - height) / 2, width, height)
      return canvas.toDataURL('image/png')
    }
    const portrait = { width: screen.width * ratio, height: screen.height * ratio }
    for (const [orientation, href] of [
      ['portrait', draw(portrait.width, portrait.height)],
      ['landscape', draw(portrait.height, portrait.width)],
    ] as const) {
      const link = document.createElement('link')
      link.rel = 'apple-touch-startup-image'
      link.media = `screen and (orientation: ${orientation})`
      link.href = href
      document.head.appendChild(link)
    }
  })
  image.addEventListener('error', () => console.error('Splash icon failed to load', data.icon))
  image.src = data.icon
}
