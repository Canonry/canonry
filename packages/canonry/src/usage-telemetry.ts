import {
  AGENT_NONE,
  normalizeAgentSlug,
  usageSurfaceSchema,
  type UsageSurface,
} from '@ainyc/canonry-contracts'
import type { ApiRequestCompletedInfo } from '@ainyc/canonry-api-routes'
import { bucketCliCommandDuration, trackEvent, type TelemetryProperties, type TrackEventOptions } from './telemetry.js'

/**
 * Server-side usage telemetry for the agent surfaces: MCP (stdio and hosted),
 * the built-in Aero agent, and raw API callers.
 *
 * WHY ON THE SERVER. Every one of those surfaces reaches Canonry as an API
 * request, and the MCP adapter is barred from importing telemetry (root
 * AGENTS.md, MCP adapter boundary). So the first-party clients LABEL their
 * requests with `USAGE_TELEMETRY_HEADERS` and the server, which already emits
 * as `cli-server`, turns each labelled request into an event.
 *
 * WHAT IS NOT EMITTED. CLI requests are already one `cli.command` per command,
 * so their API calls would double count. Dashboard requests are polling-heavy
 * and are measured by the onboarding funnel instead.
 *
 * VOLUME. An agent loop can issue thousands of calls, so `api.request` is
 * capped per process by a token bucket; suppressed calls are counted and
 * reported on the next event as `droppedBefore`, never silently lost.
 */

/**
 * The cap is sized to the canonry.ai collector, not to the agent. The collector
 * allows 100 events per minute and 1,000 per hour PER IP, and once an IP is over
 * either limit it drops EVERY event from that IP, including `cli.command`,
 * `run.completed`, and `telemetry.disabled`. A burst of 20 refilling one token
 * per 10s bounds this stream at 360/hour, which leaves the rest of the install's
 * events room even under a sustained agent loop. Several servers behind one NAT
 * share that budget, so do not raise this without raising the collector's.
 */
export const API_REQUEST_BUCKET_CAPACITY = 20
export const API_REQUEST_REFILL_PER_MS = 1 / 10_000
const MAX_TRACKED_MCP_SESSIONS = 2000
const MAX_ROUTE_LENGTH = 200
const SKIPPED_ROUTE_PATTERN = /(?:^|\/)(?:health|openapi\.json|telemetry)(?:\/|$)/
const MCP_CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MCP_TOOL_PATTERN = /^[a-z][a-z0-9_]{0,79}$/

export type UsageEventEmitter = (event: string, properties: TelemetryProperties, options?: TrackEventOptions) => void

/**
 * Attribute a request to a surface. An explicit, valid label wins; otherwise
 * the user agent decides, which also classifies clients older than the label:
 * `canonry-cli/<v>` is the CLI, `canonry-mcp/<v>` the hosted MCP inner hop,
 * bare `canonry-mcp` the stdio adapter, and a browser the dashboard.
 */
export function classifyUsageSurface(info: Pick<ApiRequestCompletedInfo, 'userAgent' | 'usageLabels'>): UsageSurface {
  const labelled = usageSurfaceSchema.safeParse(info.usageLabels.surface)
  if (labelled.success) return labelled.data
  const ua = info.userAgent ?? ''
  if (ua.startsWith('canonry-cli')) return 'cli'
  if (ua.startsWith('canonry-mcp/')) return 'mcp-http'
  if (ua === 'canonry-mcp') return 'mcp-stdio'
  if (ua.startsWith('Mozilla/')) return 'dashboard'
  return 'api'
}

function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx'
  if (statusCode >= 400) return '4xx'
  if (statusCode >= 300) return '3xx'
  return '2xx'
}

export interface ApiUsageTelemetryOptions {
  emit?: UsageEventEmitter
  now?: () => number
}

export function createApiUsageTelemetry(options: ApiUsageTelemetryOptions = {}): (info: ApiRequestCompletedInfo) => void {
  const emit: UsageEventEmitter = options.emit ?? trackEvent
  const now = options.now ?? Date.now
  let tokens = API_REQUEST_BUCKET_CAPACITY
  let refilledAt = now()
  let droppedBefore = 0
  const seenSessions = new Set<string>()

  const takeToken = (): boolean => {
    const at = now()
    tokens = Math.min(API_REQUEST_BUCKET_CAPACITY, tokens + (at - refilledAt) * API_REQUEST_REFILL_PER_MS)
    refilledAt = at
    if (tokens < 1) return false
    tokens -= 1
    return true
  }

  return (info) => {
    if (info.method === 'OPTIONS' || info.method === 'HEAD') return
    if (SKIPPED_ROUTE_PATTERN.test(info.route)) return
    const surface = classifyUsageSurface(info)
    if (surface === 'cli' || surface === 'dashboard') return

    const labels = info.usageLabels
    const mcpClient = normalizeAgentSlug(labels.mcpClient)
    const detected = normalizeAgentSlug(labels.agent)
    // A hosted MCP server runs in no agent's environment, so its env-detected
    // label is always `none`; the MCP client's own name is the better signal.
    const agent = detected && detected !== AGENT_NONE ? detected : (mcpClient ?? detected ?? AGENT_NONE)
    const mcpTool = labels.mcpTool && MCP_TOOL_PATTERN.test(labels.mcpTool) ? labels.mcpTool : undefined
    const mcpCallId = labels.mcpCall && MCP_CALL_ID_PATTERN.test(labels.mcpCall) ? labels.mcpCall.toLowerCase() : undefined
    const isMcp = surface === 'mcp-stdio' || surface === 'mcp-http'

    // One session event per MCP connection, on its first tool call: that is the
    // first request carrying the client name, which initialize only provides
    // after the adapter's startup probe has already gone out.
    if (isMcp && mcpTool && info.actorSession && !seenSessions.has(info.actorSession)) {
      if (seenSessions.size >= MAX_TRACKED_MCP_SESSIONS) seenSessions.clear()
      seenSessions.add(info.actorSession)
      emit('mcp.session.started', { surface, agent, ...(mcpClient ? { mcpClient } : {}) }, { source: 'cli-server' })
    }

    if (!takeToken()) {
      droppedBefore += 1
      return
    }
    const properties: TelemetryProperties = {
      surface,
      agent,
      method: info.method,
      route: info.route.slice(0, MAX_ROUTE_LENGTH),
      statusClass: statusClass(info.statusCode),
      durationBucket: bucketCliCommandDuration(info.durationMs),
      ...(mcpClient ? { mcpClient } : {}),
      ...(mcpTool ? { mcpTool } : {}),
      ...(mcpCallId ? { mcpCallId } : {}),
      ...(droppedBefore > 0 ? { droppedBefore } : {}),
    }
    droppedBefore = 0
    emit('api.request', properties, { source: 'cli-server' })
  }
}
