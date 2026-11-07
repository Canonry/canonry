import { UI_PAGE_TIME_MAX_MS, uiPageFromRoutePath, type UiPage } from '@canonry/canonry-contracts'
import { createUuid } from './onboarding-telemetry.js'
import { trackUiPageTime } from './ui-telemetry.js'

const IDLE_MS = 60_000
const CHECKPOINT_MS = 60_000
const TICK_MS = 10_000
// A suspended browser cannot tell us whether a person was still looking.
const MAX_GAP_MS = 30_000

/** One document timer. Raw paths are compared locally and never emitted. */
export function installUiPageTime(): { navigate: (fullPath: string | undefined, pathname?: string) => void; clear: () => void; stop: () => void } {
  let stopped = false
  let page: UiPage | null = null
  let path: string | undefined
  let visit: { id: string; foregroundMs: number; activeMs: number } | null = null
  let at = performance.now()
  let wallAt = Date.now()
  let lastActivity = at
  let checkpointAt = at
  let foreground = document.visibilityState === 'visible' && document.hasFocus()
  let lastSentMs = 0

  const account = () => {
    const now = performance.now()
    const wall = Date.now()
    const elapsed = now - at
    if (visit && foreground && elapsed >= 0 && elapsed <= MAX_GAP_MS && wall - wallAt <= MAX_GAP_MS) {
      const remaining = UI_PAGE_TIME_MAX_MS - visit.foregroundMs
      const counted = Math.min(elapsed, remaining)
      visit.foregroundMs += counted
      visit.activeMs += Math.min(counted, Math.max(0, lastActivity + IDLE_MS - at))
    }
    at = now
    wallAt = wall
  }
  const checkpoint = (completed = false) => {
    if (!visit || !page || visit.foregroundMs < 1) return
    if (!completed && Math.floor(visit.foregroundMs) === lastSentMs) return
    lastSentMs = Math.floor(visit.foregroundMs)
    checkpointAt = at
    trackUiPageTime({
      event: 'ui.page_time', page, visitId: visit.id,
      foregroundMs: lastSentMs, activeMs: Math.floor(visit.activeMs), completed,
    })
  }
  const begin = () => {
    visit = { id: createUuid(), foregroundMs: 0, activeMs: 0 }
    lastSentMs = 0
    checkpointAt = at
    lastActivity = at
  }
  const visibility = () => {
    account()
    const next = document.visibilityState === 'visible' && document.hasFocus()
    if (foreground && !next) checkpoint()
    if (!foreground && next) lastActivity = at
    foreground = next
  }
  const activity = () => {
    account()
    if (foreground) lastActivity = at
  }
  const leave = () => {
    account()
    checkpoint(true)
    visit = null
    foreground = false
  }
  const resume = () => {
    visibility()
    if (page && !visit) begin()
  }
  const timer = window.setInterval(() => {
    account()
    if (at - checkpointAt >= CHECKPOINT_MS) checkpoint()
  }, TICK_MS)
  const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'] as const
  for (const event of activityEvents) document.addEventListener(event, activity, { passive: true, capture: true })
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('focus', visibility)
  window.addEventListener('blur', visibility)
  window.addEventListener('pagehide', leave)
  window.addEventListener('pageshow', resume)

  return {
    clear() {
      // Authentication or router teardown must not charge the sign-in screen.
      visit = null
      page = null
      path = undefined
    },
    navigate(fullPath, pathname) {
      if (stopped) return
      const next = uiPageFromRoutePath(fullPath)
      if (page === next && path === pathname && visit) return
      account()
      checkpoint(true)
      page = next
      path = pathname
      foreground = document.visibilityState === 'visible' && document.hasFocus()
      begin()
    },
    stop() {
      // Consent refusal discards counters. It must never flush a final event.
      stopped = true
      visit = null
      window.clearInterval(timer)
      for (const event of activityEvents) document.removeEventListener(event, activity, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', visibility)
      window.removeEventListener('blur', visibility)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('pageshow', resume)
    },
  }
}
