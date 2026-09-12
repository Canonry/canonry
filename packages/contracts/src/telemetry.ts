/**
 * Shared telemetry classification helpers.
 *
 * A "ghost" telemetry event is an operator / CI test sweep that would otherwise
 * pollute the onboarding funnel: a `run.completed` / `run.aborted` event with
 * no providers configured (`providerCount === 0`) originating from one of the
 * known test locations. The CLI drops these before sending and the cloud
 * collector drops them again as a backstop for older CLIs that still send, so
 * both surfaces classify with this one predicate and can never drift.
 */
import { z } from 'zod'

/** Why the telemetry setting is effectively enabled or disabled. */
export const telemetryEffectiveReasonSchema = z.enum([
  'enabled',
  'configured_disabled',
  'CANONRY_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'NO_CONFIG',
  'CONFIG_UNAVAILABLE',
])
export type TelemetryEffectiveReason = z.infer<typeof telemetryEffectiveReasonSchema>

export const telemetryTargetSchema = z.enum(['server', 'local'])
export type TelemetryTarget = z.infer<typeof telemetryTargetSchema>

/**
 * Safe state for telemetry settings. `anonymousId`, when present, is already
 * masked (eight characters plus an ellipsis), never the install identifier.
 */
export const telemetryStatusDtoSchema = z.object({
  enabled: z.boolean(),
  configuredEnabled: z.boolean(),
  reason: telemetryEffectiveReasonSchema,
  anonymousId: z.string().regex(/^[0-9a-f]{8}\.\.\.$/i).optional(),
  target: telemetryTargetSchema.optional(),
}).strict()
export type TelemetryStatusDto = z.infer<typeof telemetryStatusDtoSchema>

export type TelemetryStatusInput = Pick<TelemetryStatusDto, 'enabled'> & Partial<Omit<TelemetryStatusDto, 'enabled'>>

/** Normalize legacy host/API responses before CLI or MCP output validation. */
export function normalizeTelemetryStatus(status: TelemetryStatusInput, target: TelemetryTarget = 'server'): TelemetryStatusDto {
  const reason = telemetryEffectiveReasonSchema.safeParse(status.reason)
  const anonymousId = maskTelemetryAnonymousId(status.anonymousId)
  return telemetryStatusDtoSchema.parse({
    enabled: status.enabled,
    configuredEnabled: status.configuredEnabled ?? status.enabled,
    reason: reason.success ? reason.data : status.enabled ? 'enabled' : 'configured_disabled',
    target,
    ...(anonymousId ? { anonymousId } : {}),
  })
}

/** Accept only an install UUID or its already-masked public form. */
export function maskTelemetryAnonymousId(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^[0-9a-f]{8}\.\.\.$/i.test(value)) return value
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? `${value.slice(0, 8)}...`
    : undefined
}

export const ONBOARDING_FLOW_VERSION = 1 as const

export const onboardingStepSchema = z.enum([
  'system',
  'project',
  'queries',
  'competitors',
  'run',
])
export type OnboardingStep = z.infer<typeof onboardingStepSchema>

export const onboardingCountBucketSchema = z.enum([
  '0',
  '1',
  '2-3',
  '4-5',
  '6-10',
  '11+',
])
export type OnboardingCountBucket = z.infer<typeof onboardingCountBucketSchema>

export function bucketOnboardingCount(value: number): OnboardingCountBucket {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 2) return '1'
  if (value < 4) return '2-3'
  if (value < 6) return '4-5'
  if (value < 11) return '6-10'
  return '11+'
}

export const onboardingBlockReasonSchema = z.enum([
  'api_unavailable',
  'database_unavailable',
  'worker_unavailable',
  'no_provider',
  'no_queries',
  'provider_save_failed',
  'project_create_failed',
  'query_save_failed',
  'run_rejected',
  'run_failed',
  'run_cancelled',
  // Provider-side failures the query-generation step actually hits. Without
  // these every one of them reported `unknown`, which is why the queries step
  // was the only blocker nobody could diagnose.
  'rate_limited',
  'provider_auth',
  'network',
  'unknown',
])
export type OnboardingBlockReason = z.infer<typeof onboardingBlockReasonSchema>

/**
 * Which onboarding surface produced the event.
 *
 * `wizard` is the original five-step `SetupPage` flow. `platform` is the
 * first-run launchpad that `/setup` resolves to when the install has no
 * projects, and `site_health` is the scan-first continuation it hands off to.
 * The three are different funnels with different drop-off shapes, so an
 * analysis that pools them measures nothing.
 *
 * Optional ON THE WIRE, because events emitted before this field existed are all
 * `wizard` and an older client must stay valid. Making it required here would
 * have been a breaking change to the published request schema.
 *
 * The historical default is therefore applied where the event is FORWARDED to
 * the collector (`normalizeOnboardingEventForCollection`), not left to each
 * reader: an undefined that reaches the collector is stored as null, and every
 * analysis then has to re-derive the same fallback. One of them will forget.
 */
export const onboardingSurfaceSchema = z.enum([
  'wizard',
  'platform',
  'site_health',
])
export type OnboardingSurface = z.infer<typeof onboardingSurfaceSchema>

const onboardingEventBaseSchema = z.object({
  eventId: z.string().uuid(),
  flowVersion: z.literal(ONBOARDING_FLOW_VERSION),
  onboardingSessionId: z.string().uuid(),
  surface: onboardingSurfaceSchema.optional(),
})

/**
 * Privacy-safe dashboard onboarding milestones accepted by the local API.
 * Every field is an allowlisted enum, boolean, or coarse count bucket. Raw
 * domains, project/query text, provider errors, and credentials never cross
 * this boundary.
 */
export const onboardingTelemetryEventSchema = z.discriminatedUnion('event', [
  onboardingEventBaseSchema.extend({
    event: z.literal('onboarding.started'),
    step: onboardingStepSchema,
    resumed: z.boolean(),
  }).strict(),
  onboardingEventBaseSchema.extend({
    event: z.literal('onboarding.step_completed'),
    step: onboardingStepSchema,
    method: z.enum(['existing', 'inline', 'manual', 'generated', 'skipped', 'automatic']),
    countBucket: onboardingCountBucketSchema.optional(),
  }).strict(),
  onboardingEventBaseSchema.extend({
    event: z.literal('onboarding.blocked'),
    step: onboardingStepSchema,
    action: z.enum(['continue', 'configure_provider', 'generate_queries', 'save', 'launch_run', 'retry_run']),
    reasonCode: onboardingBlockReasonSchema,
  }).strict(),
  onboardingEventBaseSchema.extend({
    event: z.literal('run.requested'),
    origin: z.literal('dashboard_setup'),
    result: z.enum(['queued', 'rejected']),
    /**
     * What kind of run was asked for. A site-health crawl has no providers and
     * no tracked queries, so its buckets are legitimately `0`; without this
     * field that is indistinguishable from a misconfigured visibility sweep.
     * Optional on the wire and defaulted at collection for the same reason as
     * `surface`: a documented fallback that nothing applies becomes a null
     * bucket downstream.
     */
    kind: z.enum(['answer_visibility', 'site_health']).optional(),
    providerCountBucket: onboardingCountBucketSchema,
    queryCountBucket: onboardingCountBucketSchema,
    reasonCode: onboardingBlockReasonSchema.optional(),
  }).strict(),
])
export type OnboardingTelemetryEvent = z.infer<typeof onboardingTelemetryEventSchema>

/**
 * Apply the documented historical defaults on the way to the collector.
 *
 * The wire schema leaves `surface` and `kind` optional so an older client stays
 * valid, but "absent means wizard / answer_visibility" is only true if someone
 * actually applies it. Nothing did: the route forwarded the parsed event
 * unchanged, so the collector stored nulls and every downstream reader had to
 * re-derive the same fallback. Do it once, here, at the single point every
 * onboarding event passes through.
 */
export function normalizeOnboardingEventForCollection(
  event: OnboardingTelemetryEvent,
): OnboardingTelemetryEvent {
  const surfaced = { ...event, surface: event.surface ?? 'wizard' }
  return surfaced.event === 'run.requested'
    ? { ...surfaced, kind: surfaced.kind ?? 'answer_visibility' }
    : surfaced
}

export const telemetryEventAcceptedDtoSchema = z.object({
  accepted: z.boolean(),
})
export type TelemetryEventAcceptedDto = z.infer<typeof telemetryEventAcceptedDtoSchema>

const GHOST_TELEMETRY_TEST_LOCATIONS = new Set(['nyc', 'lax', 'chi'])

/** Minimal property shape the ghost-event predicate reads. */
export interface GhostTelemetryProperties {
  providerCount?: unknown
  location?: unknown
}

/**
 * True when an event name + property bag describes a no-provider test-location
 * run sweep that should be kept out of funnel analytics. The location match is
 * case-insensitive and whitespace-trimmed; `providerCount` must be exactly `0`.
 */
export function isGhostTelemetryEvent(
  eventName: unknown,
  properties?: GhostTelemetryProperties | null,
): boolean {
  if (eventName !== 'run.completed' && eventName !== 'run.aborted') return false
  if (!properties) return false
  if (properties.providerCount !== 0) return false
  const location = typeof properties.location === 'string'
    ? properties.location.trim().toLowerCase()
    : ''
  return GHOST_TELEMETRY_TEST_LOCATIONS.has(location)
}

/**
 * The interface a Canonry request or event came through. Canonry is agent
 * first, so MCP, the CLI, the built-in Aero agent, raw API callers, and the
 * dashboard are separate funnels that analysis must never pool.
 */
export const usageSurfaceSchema = z.enum(['cli', 'mcp-stdio', 'mcp-http', 'aero', 'api', 'dashboard'])
export type UsageSurface = z.infer<typeof usageSurfaceSchema>

/**
 * Request headers a first-party client sets so the server can attribute usage.
 * They are LABELS for telemetry only: caller-controlled, so they are validated
 * to enums and slugs and never participate in identity, scope, or authority.
 */
export const USAGE_TELEMETRY_HEADERS = {
  surface: 'x-canonry-surface',
  agent: 'x-canonry-agent',
  mcpClient: 'x-canonry-mcp-client',
  mcpTool: 'x-canonry-mcp-tool',
  mcpCall: 'x-canonry-mcp-call',
} as const

/** The agent value when no coding agent was detected. Distinct from an absent field, which means an older client. */
export const AGENT_NONE = 'none'

const AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/

/**
 * Reduce a free-form agent or MCP client name to a bounded, low-cardinality
 * slug: lowercase, runs of other characters collapsed to `-`, at most 40
 * characters. Returns null when nothing usable remains.
 */
export function normalizeAgentSlug(value: string | null | undefined): string | null {
  if (!value) return null
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 40)
    .replace(/^[-._]+|[-._]+$/g, '')
  return AGENT_SLUG_PATTERN.test(slug) ? slug : null
}

const AI_AGENT_ALIASES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'github-copilot-cli': 'github-copilot',
}

/**
 * `AI_AGENT` is a convention a harness sets to name itself. Some embed a
 * version (Claude Code sends `claude-code_2-1-270_agent`), which would make
 * every release a new agent, so the version and the `_agent` suffix are
 * dropped before the name is used.
 */
function agentFromAiAgentVariable(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/_agent$/, '').replace(/_\d[\d._-]*$/, '')
  const slug = normalizeAgentSlug(name)
  return slug ? (AI_AGENT_ALIASES[slug] ?? slug) : null
}

/**
 * Name the coding agent a process runs under, from environment variables the
 * agents set for the commands they spawn.
 *
 * The table and its precedence mirror `@vercel/detect-agent` 1.2.5 (MIT), so
 * Canonry reports the same names other agent-aware tools do. Two deliberate
 * differences: no filesystem probe (this module stays pure, so the Devin check
 * is omitted), and `CANONRY_AGENT` is honoured first as an explicit label for
 * a harness the table does not know.
 *
 * `CURSOR_TRACE_ID` is also present in Cursor's integrated terminal when a
 * person types a command, so `cursor` alone does not prove an agent ran it;
 * read it together with the event's `interactive` flag.
 */
export function detectAgentRuntime(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = normalizeAgentSlug(env.CANONRY_AGENT)
  if (explicit) return explicit
  if (env.AI_AGENT?.trim()) {
    const named = agentFromAiAgentVariable(env.AI_AGENT)
    if (named) return named
  }
  if (env.CURSOR_TRACE_ID) return 'cursor'
  if (env.CURSOR_AGENT || env.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec') return 'cursor-cli'
  if (env.GEMINI_CLI) return 'gemini'
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) return 'codex'
  if (env.ANTIGRAVITY_AGENT) return 'antigravity'
  if (env.AUGMENT_AGENT) return 'augment-cli'
  if (env.OPENCODE_CLIENT) return 'opencode'
  if (env.CLAUDECODE || env.CLAUDE_CODE) return env.CLAUDE_CODE_IS_COWORK ? 'cowork' : 'claude'
  if (env.REPL_ID) return 'replit'
  if (env.COPILOT_MODEL || env.COPILOT_ALLOW_ALL || env.COPILOT_GITHUB_TOKEN) return 'github-copilot'
  return AGENT_NONE
}
