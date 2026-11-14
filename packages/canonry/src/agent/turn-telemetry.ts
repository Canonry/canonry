import type { Agent } from '@earendil-works/pi-agent-core'
import {
  FeatureNames,
  OutcomeStatuses,
  OutcomeOperationKinds,
  OutcomePhases,
  buildOutcomeDiagnostics,
  extractProviderHttpStatus,
  bucketDuration,
  classifyProviderErrorMessage,
  type FeatureCompletedProperties,
  type OutcomeReasonCode,
  type OutcomeTrigger,
  type ProviderErrorCode,
  type OutcomePhase,
} from '@canonry/canonry-contracts'
import type { OutcomeAttribution } from '@canonry/canonry-api-routes'
import { outcomeAttribution, outcomeFailure, trackFeatureCompleted } from '../outcome-telemetry.js'
import { AGENT_PROVIDERS } from './providers.js'
import { aeroTurnOperationId, aeroTurnStatus, aeroTurnUsage } from './runtime.js'
import { createLogger } from '../logger.js'

const log = createLogger('AeroTurn')

export type AeroTurnStatus = NonNullable<ReturnType<typeof aeroTurnStatus>>

const PROVIDER_ERROR_REASONS: Record<ProviderErrorCode, OutcomeReasonCode> = {
  PROVIDER_AUTH: 'INVALID_CREDENTIALS',
  PROVIDER_BILLING: 'BILLING',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'HTTP_5XX',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  PARSE_ERROR: 'UNKNOWN',
  UNKNOWN: 'UNKNOWN',
}

type TurnOutcome = Pick<FeatureCompletedProperties, 'status' | 'reasonCode' | 'errorName'>

function turnOutcome(reason: AeroTurnStatus['reason'], error: unknown, providerError: string | undefined): TurnOutcome {
  switch (reason) {
    case 'completed':
      return { status: OutcomeStatuses.succeeded }
    case 'stopped':
      return { status: OutcomeStatuses.cancelled, reasonCode: 'CANCELLED_BY_USER' }
    case 'tool-limit':
      return { status: OutcomeStatuses.partial, reasonCode: 'QUOTA_EXCEEDED' }
    case 'time-limit':
      return { status: OutcomeStatuses.partial, reasonCode: 'TIMEOUT' }
    case 'error':
      if (error !== undefined) return { status: OutcomeStatuses.failed, ...outcomeFailure(error) }
      // A provider failure ends the turn without throwing; classify its text, never send it.
      return { status: OutcomeStatuses.failed, reasonCode: providerError ? PROVIDER_ERROR_REASONS[classifyProviderErrorMessage(providerError)] : 'UNKNOWN' }
  }
}

/** The Aero provider slug (`claude`, `openai`, `gemini`, `zai`) of a pi-ai model. */
function agentProviderSlug(piAiProvider: string): string | undefined {
  return Object.entries(AGENT_PROVIDERS).find(([, entry]) => entry.piAiProvider === piAiProvider)?.[0]
}

/**
 * Report one finished Aero turn as `feature.completed` (`aero` / `turn`), from
 * the counts the runtime kept for it. Tokens are sent once a model call
 * returned, and cost only when the model's catalog has a price. Never throws.
 */
export function trackAeroTurn(agent: Agent, turn: {
  trigger: OutcomeTrigger
  /** Local log join only; never sent in feature.completed properties. */
  projectId?: string
  /** The request the turn answered; none for a turn Aero started itself. */
  attribution?: OutcomeAttribution
  /** The status already computed for the turn (the route's), else read from the runtime. */
  status?: AeroTurnStatus
  /** What the caller caught while running or saving the turn; the turn then failed. */
  error?: unknown
  /** Captured at the owning prompt/save boundary; absent means it was not observed. */
  phase?: OutcomePhase
}): void {
  try {
    const status = turn.status ?? aeroTurnStatus(agent)
    if (!status) return
    const usage = aeroTurnUsage(agent)
    const model = agent.state.model
    // Read loosely: a model without a price is unknown cost, never a failed report.
    const price = model.cost as { input?: number; output?: number } | undefined
    const counts: NonNullable<FeatureCompletedProperties['counts']> = {
      modelCalls: status.modelCalls,
      toolCalls: status.toolCalls,
    }
    if (usage) {
      counts.toolErrors = usage.toolErrors
      if (usage.responses > 0) {
        counts.inputTokens = usage.inputTokens
        counts.outputTokens = usage.outputTokens
        counts.cachedTokens = usage.cachedTokens
        if ((price?.input ?? 0) > 0 || (price?.output ?? 0) > 0) counts.costMicros = Math.round(usage.costUsd * 1_000_000)
      }
    }
    const modelProvider = agentProviderSlug(model.provider)
    const operationId = aeroTurnOperationId(agent)
    // SDKs sometimes expose only a safe status prefix in the terminal error string.
    const httpStatus = agent.state.errorMessage ? extractProviderHttpStatus(agent.state.errorMessage) : undefined
    const diagnostics = buildOutcomeDiagnostics(turn.error ?? (httpStatus ? { status: httpStatus } : undefined), {
      phase: turn.phase ?? (turn.error === undefined && agent.state.errorMessage ? OutcomePhases['provider-request'] : OutcomePhases.unknown),
    })
    const outcome = turnOutcome(turn.error === undefined ? status.reason : 'error', turn.error, agent.state.errorMessage)
    log.info('completed', {
      operationId,
      projectId: turn.projectId,
      provider: modelProvider,
      httpStatus: diagnostics.httpStatus,
      errorCode: outcome.reasonCode,
      msg: `Aero ${outcome.status}; phase ${diagnostics.phase}.`,
    })
    trackFeatureCompleted({
      feature: FeatureNames.aero,
      operation: 'turn',
      operationKind: OutcomeOperationKinds['agent-turn'],
      operationId,
      diagnostics,
      ...outcome,
      trigger: turn.trigger,
      ...outcomeAttribution(turn.attribution),
      durationBucket: bucketDuration(status.durationMs),
      counts,
      model: model.id,
      ...(modelProvider ? { modelProvider } : {}),
    })
  } catch (err) {
    // Under test an invalid payload throws so drift fails loudly; a live turn never pays for telemetry.
    if (process.env.VITEST) throw err
  }
}
