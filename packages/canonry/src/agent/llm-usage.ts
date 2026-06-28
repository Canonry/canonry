import crypto from 'node:crypto'
import { llmUsageEvents, type DatabaseClient } from '@ainyc/canonry-db'
import type { AssistantMessage } from '@mariozechner/pi-ai'

export const AeroLlmUsageFeatures = {
  turn: 'aero.turn',
} as const

export const AERO_PROMPT_FAMILY = 'aero'
export const AERO_PROMPT_VERSION = 'aero-system-v1'

/**
 * One dollar = 100 cents = 100,000 millicents. pi-ai returns USD floats;
 * telemetry persists integer millicents for cheap sums and stable audits.
 */
function dollarsToMillicents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0
  return Math.round(dollars * 100_000)
}

function nonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0
  return Math.round(value)
}

export interface RecordLlmUsageEventArgs {
  db: DatabaseClient
  projectId?: string
  runId?: string
  agentSessionId?: string
  feature: string
  promptFamily?: string
  promptVersion?: string
  message: AssistantMessage
  metadata?: Record<string, unknown>
}

/**
 * Best-effort append-only usage telemetry. This must never break an agent turn:
 * the Anthropic/OpenAI dashboards are advisory, but the operator chat is user-facing.
 */
export function recordLlmUsageEvent(args: RecordLlmUsageEventArgs): void {
  try {
    const usage = args.message.usage
    const now = new Date().toISOString()
    args.db.insert(llmUsageEvents).values({
      id: crypto.randomUUID(),
      projectId: args.projectId,
      runId: args.runId,
      agentSessionId: args.agentSessionId,
      feature: args.feature,
      provider: args.message.provider,
      model: args.message.model,
      responseId: args.message.responseId,
      inputTokens: nonNegativeInteger(usage.input),
      outputTokens: nonNegativeInteger(usage.output),
      cacheReadTokens: nonNegativeInteger(usage.cacheRead),
      cacheWriteTokens: nonNegativeInteger(usage.cacheWrite),
      totalTokens: nonNegativeInteger(usage.totalTokens),
      costMillicents: dollarsToMillicents(usage.cost.total),
      promptFamily: args.promptFamily,
      promptVersion: args.promptVersion,
      metadata: args.metadata,
      createdAt: now,
    }).run()
  } catch {
    // Usage telemetry is diagnostic only; do not fail the agent on DB errors.
  }
}
