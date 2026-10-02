'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { LocaleSwitcher } from './locale-switcher'
import { NativeSelect } from './ui/native-select'

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <section className="space-y-4 border-y py-6">
      <h2 className="text-xl font-medium">Preferences</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="appearance-theme" className="text-sm font-medium">
          Theme
        </label>
        <NativeSelect
          id="appearance-theme"
          className="w-40"
          value={mounted ? (theme ?? 'system') : 'system'}
          disabled={!mounted}
          onChange={(event) => setTheme(event.target.value)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </NativeSelect>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Language</span>
        <LocaleSwitcher />
      </div>
    </section>
  )
}
