import { Monitor, Moon, Sun } from 'lucide-react'

import { useThemePreference } from '../../contexts/theme-context.js'
import { SegmentedRadioGroup } from './SegmentedRadioGroup.js'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: <Sun className="size-3.5" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="size-3.5" /> },
  { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
] as const

export function ThemeSelector() {
  const theme = useThemePreference()
  if (!theme) return null

  return (
    <SegmentedRadioGroup
      label="Color theme"
      options={THEME_OPTIONS}
      value={theme.preference}
      onChange={theme.setPreference}
      className="theme-toggle"
    />
  )
}
