import {
  isUiApiRouteTemplate,
  UI_COMPONENT_PATTERN,
  UI_ERROR_NAME_PATTERN,
  uiPageFromRoutePath,
  uiProjectTabFromPage,
  type UiAction,
  type UiFilter,
  type UiIntegration,
  type UiPage,
  type UiProjectTab,
  type UiTelemetryEvent,
} from '@ainyc/canonry-contracts'
import { createUuid, getOrCreateTabSessionId } from './onboarding-telemetry.js'

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
type VitalMetric = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'
type VitalRating = 'good' | 'needs-improvement' | 'poor'

const SESSION_KEY = 'canonry.ui-session.v1'
const PAGES_KEY = 'canonry.ui-pages.v1'
const ERRORS_KEY = 'canonry.ui-errors.v1'
const SENT_KEY = 'canonry.ui-sent.v1'
/** Hard caps per browser tab, so a render loop cannot flood the collector. */
export const UI_TELEMETRY_MAX_PER_MINUTE = 30
/** Persisted in sessionStorage, so reloading the tab does not reset it. */
export const UI_TELEMETRY_MAX_PER_HOUR = 120
const MAX_REMEMBERED_KEYS = 200

const state = {
  sender: null as Sender | null,
  disabled: false,
  page: 'other' as UiPage,
  /** The page this document loaded on: load metrics belong to it, whatever is open later. */
  landingPage: null as UiPage | null,
  pendingVitals: [] as Array<[VitalMetric, VitalRating]>,
  memory: new Map<string, Set<string>>(),
  sentAt: null as number[] | null,
  now: () => Date.now(),
}

export function configureUiTelemetry(options: { send: Sender; enabled?: boolean; now?: () => number }): void {
  state.sender = options.enabled === false ? null : options.send
  state.disabled = false
  if (options.now) state.now = options.now
}

/**
 * Test-only: forget configuration, throttling, dedupe memory and the landing
 * page. `keepStorage` simulates a reload: memory goes, sessionStorage stays.
 */
export function resetUiTelemetryForTests(options: { keepStorage?: boolean } = {}): void {
  state.sender = null
  state.disabled = false
  state.page = 'other'
  state.landingPage = null
  state.pendingVitals = []
  state.memory.clear()
  state.sentAt = null
  state.now = () => Date.now()
  for (const timer of filterTimers.values()) clearTimeout(timer)
  filterTimers.clear()
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  lastSearchCounted = ''
  if (options.keepStorage) return
  try {
    for (const key of [SESSION_KEY, PAGES_KEY, ERRORS_KEY, SENT_KEY]) window.sessionStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

export function currentUiPage(): UiPage {
  return state.page
}

/** Called on every resolved navigation with the leaf route's `fullPath`. */
export function setUiPageFromRoute(fullPath: string | undefined | null): void {
  const page = uiPageFromRoutePath(fullPath)
  state.page = page
  if (state.landingPage === null) {
    state.landingPage = page
    const queued = state.pendingVitals
    state.pendingVitals = []
    for (const [metric, rating] of queued) sendVital(metric, rating)
  }
  const tab = uiProjectTabFromPage(page)
  sendOnce(PAGES_KEY, `${page}|${tab ?? ''}`, { event: 'ui.page_viewed' })
}

export function trackUiAction(action: UiAction, detail: { integration?: UiIntegration; format?: 'csv' | 'json' | 'html'; filter?: UiFilter } = {}): void {
  emit({ event: 'ui.action', action, ...detail })
}

/** A filter is "changed" once it stops moving for this long, so a slider drag is one event. */
export const UI_FILTER_DEBOUNCE_MS = 800
/** A table search counts once typing pauses this long (or on Enter). */
export const UI_SEARCH_DEBOUNCE_MS = 1_000

const filterTimers = new Map<UiFilter, ReturnType<typeof setTimeout>>()
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** In memory only, to avoid counting one query twice (debounce then Enter). Never sent. */
let lastSearchCounted = ''

/** One `filter.change` per settled change of `filter`. The value is never sent. */
export function trackUiFilterChange(filter: UiFilter): void {
  if (!state.sender) return
  const pending = filterTimers.get(filter)
  if (pending) clearTimeout(pending)
  filterTimers.set(filter, setTimeout(() => {
    filterTimers.delete(filter)
    trackUiAction('filter.change', { filter })
  }, UI_FILTER_DEBOUNCE_MS))
}

/**
 * A table search input changed. Counts one `search.submit` once a NON-EMPTY
 * query settles (`submitNow` for Enter). Clearing the box is not a search.
 * The text never leaves this function.
 */
export function trackUiSearchInput(value: string, submitNow = false): void {
  if (!state.sender) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  const query = value.trim()
  if (query.length === 0) {
    lastSearchCounted = ''
    return
  }
  const count = () => {
    searchTimer = undefined
    if (query === lastSearchCounted) return
    lastSearchCounted = query
    trackUiAction('search.submit')
  }
  if (submitNow) count()
  else searchTimer = setTimeout(count, UI_SEARCH_DEBOUNCE_MS)
}

/**
 * URL search params that are shared filters, by dimension. The measurement
 * views write them through `patchVisibilitySelection`, the runs list through
 * its own keys; any of them changing on the same page is a filter change.
 */
const FILTER_BY_SEARCH_KEY: Readonly<Record<string, UiFilter>> = {
  measurementProvider: 'provider',
  measurementModel: 'model',
  measurementLocation: 'location',
  measurementFrom: 'window',
  measurementTo: 'window',
  runWindow: 'window',
  queryClass: 'query_class',
  class: 'query_class',
  trackedType: 'query_class',
  trackedSubject: 'other',
  trackedStatus: 'other',
  trackedSource: 'other',
  trackedResult: 'other',
  trackedView: 'other',
  measurementScope: 'other',
  measurementScopeKey: 'other',
  measurementMarketKey: 'other',
  scope: 'other',
  runStatus: 'other',
  runKind: 'other',
  runProject: 'other',
}

/** Compare the search params of two locations on the same page; values are only compared, never sent. */
export function recordUiSearchParamsChange(previous: Record<string, unknown>, next: Record<string, unknown>): void {
  const changed = new Set<UiFilter>()
  for (const [key, filter] of Object.entries(FILTER_BY_SEARCH_KEY)) {
    if (!sameParam(previous[key], next[key])) changed.add(filter)
  }
  for (const filter of changed) trackUiFilterChange(filter)
}

function sameParam(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => v === undefined || v === null || v === '' ? '' : JSON.stringify(v)
  return norm(a) === norm(b)
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
  const component = input.component && UI_COMPONENT_PATTERN.test(input.component) ? input.component : undefined
  const key = [input.kind, state.page, component, errorName, method, route, status ?? statusClass].join('|')
  sendOnce(ERRORS_KEY, key, {
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

/**
 * A load metric for THIS page load. It is attributed to the landing page (the
 * first route the router resolved), never to whichever page is open when the
 * tab is hidden, and is held until that page is known.
 */
export function recordUiVital(metric: VitalMetric, rating: VitalRating): void {
  if (state.landingPage === null) {
    state.pendingVitals.push([metric, rating])
    return
  }
  sendVital(metric, rating)
}

function sendVital(metric: VitalMetric, rating: VitalRating): void {
  const page = state.landingPage ?? 'other'
  emit({ event: 'ui.vitals', metric, rating }, page)
}

/**
 * The feature a successful dashboard write stands for, keyed by the generated
 * client's route TEMPLATE. One table instead of a call at every button: every
 * write path (invokeWeb, generated TanStack mutations) goes through heyClient.
 *
 * `onlyStatus` narrows a row to one response status: the project upsert is a
 * create on 201 and an update on 200. OAuth starts are `connect_started`; the
 * connection counts as `connect` only where it is confirmed (a property or
 * account chosen, or credentials accepted).
 */
type ActionRow = readonly [method: string, template: string, action: UiAction, integration?: UiIntegration, onlyStatus?: number]
const ACTION_BY_ROUTE: ReadonlyArray<ActionRow> = [
  ['POST', '/api/v1/projects/{name}/runs', 'sweep.launch'],
  ['POST', '/api/v1/runs/{id}/cancel', 'sweep.cancel'],
  ['POST', '/api/v1/projects/{name}/technical-aeo/runs', 'site_audit.launch'],
  ['POST', '/api/v1/projects', 'project.create'],
  ['PUT', '/api/v1/projects/{name}', 'project.create', undefined, 201],
  ['PUT', '/api/v1/projects/{name}', 'project.update', undefined, 200],
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
  ['POST', '/api/v1/projects/{name}/google/connect', 'integration.connect_started', 'google'],
  // PUT /google/connections/{type}/property is resolved in googleConnectionAction.
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
  ['POST', '/api/v1/projects/{name}/google-ads/oauth/connect', 'integration.connect_started', 'google_ads'],
  ['PUT', '/api/v1/projects/{name}/google-ads/selection', 'integration.connect', 'google_ads'],
  ['DELETE', '/api/v1/projects/{name}/google-ads/connection', 'integration.disconnect', 'google_ads'],
  ['POST', '/api/v1/projects/{name}/gtm/oauth/connect', 'integration.connect_started', 'gtm'],
  ['PUT', '/api/v1/projects/{name}/gtm/selection', 'integration.connect', 'gtm'],
  ['DELETE', '/api/v1/projects/{name}/gtm/connection', 'integration.disconnect', 'gtm'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/cloudflare', 'integration.connect', 'traffic_cloudflare'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/vercel', 'integration.connect', 'traffic_vercel'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/cloud-run', 'integration.connect', 'traffic_cloud_run'],
  ['POST', '/api/v1/projects/{name}/traffic/connect/wordpress', 'integration.connect', 'traffic_wordpress'],
  ['POST', '/api/v1/projects/{name}/traffic/sources/{id}/sync', 'traffic.sync'],
  ['POST', '/api/v1/projects/{name}/notifications', 'notification.save'],
  ['POST', '/api/v1/projects/{name}/measurement-plan/draft/actions/publish', 'measurement_plan.publish'],
  // Only the Property page's name editor writes this action from the dashboard.
  ['POST', '/api/v1/projects/{name}/measurement-plan/draft/actions/upsert-target', 'property_names.save'],
  ['POST', '/api/v1/projects/{name}/discover/run', 'discovery.run'],
  ['POST', '/api/v1/keys', 'api_key.create'],
  ['POST', '/api/v1/keys/{id}/revoke', 'api_key.revoke'],
]

const GOOGLE_CONNECTION_TEMPLATE = '/api/v1/projects/{name}/google/connections/{type}'
const GOOGLE_INTEGRATION_BY_TYPE: Readonly<Record<string, UiIntegration>> = { gsc: 'gsc', ga4: 'ga', gbp: 'gbp' }

/**
 * Google connections share one template per verb, and `{type}` (gsc, ga4,
 * gbp) decides the integration. It is read from the real request path here,
 * mapped to the closed enum, and only the enum is sent. Choosing a property is
 * what confirms the connection.
 */
function googleConnectionAction(method: string, template: string, path: string | undefined): ActionRow | undefined {
  const verb = method === 'PUT' && template === `${GOOGLE_CONNECTION_TEMPLATE}/property` ? 'integration.connect' as const
    : method === 'DELETE' && template === GOOGLE_CONNECTION_TEMPLATE ? 'integration.disconnect' as const
      : undefined
  if (!verb) return undefined
  const type = path ? /\/google\/connections\/([^/?#]+)/.exec(path)?.[1] : undefined
  const integration = (type && GOOGLE_INTEGRATION_BY_TYPE[decodeURIComponent(type)]) || 'google'
  return [method, template, verb, integration]
}

/**
 * Statuses a read or write is EXPECTED to answer, which the calling code
 * handles as a normal outcome rather than a failure: no schedule yet, a
 * measurement draft that moved underneath an edit, an audit run that is gone,
 * a project name that is taken. These are not UI defects and are not reported.
 */
const EXPECTED_STATUSES: ReadonlyArray<readonly [method: string | '*', template: RegExp, statuses: readonly number[]]> = [
  ['GET', /^\/api\/v1\/projects\/\{name\}\/schedule$/, [404]],
  ['*', /^\/api\/v1\/projects\/\{name\}\/measurement-plan(?:\/draft(?:\/.*)?)?$/, [404, 409, 412]],
  ['GET', /^\/api\/v1\/projects\/\{name\}\/technical-aeo\/runs\/\{runId\}\/progress$/, [404]],
  ['GET', /^\/api\/v1\/projects\/\{name\}\/backlinks\/domains$/, [404]],
  ['POST', /^\/api\/v1\/projects$/, [409]],
  ['PUT', /^\/api\/v1\/projects\/\{name\}$/, [409]],
]

function isExpectedStatus(method: string | undefined, template: string, status: number): boolean {
  return EXPECTED_STATUSES.some(([m, pattern, statuses]) =>
    (m === '*' || m === method) && pattern.test(template) && statuses.includes(status))
}

/** Routes whose own traffic must never feed back into this telemetry. */
const IGNORED_ROUTE = /^\/api\/v1\/(?:telemetry|feedback)(?:\/|$)/

/**
 * Turn one finished dashboard API call into usage: a successful mapped write
 * is a `ui.action`; an unexpected 4xx, any 5xx, or a network failure is a
 * `ui.error` (`kind: api`). `path` is the real request path, read only to
 * resolve a closed enum (never sent).
 */
export function recordUiApiResult(input: { method?: string; route?: string; path?: string; status?: number; network?: boolean }): void {
  if (!input.route || IGNORED_ROUTE.test(input.route)) return
  const method = normalizeMethod(input.method)
  if (input.network || (typeof input.status === 'number' && input.status >= 400)) {
    // A 401 is session expiry, handled by the login redirect, not a UI defect.
    if (input.status === 401) return
    if (typeof input.status === 'number' && input.status < 500 && isExpectedStatus(method, input.route, input.status)) return
    recordUiError({ kind: 'api', route: input.route, method, status: input.status, network: input.network })
    return
  }
  if (!method || method === 'GET') return
  const match = googleConnectionAction(method, input.route, input.path)
    ?? ACTION_BY_ROUTE.find(([m, template, , , onlyStatus]) =>
      m === method && template === input.route && (onlyStatus === undefined || onlyStatus === input.status))
  if (match) trackUiAction(match[2], match[3] ? { integration: match[3] } : {})
}

/** Send at most once per session for `value`; mark it seen only once it was really sent. */
function sendOnce(storageKey: string, value: string, pending: PendingEvent): void {
  const seen = seenSet(storageKey)
  if (seen.has(value)) return
  if (!emit(pending)) return
  seen.add(value)
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify([...seen].slice(-MAX_REMEMBERED_KEYS)))
  } catch { /* storage unavailable: in-memory dedupe still holds */ }
}

/** Returns whether the event was handed to the sender. */
function emit(pending: PendingEvent, pageOverride?: UiPage): boolean {
  try {
    const sender = state.sender
    if (!sender || state.disabled) return false
    if (!takeRateSlot()) return false
    const page = pageOverride ?? state.page
    const tab: UiProjectTab | undefined = uiProjectTabFromPage(page)
    const event = {
      ...pending,
      eventId: createUuid(),
      uiSessionId: getOrCreateTabSessionId(SESSION_KEY),
      page,
      ...(tab ? { tab } : {}),
    } as UiTelemetryEvent
    void sender(event).then(
      result => { if (result && result.accepted === false) state.disabled = true },
      () => { /* best effort: measurement never surfaces an error */ },
    )
    return true
  } catch {
    // Never throw into the UI.
    return false
  }
}

/** 30 a minute and 120 an hour per tab; the send log survives a reload. */
function takeRateSlot(): boolean {
  const now = state.now()
  const log = (state.sentAt ??= readNumberList(SENT_KEY)).filter(at => now - at < 3_600_000 && at <= now)
  state.sentAt = log
  if (log.length >= UI_TELEMETRY_MAX_PER_HOUR) return false
  if (log.filter(at => now - at < 60_000).length >= UI_TELEMETRY_MAX_PER_MINUTE) return false
  log.push(now)
  try {
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify(log))
  } catch { /* storage unavailable: the in-memory log still caps this page */ }
  return true
}

function seenSet(storageKey: string): Set<string> {
  let seen = state.memory.get(storageKey)
  if (!seen) {
    seen = new Set(readStringList(storageKey))
    state.memory.set(storageKey, seen)
  }
  return seen
}

function readJsonList(key: string): unknown[] {
  try {
    const raw = window.sessionStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readStringList(key: string): string[] {
  return readJsonList(key).filter((v): v is string => typeof v === 'string')
}

function readNumberList(key: string): number[] {
  return readJsonList(key).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
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
