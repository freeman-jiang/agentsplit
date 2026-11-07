// The theme preference, kept in this browser. public/theme.js applies it before the first paint.
export type Theme = 'system' | 'light' | 'dark'
const THEME_KEY = 'theme'

export function readTheme(): Theme {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** Saves the theme and applies it at once. */
export function saveTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme)
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
