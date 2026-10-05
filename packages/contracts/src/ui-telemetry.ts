import { z } from 'zod'

/**
 * Dashboard usage telemetry: which pages and tabs people open, which features
 * they use, where the UI breaks, and how fast it renders. Accepted by the local
 * API (`POST /api/v1/telemetry/ui`) and forwarded through the same opt-in,
 * anonymous path as CLI events.
 *
 * Every field is an allowlisted enum or an identifier-shaped label. Real URLs,
 * project names, query text, error messages and stack traces never cross this
 * boundary: a page is the route PATTERN from the router, an API failure is the
 * route TEMPLATE from the generated client, and an error is its class name.
 */

/** Route patterns of the dashboard, as `fullPath` with `$param` written `:param`. */
export const UI_PAGES = [
  '/',
  '/projects',
  '/projects/:projectName',
  '/projects/:projectName/portfolio',
  '/projects/:projectName/search-console',
  '/projects/:projectName/conversions',
  '/projects/:projectName/local',
  '/projects/:projectName/discovery',
  '/projects/:projectName/queries',
  '/projects/:projectName/properties/:targetKey',
  '/projects/:projectName/report',
  '/projects/:projectName/activity',
  '/projects/:projectName/backlinks',
  '/projects/:projectName/technical-aeo',
  '/projects/:projectName/history',
  '/projects/:projectName/settings',
  '/runs',
  '/history',
  '/settings',
  '/setup',
  '/backlinks',
  '/traffic',
  '/traffic/:projectName/:sourceId',
  'not-found',
  'other',
] as const
export const uiPageSchema = z.enum(UI_PAGES)
export type UiPage = z.infer<typeof uiPageSchema>

/** Project sections (each is its own route under `/projects/:projectName`). */
export const UI_PROJECT_TABS = [
  'overview',
  'portfolio',
  'search-console',
  'conversions',
  'local',
  'discovery',
  'queries',
  'properties',
  'report',
  'activity',
  'backlinks',
  'technical-aeo',
  'history',
  'settings',
  'other',
] as const
export const uiProjectTabSchema = z.enum(UI_PROJECT_TABS)
export type UiProjectTab = z.infer<typeof uiProjectTabSchema>

/**
 * Key dashboard features. Closed on purpose: a new feature adds its action
 * here (see apps/web/AGENTS.md) rather than sending a free-form name.
 */
export const UI_ACTIONS = [
  'sweep.launch',
  'sweep.cancel',
  'site_audit.launch',
  'project.create',
  'project.update',
  'project.delete',
  'query.add',
  'query.delete',
  'query.generate',
  'competitor.save',
  'competitor.delete',
  'schedule.save',
  'schedule.delete',
  'provider.save',
  'settings.save',
  /** An OAuth flow was started; the connection is not confirmed yet. */
  'integration.connect_started',
  /** A connection was confirmed (credentials accepted, or a property/account chosen). */
  'integration.connect',
  'integration.disconnect',
  'traffic.sync',
  'notification.save',
  'notification.test',
  'measurement_plan.publish',
  'discovery.run',
  'api_key.create',
  'api_key.revoke',
  'export.download',
  'report.download',
  'aero.open',
  'aero.send',
] as const
export const uiActionSchema = z.enum(UI_ACTIONS)
export type UiAction = z.infer<typeof uiActionSchema>

export const UI_INTEGRATIONS = [
  'google',
  'gsc',
  'ga',
  'bing',
  'gbp',
  'wordpress',
  'openai_ads',
  'google_ads',
  'gtm',
  'traffic_cloudflare',
  'traffic_vercel',
  'traffic_cloud_run',
  'traffic_wordpress',
] as const
export const uiIntegrationSchema = z.enum(UI_INTEGRATIONS)
export type UiIntegration = z.infer<typeof uiIntegrationSchema>

export const UI_EXPORT_FORMATS = ['csv', 'json', 'html'] as const

export const UI_ERROR_KINDS = ['render', 'unhandled', 'api'] as const
export const UI_STATUS_CLASSES = ['4xx', '5xx', 'network'] as const
export const UI_VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const
export const UI_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const

/** An error boundary's slug, never free text. */
export const UI_COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
/** An exception class name such as `TypeError` or `ChunkLoadError`. */
export const UI_ERROR_NAME_PATTERN = /^[a-z_$][\w$]{0,39}$/i
/** A generated-client route TEMPLATE: `/api/v1/projects/{name}/runs`, never a real path. */
export const UI_API_ROUTE_PATTERN = /^\/api\/v1(?:\/(?:[a-z0-9][\w.-]*|\{[a-z]\w*\})){1,12}$/i

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A route TEMPLATE, not a real path: the shape check alone would pass
 * `/api/v1/projects/acme-co/runs`. The project segment must be a `{param}`,
 * and no segment may be a raw id.
 */
export function isUiApiRouteTemplate(route: string): boolean {
  if (!UI_API_ROUTE_PATTERN.test(route)) return false
  const segments = route.split('/').slice(3)
  return segments.every((segment, index) =>
    !UUID_SEGMENT.test(segment)
    && (segments[index - 1] !== 'projects' || /^\{[a-z]\w*\}$/i.test(segment)))
}

const uiEventBaseSchema = z.object({
  eventId: z.string().uuid(),
  uiSessionId: z.string().uuid(),
  page: uiPageSchema,
})

export const uiTelemetryEventSchema = z.discriminatedUnion('event', [
  uiEventBaseSchema.extend({
    event: z.literal('ui.page_viewed'),
    tab: uiProjectTabSchema.optional(),
  }).strict(),
  uiEventBaseSchema.extend({
    event: z.literal('ui.action'),
    action: uiActionSchema,
    tab: uiProjectTabSchema.optional(),
    integration: uiIntegrationSchema.optional(),
    format: z.enum(UI_EXPORT_FORMATS).optional(),
  }).strict(),
  uiEventBaseSchema.extend({
    event: z.literal('ui.error'),
    kind: z.enum(UI_ERROR_KINDS),
    tab: uiProjectTabSchema.optional(),
    component: z.string().regex(UI_COMPONENT_PATTERN).optional(),
    errorName: z.string().regex(UI_ERROR_NAME_PATTERN).optional(),
    route: z.string().max(200).refine(isUiApiRouteTemplate, 'route must be a route template').optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    statusClass: z.enum(UI_STATUS_CLASSES).optional(),
    status: z.number().int().min(400).max(599).optional(),
  }).strict(),
  uiEventBaseSchema.extend({
    event: z.literal('ui.vitals'),
    metric: z.enum(UI_VITAL_METRICS),
    rating: z.enum(UI_VITAL_RATINGS),
  }).strict(),
])
export type UiTelemetryEvent = z.infer<typeof uiTelemetryEventSchema>

/** Normalize a router `fullPath` (`/projects/$projectName/`) to a `UiPage`. */
export function uiPageFromRoutePath(fullPath: string | undefined | null): UiPage {
  if (!fullPath) return 'other'
  if (fullPath === '*' || fullPath === '$' || fullPath.endsWith('/*') || fullPath.endsWith('/$')) return 'not-found'
  const normalized = fullPath
    .replace(/\$([a-z]\w*)/gi, ':$1')
    .replace(/(.)\/+$/, '$1')
  return (UI_PAGES as readonly string[]).includes(normalized) ? normalized as UiPage : 'other'
}

/** The project section a page belongs to, or undefined outside a project. */
export function uiProjectTabFromPage(page: UiPage): UiProjectTab | undefined {
  if (page === '/projects/:projectName') return 'overview'
  const match = /^\/projects\/:projectName\/([a-z-]+)/.exec(page)
  if (!match) return undefined
  const tab = match[1]!
  return (UI_PROJECT_TABS as readonly string[]).includes(tab) ? tab as UiProjectTab : 'other'
}
