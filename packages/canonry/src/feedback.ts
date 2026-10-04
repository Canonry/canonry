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
  const agent = normalizeAgentSlug(context.agent) ?? normalizeAgentSlug(context.mcpClient)

  const payload = {
    feedbackId: crypto.randomUUID(),
    ...(anonymousId ? { anonymousId } : {}),
    kind: submission.kind,
    summary: redactFeedbackText(submission.summary, FEEDBACK_LIMITS.summary),
    ...(submission.details ? { details: redactFeedbackText(submission.details, FEEDBACK_LIMITS.details) } : {}),
    ...(submission.area ? { area: submission.area } : {}),
    ...(submission.command ? { command: redactFeedbackText(submission.command, FEEDBACK_LIMITS.command) } : {}),
    ...(submission.errorCode ? { errorCode: submission.errorCode } : {}),
    source: feedbackSource(context),
    ...(agent && agent !== 'none' ? { agent } : {}),
    version: PACKAGE_VERSION.slice(0, 20),
    nodeVersion: process.versions.node.slice(0, 20),
    os: process.platform.slice(0, 20),
    arch: process.arch.slice(0, 20),
    timestamp: new Date().toISOString(),
  }

  let response: Response
  try {
    response = await doFetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
