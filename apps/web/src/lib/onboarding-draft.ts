/** Only non-secret form inputs survive a reload, for this tab and install. */
export interface OnboardingDraft {
  domain?: string
  projectName?: string
  displayName?: string
  country?: string
  language?: string
  queriesText?: string
  competitorsText?: string
}

const FIELDS = ['domain', 'projectName', 'displayName', 'country', 'language', 'queriesText', 'competitorsText'] as const

function storageKey(scope: string): string {
  return `canonry.onboarding-draft.v1:${window.__CANONRY_CONFIG__?.basePath ?? '/'}:${scope}`
}

export function readOnboardingDraft(scope: string): OnboardingDraft {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey(scope)) ?? '{}')
    if (!raw || typeof raw !== 'object') return {}
    const draft: OnboardingDraft = {}
    for (const key of FIELDS) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length <= 50_000) draft[key] = value
    }
    return draft
  } catch {
    return {}
  }
}

export function writeOnboardingDraft(scope: string, draft: OnboardingDraft): void {
  try {
    const safe: OnboardingDraft = {}
    for (const key of FIELDS) {
      const value = draft[key]
      if (typeof value === 'string' && value.length <= 50_000) safe[key] = value
    }
    // A public domain field can receive a pasted private URL. Never retain its
    // credentials, token-bearing query string, or fragment in browser storage.
    if (safe.domain && /[?#@]/.test(safe.domain)) delete safe.domain
    window.sessionStorage.setItem(storageKey(scope), JSON.stringify(safe))
  } catch {
    // Storage can be disabled. Editing and saving still work in memory.
  }
}

export function clearOnboardingDraft(scope: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(scope))
  } catch {
    // Reset still clears the form when storage is unavailable.
  }
}

export function markOnboardingScanSkipped(projectName: string): void {
  try {
    window.sessionStorage.setItem(storageKey(`scan-skipped:${projectName}`), 'true')
  } catch {
    // This is a local navigation preference, never evidence of a scan result.
  }
}

export function wasOnboardingScanSkipped(projectName: string): boolean {
  try {
    return window.sessionStorage.getItem(storageKey(`scan-skipped:${projectName}`)) === 'true'
  } catch {
    return false
  }
}
