import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

import { getEmbedConfig } from '../api.js'
import { embedThemeMode } from '../embed.js'

type ThemePreference = 'light' | 'dark' | 'system'
interface ThemePreferenceState {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const STORAGE_KEY = 'canonry:theme'
const ThemeContext = createContext<ThemePreferenceState | null>(null)

function storedPreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'system' ? value : 'dark'
}

function readPreference(): ThemePreference {
  try {
    return storedPreference(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'dark'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setState] = useState(readPreference)
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const embed = getEmbedConfig()
  const mode = embed
    ? embedThemeMode(embed.theme) ?? 'dark'
    : preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'light' ? '#ffffff' : '#0a0a0a')
  }, [mode])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return
      } catch {
        return
      }
      setState(storedPreference(event.newValue))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage may be blocked; the selection still applies for this session.
    }
  }, [])
  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useThemePreference(): ThemePreferenceState | null {
  return useContext(ThemeContext)
}
