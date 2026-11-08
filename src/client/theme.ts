// The theme preference. public/theme.js owns its storage and applies it before
// the first paint; this module gives it a type.
export type Theme = 'system' | 'light' | 'dark'

declare global {
  interface Window {
    readonly agentsplitTheme: { readonly read: () => Theme; readonly save: (theme: Theme) => void }
  }
}

export const readTheme = () => window.agentsplitTheme.read()

export const saveTheme = (theme: Theme) => window.agentsplitTheme.save(theme)
