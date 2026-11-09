import { Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { saveTheme } from '~/client/theme'
import { Button } from '~/client/ui/button'

// public/theme.js applies the theme as the `dark` class on <html>, also when the
// system scheme or another tab changes it, so the class is the one source.
const root = () => document.documentElement
const isDark = () => root().classList.contains('dark')
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(root(), { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

/** The top bar's switch between light and dark. Settings keeps the third choice, System. */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark)
  function toggle() {
    const next = dark ? 'light' : 'dark'
    // A short cross-fade of the page (styles.css), where the browser has view transitions and motion is allowed.
    if ('startViewTransition' in document && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(() => saveTheme(next))
    } else {
      saveTheme(next)
    }
  }
  return (
    <Button variant="ghost" size="icon" className="relative size-9" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
      <Sun className="size-4 transition-transform duration-200 ease-out motion-reduce:transition-none dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute size-4 rotate-90 scale-0 transition-transform duration-200 ease-out motion-reduce:transition-none dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
