import { postApiV1TelemetryUi } from '@ainyc/canonry-api-client'
import type { TelemetryEventAcceptedDto } from '@ainyc/canonry-contracts'
import { heyClient, isEmbed, isPublicDemo } from '../api.js'
import {
  configureUiTelemetry,
  recordUiApiResult,
  recordUiError,
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

export function installUiTelemetry(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  // An embed render is a client's read-only view and the public demo is sample
  // data: neither is the operator using Canonry.
  if (isEmbed() || isPublicDemo()) return

  configureUiTelemetry({
    send: async (event) => {
      const result = await postApiV1TelemetryUi({ client: heyClient, body: event })
      return result.data as TelemetryEventAcceptedDto | undefined
    },
  })

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
  state: { matches: ReadonlyArray<{ fullPath?: string }> }
}): () => void {
  const report = () => {
    const leaf = router.state.matches.at(-1)
    // A router that has not resolved yet has no matches: that is not a page.
    if (leaf) setUiPageFromRoute(leaf.fullPath)
  }
  report()
  return router.subscribe('onResolved', report)
}

type Rating = 'good' | 'needs-improvement' | 'poor'

/** web.dev thresholds: [good at or below, poor above]. */
const THRESHOLDS = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
} as const

function rate(metric: keyof typeof THRESHOLDS, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric]
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
}

/**
 * Once per metric per page load, from PerformanceObserver (no extra
 * dependency). LCP, CLS and INP settle when the page is hidden; FCP and TTFB
 * are final as soon as they are observed.
 */
function observeWebVitals(): void {
  if (typeof PerformanceObserver === 'undefined') return
  const sent = new Set<string>()
  const send = (metric: keyof typeof THRESHOLDS, value: number) => {
    if (sent.has(metric) || !Number.isFinite(value)) return
    sent.add(metric)
    recordUiVital(metric, rate(metric, value))
  }
  const observe = (type: string, fn: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver(list => fn(list.getEntries())).observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
    } catch { /* entry type not supported in this browser */ }
  }

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (nav) send('TTFB', nav.responseStart)
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

  let cls = 0
  observe('layout-shift', entries => {
    for (const entry of entries as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
      if (!entry.hadRecentInput) cls += entry.value ?? 0
    }
  })

  let inp = 0
  observe('event', entries => {
    for (const entry of entries) inp = Math.max(inp, entry.duration)
  }, { durationThreshold: 40 })

  const flush = () => {
    if (lcp > 0) send('LCP', lcp)
    send('CLS', cls)
    if (inp > 0) send('INP', inp)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
}
