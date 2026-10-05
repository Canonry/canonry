import crypto from 'node:crypto'
import {
  FEEDBACK_LIMITS,
  deliveryFailed,
  normalizeAgentSlug,
  quotaExceeded,
  redactFeedbackText,
  validationError,
  type FeedbackAcceptedDto,
  type FeedbackSource,
  type FeedbackSubmission,
} from '@ainyc/canonry-contracts'
import type { FeedbackRequestContext } from '@ainyc/canonry-api-routes'
import { PACKAGE_VERSION } from './package-version.js'
import { getOrCreateAnonymousId, isTelemetryEnabled } from './telemetry.js'
import { classifyUsageSurface } from './usage-telemetry.js'

/** The canonry.ai collector. `lib/feedback/validation.ts` there owns the wire limits. */
export const FEEDBACK_ENDPOINT = 'https://canonry.ai/api/feedback'
const TIMEOUT_MS = 10_000
/**
 * The collector rejects bodies over 8,192 bytes. Character limits do not bound
 * bytes: 4,000 CJK characters of details serialize to about 12 KB. Leave room
 * for headers the collector counts against the declared length.
 */
export const FEEDBACK_MAX_BODY_BYTES = 8_000

export interface FeedbackDeps {
  fetch?: typeof fetch
  telemetryEnabled?: () => boolean
  anonymousId?: () => string | undefined
}

/** Collapse the usage surface to the four sources the collector accepts. */
function feedbackSource(context: FeedbackRequestContext): FeedbackSource {
  const surface = classifyUsageSurface({
    userAgent: context.userAgent,
    usageLabels: { surface: context.surface },
  })
  if (surface === 'cli' || surface === 'dashboard') return surface
  if (surface === 'mcp-stdio' || surface === 'mcp-http') return 'mcp'
  return 'api'
}

/**
 * Forward one submission to canonry.ai.
 *
 * Free text is redacted for credentials first. The anonymous install id is
 * attached only while telemetry is enabled, so an opted-out install can still
 * send feedback without linking it to usage. Collector failures surface as
 * Canonry errors so the CLI and MCP caller can tell the user it did not land.
 */
export async function sendFeedback(
  submission: FeedbackSubmission,
  context: FeedbackRequestContext,
  deps: FeedbackDeps = {},
): Promise<FeedbackAcceptedDto> {
  const doFetch = deps.fetch ?? fetch
  const telemetryOn = (deps.telemetryEnabled ?? isTelemetryEnabled)()
  const anonymousId = telemetryOn ? (deps.anonymousId ?? getOrCreateAnonymousId)() : undefined
  // `none` is the CLI's "no agent detected" sentinel, not an answer: a
  // desktop MCP client (`claude-desktop`) still names the agent.
  const agent = [context.agent, context.mcpClient]
    .map(label => normalizeAgentSlug(label))
    .find((slug): slug is string => !!slug && slug !== 'none')

  const payload = {
    feedbackId: crypto.randomUUID(),
    ...(anonymousId ? { anonymousId } : {}),
    kind: submission.kind,
    summary: redactFeedbackText(submission.summary, FEEDBACK_LIMITS.summary),
    ...(submission.details ? { details: redactFeedbackText(submission.details, FEEDBACK_LIMITS.details) } : {}),
    ...(submission.area ? { area: redactFeedbackText(submission.area, FEEDBACK_LIMITS.area) } : {}),
    ...(submission.command ? { command: redactFeedbackText(submission.command, FEEDBACK_LIMITS.command) } : {}),
    ...(submission.errorCode ? { errorCode: redactFeedbackText(submission.errorCode, FEEDBACK_LIMITS.errorCode) } : {}),
    source: feedbackSource(context),
    ...(agent ? { agent } : {}),
    version: PACKAGE_VERSION.slice(0, 20),
    nodeVersion: process.versions.node.slice(0, 20),
    os: process.platform.slice(0, 20),
    arch: process.arch.slice(0, 20),
    timestamp: new Date().toISOString(),
  }

  const body = fitToByteBudget(payload)

  let response: Response
  try {
    response = await doFetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw deliveryFailed('Could not reach canonry.ai to send feedback. Check the network and try again.')
  }

  if (response.status === 202 || response.ok) {
    const body = await response.json().catch(() => ({})) as Partial<FeedbackAcceptedDto>
    return { accepted: body.accepted ?? true, id: typeof body.id === 'string' ? body.id : payload.feedbackId }
  }
  if (response.status === 429) throw quotaExceeded('feedback submissions', { retryLater: true })
  if (response.status === 400 || response.status === 413) {
    const body = await response.json().catch(() => ({})) as { issues?: unknown }
    throw validationError('canonry.ai rejected the feedback', body.issues ? { issues: body.issues } : undefined)
  }
  throw deliveryFailed(`canonry.ai could not store the feedback (HTTP ${response.status}). Try again later.`)
}

/** Drop whole code points from the end, never half of a surrogate pair. */
function truncateCodePoints(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, Math.max(0, maxCodePoints)).join('')
}

/**
 * Serialize the payload within `FEEDBACK_MAX_BODY_BYTES`, shortening `details`
 * first and then `summary` so a long non-ASCII report still lands instead of
 * being rejected for size.
 */
export function fitToByteBudget(payload: { summary: string; details?: string } & Record<string, unknown>): string {
  let current = { ...payload }
  for (const field of ['details', 'summary'] as const) {
    let serialized = JSON.stringify(current)
    let bytes = Buffer.byteLength(serialized, 'utf8')
    while (bytes > FEEDBACK_MAX_BODY_BYTES) {
      const text = current[field]
      if (typeof text !== 'string' || text.length === 0) break
      const points = Array.from(text).length
      // Shrink by at least the overflow, assuming the worst case of 4 bytes
      // per code point, so this converges in a few passes.
      const target = points - Math.max(1, Math.ceil((bytes - FEEDBACK_MAX_BODY_BYTES) / 4))
      // The collector requires a non-empty summary.
      if (field === 'summary' && target < 1) break
      const shorter = truncateCodePoints(text, target)
      if (field === 'details' && shorter.length === 0) {
        const { details: _dropped, ...rest } = current
        current = rest as typeof current
      } else {
        current = { ...current, [field]: shorter }
      }
      serialized = JSON.stringify(current)
      bytes = Buffer.byteLength(serialized, 'utf8')
    }
    if (bytes <= FEEDBACK_MAX_BODY_BYTES) return serialized
  }
  return JSON.stringify(current)
}
