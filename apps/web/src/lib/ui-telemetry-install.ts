import { postApiV1TelemetryUi } from '@ainyc/canonry-api-client'
import type { TelemetryEventAcceptedDto, UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { heyClient, isEmbed, isPublicDemo } from '../api.js'
import {
  configureUiTelemetry,
  recordUiApiResult,
  recordUiError,
  recordUiSearchParamsChange,
  recordUiVital,
  setUiPageFromRoute,
} from './ui-telemetry.js'

/**
 * Wire dashboard usage telemetry once, from `main.tsx`: the sender, the API
 * interceptors that turn writes into `ui.action` and failures into `ui.error`,
 * uncaught-error handlers, and web vitals. Tests never import this file, so
 * the rest of the suite sends nothing.
 */
let installed = false

/**
 * keepalive lets the request outlive the page, so vitals flushed on pagehide /
 * visibilitychange-hidden are still delivered. The generated client spreads
 * its options into the Request init, so the flag reaches fetch.
 */
export async function sendUiTelemetryEvent(event: UiTelemetryEvent): Promise<TelemetryEventAcceptedDto | undefined> {
  const result = await postApiV1TelemetryUi({ client: heyClient, body: event, keepalive: true })
  return result.data as TelemetryEventAcceptedDto | undefined
}

export function installUiTelemetry(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  // An embed render is a client's read-only view and the public demo is sample
  // data: neither is the operator using Canonry.
  if (isEmbed() || isPublicDemo()) return

  configureUiTelemetry({ send: sendUiTelemetryEvent })

  // Every generated call carries its route TEMPLATE in `opts.url`
  // (`/api/v1/projects/{name}/runs`), never the real path, so usage and
  // failures are attributed without a project name ever leaving the page.
  heyClient.interceptors.request.use((request, opts) => {
    const original = opts.fetch ?? globalThis.fetch
    const template = typeof opts.url === 'string' ? opts.url : undefined
    opts.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        return await original(input, init)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          recordUiApiResult({ method: request.method, route: template, network: true })
        }
        throw error
      }
    }
    return request
  })
  heyClient.interceptors.response.use((response, request, opts) => {
    recordUiApiResult({
      method: request.method,
      route: typeof opts.url === 'string' ? opts.url : undefined,
      // Read locally only, to resolve a closed enum (e.g. a Google connection type).
      path: safePathname(request.url),
      status: response.status,
    })
    return response
  })

  window.addEventListener('error', (event) => {
    recordUiError({ kind: 'unhandled', error: event.error })
  })
  window.addEventListener('unhandledrejection', (event) => {
    recordUiError({ kind: 'unhandled', error: event.reason })
  })

  observeWebVitals()
}

/** Called whenever a router is (re)built. Page views follow resolved navigations. */
export function attachUiTelemetryRouter(router: {
  subscribe: (event: 'onResolved', fn: () => void) => () => void
  state: {
    matches: ReadonlyArray<{ fullPath?: string }>
    location?: { pathname: string; search: unknown }
  }
}): () => void {
  let previous: { pathname: string; search: Record<string, unknown> } | null = null
  const report = () => {
    const leaf = router.state.matches.at(-1)
    // A router that has not resolved yet has no matches: that is not a page.
    if (!leaf) return
    setUiPageFromRoute(leaf.fullPath)
    // Shared filters live in the URL: a change of them on the SAME page is a
    // filter change. Navigating elsewhere with the params carried is not.
    const location = router.state.location
    if (!location) return
    const search = location.search && typeof location.search === 'object' ? location.search as Record<string, unknown> : {}
    if (previous && previous.pathname === location.pathname) recordUiSearchParamsChange(previous.search, search)
    previous = { pathname: location.pathname, search }
  }
  report()
  return router.subscribe('onResolved', report)
}

type Rating = 'good' | 'needs-improvement' | 'poor'

function safePathname(url: string): string | undefined {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return undefined
  }
}

/** web.dev thresholds: [good at or below, poor above]. */
const THRESHOLDS = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
} as const

export function rateVital(metric: keyof typeof THRESHOLDS, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric]
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
}

interface LayoutShift { startTime: number; value: number; hadRecentInput: boolean }

/**
 * CLS as web-vitals defines it: shifts are grouped into session windows (each
 * shift less than 1s after the previous one, the window under 5s long), shifts
 * right after input are excluded, and CLS is the LARGEST window, not the sum
 * of every shift on the page.
 */
export function createClsAccumulator(): { add: (shift: LayoutShift) => void; value: () => number } {
  let max = 0
  let current = 0
  let windowStart = -Infinity
  let last = -Infinity
  return {
    add(shift) {
      if (shift.hadRecentInput) return
      if (shift.startTime - last < 1_000 && shift.startTime - windowStart < 5_000) {
        current += shift.value
      } else {
        current = shift.value
        windowStart = shift.startTime
      }
      last = shift.startTime
      max = Math.max(max, current)
    },
    value: () => max,
  }
}

/**
 * INP: the slowest interaction. Only event-timing entries with a non-zero
 * `interactionId` are interactions; hovers and other non-interaction events
 * also produce entries and must not count.
 */
export function createInpAccumulator(): { add: (entry: { duration: number; interactionId?: number }) => void; value: () => number } {
  let max = 0
  return {
    add(entry) {
      if (!entry.interactionId) return
      max = Math.max(max, entry.duration)
    },
    value: () => max,
  }
}

/**
 * Once per metric per page load, from PerformanceObserver (no extra
 * dependency). TTFB and FCP are final as soon as observed; LCP, CLS and INP
 * settle when the page is hidden. `recordUiVital` attributes all of them to
 * the page this document landed on.
 */
function observeWebVitals(): void {
  if (typeof PerformanceObserver === 'undefined') return
  const sent = new Set<string>()
  const send = (metric: keyof typeof THRESHOLDS, value: number) => {
    if (sent.has(metric) || !Number.isFinite(value)) return
    sent.add(metric)
    recordUiVital(metric, rateVital(metric, value))
  }
  const observe = (type: string, fn: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver(list => fn(list.getEntries())).observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
    } catch { /* entry type not supported in this browser */ }
  }

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (nav && nav.responseStart > 0) send('TTFB', nav.responseStart)
  } catch { /* ignore */ }

  observe('paint', entries => {
    const fcp = entries.find(e => e.name === 'first-contentful-paint')
    if (fcp) send('FCP', fcp.startTime)
  })

  let lcp = 0
  observe('largest-contentful-paint', entries => {
    const last = entries.at(-1)
    if (last) lcp = last.startTime
  })

  const cls = createClsAccumulator()
  observe('layout-shift', entries => {
    for (const entry of entries as Array<PerformanceEntry & Partial<LayoutShift>>) {
      cls.add({ startTime: entry.startTime, value: entry.value ?? 0, hadRecentInput: entry.hadRecentInput === true })
    }
  })

  const inp = createInpAccumulator()
  observe('event', entries => {
    for (const entry of entries as Array<PerformanceEntry & { interactionId?: number }>) inp.add(entry)
  }, { durationThreshold: 40 })

  const flush = () => {
    if (lcp > 0) send('LCP', lcp)
    send('CLS', cls.value())
    if (inp.value() > 0) send('INP', inp.value())
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
}
