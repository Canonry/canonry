import {
  isUiApiRouteTemplate,
  UI_ERROR_NAME_PATTERN,
  uiPageFromRoutePath,
  uiProjectTabFromPage,
  type UiAction,
  type UiIntegration,
  type UiPage,
  type UiProjectTab,
  type UiTelemetryEvent,
} from '@ainyc/canonry-contracts'

/**
 * Dashboard usage telemetry: page views, feature actions, UI errors and web
 * vitals, sent to the local API (`POST /api/v1/telemetry/ui`), which forwards
 * them through the same opt-in anonymous path as CLI events.
 *
 * Pure on purpose: it imports nothing from `api.ts`, so `api.ts` can call
 * `trackUiAction` without an import cycle. `ui-telemetry-install.ts` wires the
 * sender, the API interceptors and the browser hooks once, from `main.tsx`.
 * Until it is configured every call is a no-op, which keeps tests and embed /
 * demo renders silent.
 *
 * Never throws into the UI, never sends free text: pages are route patterns,
 * API failures are route templates, errors are class names.
 */

type Sender = (event: UiTelemetryEvent) => Promise<{ accepted?: boolean } | undefined | void>

type Distribute<T> = T extends unknown ? Omit<T, 'eventId' | 'uiSessionId' | 'page' | 'tab'> : never
type PendingEvent = Distribute<UiTelemetryEvent>

const SESSION_KEY = 'canonry.ui-session.v1'
const PAGES_KEY = 'canonry.ui-pages.v1'
const ERRORS_KEY = 'canonry.ui-errors.v1'
/** Hard cap per browser tab, so a render loop cannot flood the collector. */
export const UI_TELEMETRY_MAX_PER_MINUTE = 30
const MAX_REMEMBERED_KEYS = 200

const state = {
  sender: null as Sender | null,
  disabled: false,
  page: 'other' as UiPage,
  sentAt: [] as number[],
  memory: new Map<string, Set<string>>(),
  now: () => Date.now(),
}

export function configureUiTelemetry(options: { send: Sender; enabled?: boolean; now?: () => number }): void {
  state.sender = options.enabled === false ? null : options.send
  state.disabled = false
  if (options.now) state.now = options.now
}

/** Test-only: forget configuration, throttling and dedupe memory. */
export function resetUiTelemetryForTests(): void {
  state.sender = null
  state.disabled = false
  state.page = 'other'
  state.sentAt = []
  state.memory.clear()
  state.now = () => Date.now()
  try {
    for (const key of [SESSION_KEY, PAGES_KEY, ERRORS_KEY]) window.sessionStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

export function currentUiPage(): UiPage {
  return state.page
}

/** Called on every resolved navigation with the leaf route's `fullPath`. */
export function setUiPageFromRoute(fullPath: string | undefined | null): void {
  const page = uiPageFromRoutePath(fullPath)
  state.page = page
  const tab = uiProjectTabFromPage(page)
  if (!rememberOnce(PAGES_KEY, `${page}|${tab ?? ''}`)) return
  emit({ event: 'ui.page_viewed' })
}

export function trackUiAction(action: UiAction, detail: { integration?: UiIntegration; format?: 'csv' | 'json' | 'html' } = {}): void {
  emit({ event: 'ui.action', action, ...detail })
}

export interface UiErrorInput {
  kind: 'render' | 'unhandled' | 'api'
  error?: unknown
  component?: string
  route?: string
  method?: string
  status?: number
  network?: boolean
}

export function recordUiError(input: UiErrorInput): void {
  const errorName = errorNameOf(input.error)
  const route = input.route && isUiApiRouteTemplate(input.route) ? input.route : undefined
  if (input.kind === 'api' && !route) return
  const method = normalizeMethod(input.method)
  const status = typeof input.status === 'number' && input.status >= 400 && input.status <= 599 ? input.status : undefined
  const statusClass = input.network ? 'network' as const
    : status === undefined ? undefined
      : status >= 500 ? '5xx' as const : '4xx' as const
  const component = input.component && /^[a-z][a-z0-9-]{0,39}$/.test(input.component) ? input.component : undefined
  const key = [input.kind, state.page, component, errorName, method, route, status ?? statusClass].join('|')
  if (!rememberOnce(ERRORS_KEY, key)) return
  emit({
    event: 'ui.error',
    kind: input.kind,
    ...(component ? { component } : {}),
    ...(errorName ? { errorName } : {}),
    ...(route ? { route } : {}),
    ...(method ? { method } : {}),
    ...(statusClass ? { statusClass } : {}),
    ...(status ? { status } : {}),
  })
}

export function recordUiVital(metric: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB', rating: 'good' | 'needs-improvement' | 'poor'): void {
  emit({ event: 'ui.vitals', metric, rating })
}

/**
 * The feature a successful dashboard write stands for, keyed by the generated
 * client's route TEMPLATE. One table instead of a call at every button: every
 * write path (invokeWeb, generated TanStack mutations) goes through heyClient.
 */
const ACTION_BY_ROUTE: ReadonlyArray<readonly [method: string, template: string, action: UiAction, integration?: UiIntegration]> = [
  ['POST', '/api/v1/projects/{name}/runs', 'sweep.launch'],
  ['POST', '/api/v1/runs/{id}/cancel', 'sweep.cancel'],
  ['POST', '/api/v1/projects/{name}/technical-aeo/runs', 'site_audit.launch'],
  ['POST', '/api/v1/projects', 'project.create'],
  ['PUT', '/api/v1/projects/{name}', 'project.update'],
  ['DELETE', '/api/v1/projects/{name}', 'project.delete'],
  ['POST', '/api/v1/projects/{name}/queries', 'query.add'],
  ['PUT', '/api/v1/projects/{name}/queries', 'query.add'],
  ['DELETE', '/api/v1/projects/{name}/queries', 'query.delete'],
  ['DELETE', '/api/v1/projects/{name}/queries/{id}', 'query.delete'],
  ['POST', '/api/v1/projects/{name}/queries/generate', 'query.generate'],
  ['PUT', '/api/v1/projects/{name}/competitors', 'competitor.save'],
  ['POST', '/api/v1/projects/{name}/competitors', 'competitor.save'],
  ['DELETE', '/api/v1/projects/{name}/competitors/{id}', 'competitor.delete'],
  ['PUT', '/api/v1/projects/{name}/schedule', 'schedule.save'],
  ['DELETE', '/api/v1/projects/{name}/schedule', 'schedule.delete'],
  ['PUT', '/api/v1/settings/providers/{name}', 'provider.save'],
  ['PUT', '/api/v1/settings/google', 'settings.save'],
  ['PUT', '/api/v1/settings/bing', 'settings.save'],
  ['PUT', '/api/v1/settings/cdp', 'settings.save'],
  ['PUT', '/api/v1/projects/{name}/sentiment/settings', 'settings.save'],
  ['POST', '/api/v1/projects/{name}/google/connect', 'integration.connect', 'google'],
  ['DELETE', '/api/v1/projects/{name}/google/connections/{type}', 'integration.disconnect', 'google'],
  ['POST', '/api/v1/projects/{name}/ga/connect', 'integration.connect', 'ga'],
  ['DELETE', '/api/v1/projects/{name}/ga/disconnect', 'integration.disconnect', 'ga'],
  ['POST', '/api/v1/projects/{name}/bing/connect', 'integration.connect', 'bing'],
  ['DELETE', '/api/v1/projects/{name}/bing/disconnect', 'integration.disconnect', 'bing'],
  // GBP authorizes through the Google OAuth connect; choosing a location completes it.
  ['PUT', '/api/v1/projects/{name}/gbp/locations/{locationName}/selection', 'integration.connect', 'gbp'],
  ['DELETE', '/api/v1/projects/{name}/gbp/connection', 'integration.disconnect', 'gbp'],
  ['POST', '/api/v1/projects/{name}/wordpress/connect', 'integration.connect', 'wordpress'],
  ['DELETE', '/api/v1/projects/{name}/wordpress/disconnect', 'integration.disconnect', 'wordpress'],
  ['POST', '/api/v1/projects/{name}/ads/connect', 'integration.connect', 'openai_ads'],
  ['DELETE', '/api/v1/projects/{name}/ads/connection', 'integration.disconnect', 'openai_ads'],
  ['POST', '/api/v1/projects/{name}/google-ads/oauth/connect', 'integration.connect', 'google_ads'],
  ['DELETE', '/api/v1/projects/{name}/google-ads/connection', 'integration.disconnect', 'google_ads'],
  ['POST', '/api/v1/projects/{name}/gtm/oauth/connect', 'integration.connect', 'gtm'],
  ['DELETE', '/api/v1/projects/{name}/gtm/connection', 'integration.disconnect', 'gtm'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/cloudflare', 'integration.connect', 'traffic_cloudflare'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/vercel', 'integration.connect', 'traffic_vercel'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/cloud-run', 'integration.connect', 'traffic_cloud_run'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/wordpress', 'integration.connect', 'traffic_wordpress'],
  ['POST', '/api/v1/projects/{name}/traffic/sources/{id}/sync', 'traffic.sync'],
  ['POST', '/api/v1/projects/{name}/notifications', 'notification.save'],
  ['POST', '/api/v1/projects/{name}/notifications/{id}/test', 'notification.test'],
  ['POST', '/api/v1/projects/{name}/measurement-plan/draft/actions/publish', 'measurement_plan.publish'],
  ['POST', '/api/v1/projects/{name}/discover/run', 'discovery.run'],
  ['POST', '/api/v1/keys', 'api_key.create'],
  ['POST', '/api/v1/keys/{id}/revoke', 'api_key.revoke'],
]

/** Routes whose own traffic must never feed back into this telemetry. */
const IGNORED_ROUTE = /^\/api\/v1\/(?:telemetry|feedback)(?:\/|$)/

/**
 * Turn one finished dashboard API call into usage: a successful mapped write
 * is a `ui.action`, a 4xx/5xx or network failure is a `ui.error` (`kind: api`).
 */
export function recordUiApiResult(input: { method?: string; route?: string; status?: number; network?: boolean }): void {
  if (!input.route || IGNORED_ROUTE.test(input.route)) return
  const method = normalizeMethod(input.method)
  if (input.network || (typeof input.status === 'number' && input.status >= 400)) {
    // A 401 is session expiry, handled by the login redirect, not a UI defect.
    if (input.status === 401) return
    recordUiError({ kind: 'api', route: input.route, method, status: input.status, network: input.network })
    return
  }
  if (!method || method === 'GET') return
  const match = ACTION_BY_ROUTE.find(([m, template]) => m === method && template === input.route)
  if (match) trackUiAction(match[2], match[3] ? { integration: match[3] } : {})
}

function emit(pending: PendingEvent): void {
  try {
    const sender = state.sender
    if (!sender || state.disabled) return
    if (!allowByRate()) return
    const tab: UiProjectTab | undefined = uiProjectTabFromPage(state.page)
    const event = {
      ...pending,
      eventId: createUuid(),
      uiSessionId: getOrCreateUiSessionId(),
      page: state.page,
      ...(tab ? { tab } : {}),
    } as UiTelemetryEvent
    void sender(event).then(
      result => { if (result && result.accepted === false) state.disabled = true },
      () => { /* best effort: measurement never surfaces an error */ },
    )
  } catch {
    // Never throw into the UI.
  }
}

function allowByRate(): boolean {
  const now = state.now()
  state.sentAt = state.sentAt.filter(at => now - at < 60_000)
  if (state.sentAt.length >= UI_TELEMETRY_MAX_PER_MINUTE) return false
  state.sentAt.push(now)
  return true
}

/** True the first time `value` is seen in this tab session, false after. */
function rememberOnce(storageKey: string, value: string): boolean {
  let seen = state.memory.get(storageKey)
  if (!seen) {
    seen = new Set(readStoredList(storageKey))
    state.memory.set(storageKey, seen)
  }
  if (seen.has(value)) return false
  seen.add(value)
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify([...seen].slice(-MAX_REMEMBERED_KEYS)))
  } catch { /* storage unavailable: in-memory dedupe still holds */ }
  return true
}

function readStoredList(key: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function errorNameOf(error: unknown): string | undefined {
  const name = error instanceof Error ? error.name
    : error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name)
      : undefined
  return name && UI_ERROR_NAME_PATTERN.test(name) ? name : undefined
}

function normalizeMethod(method: string | undefined): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined {
  const upper = method?.toUpperCase()
  return upper === 'GET' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE' ? upper : undefined
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getOrCreateUiSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY)
    if (existing && UUID_PATTERN.test(existing)) return existing
    const id = createUuid()
    window.sessionStorage.setItem(SESSION_KEY, id)
    return id
  } catch {
    return fallbackSessionId ??= createUuid()
  }
}
let fallbackSessionId: string | undefined

function createUuid(): string {
  const cryptoApi = globalThis.crypto as Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>> | undefined
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
