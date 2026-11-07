// The theme preference, kept in this browser. public/theme.js applies it before the first paint.
export type Theme = 'system' | 'light' | 'dark'
const THEME_KEY = 'theme'

/** A stored or chosen value as a theme; anything else is the default, 'system'. */
const themeOf = (value: string | null): Theme => (value === 'light' || value === 'dark' ? value : 'system')

export const readTheme = () => themeOf(localStorage.getItem(THEME_KEY))

export function saveTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme)
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
