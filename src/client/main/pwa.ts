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
      description: 'Reload to use the new version.',
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
 * The brand mark of public/brand-mark.svg, drawn with the same paths on a
 * 100-unit square of `size` pixels: the temple's pediment, its four columns
 * and its base. Paths, not the SVG file, so no image load can fail.
 */
function brandMark(data: { size: number; ink: string }) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = Math.ceil(data.size)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D canvas for the brand mark')
  context.scale(data.size / 100, data.size / 100)
  context.strokeStyle = data.ink
  context.lineWidth = 6
  context.miterLimit = 2.5
  for (const path of MARK_PATHS) context.stroke(new Path2D(path))
  return canvas
}

/** The paths of public/brand-mark.svg. */
const MARK_PATHS = ['M10 36L50 12L90 36Z', 'M22 46V76M40 46V76M60 46V76M78 46V76', 'M8 86H92'] as const

/**
 * iOS startup images for the home-screen app (P-PWA-04), ported from the
 * current app's apple-pwa-splash.tsx (ios-pwa-splash by Avadhesh B., MIT).
 * It draws the brand mark and the name in the app's ink on its background, at
 * the screen's own size, in portrait and in landscape, as the header shows
 * them. Only iOS reads these links, and only iOS has `navigator.standalone`,
 * so other browsers skip the canvas work.
 */
export async function addAppleSplashImages(data: { background: string; ink: string }) {
  if (!('standalone' in navigator)) return
  const ratio = window.devicePixelRatio || 1
  const font = `400 ${32 * ratio}px "Geist Serif", ui-serif, Georgia, serif`
  await document.fonts.load(font)
  const mark = brandMark({ size: 40 * ratio, ink: data.ink })
  const gap = 8 * ratio
  const draw = (canvasWidth: number, canvasHeight: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvasWidth
    canvas.height = canvasHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas for the splash image')
    context.fillStyle = data.background
    context.fillRect(0, 0, canvasWidth, canvasHeight)
    context.font = font
    context.letterSpacing = `${-0.01 * 32 * ratio}px`
    context.textBaseline = 'middle'
    const left = (canvasWidth - (mark.width + gap + context.measureText('AgentSplit').width)) / 2
    context.drawImage(mark, left, (canvasHeight - mark.height) / 2)
    context.fillStyle = data.ink
    context.fillText('AgentSplit', left + mark.width + gap, canvasHeight / 2)
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
}
