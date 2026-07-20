import {
  MODEL_ATTRIBUTION_EVENT_LIMIT,
  type ModelAttribution,
  type ModelEvidenceState,
} from '@ainyc/canonry-contracts'

import { classifyModelEvidence, modelEvidenceStatesEqual, type ModelEvidenceValue } from './model-evidence.js'

/** One tracked snapshot with the run's canonical observation time attached. */
export interface ModelAttributionObservation {
  runId: string
  runCreatedAt: string
  provider: string
  model: ModelEvidenceValue
}

export interface BuildModelAttributionInput {
  observations: readonly ModelAttributionObservation[]
  /** Maps an observation time to an already-emitted categorical trend bucket key. */
  bucketStartFor: (observedAt: string) => string
  /** Most recent pre-window state per in-window provider. Anchors are never emitted. */
  anchors?: Readonly<Record<string, ModelEvidenceState>>
}

interface LogicalSweep {
  observedAt: string
  byProvider: Map<string, ModelEvidenceValue[]>
}

function logicalSweeps(observations: readonly ModelAttributionObservation[]): LogicalSweep[] {
  const byCreatedAt = new Map<string, Map<string, ModelEvidenceValue[]>>()

  for (const observation of observations) {
    const byProvider = byCreatedAt.get(observation.runCreatedAt) ?? new Map<string, ModelEvidenceValue[]>()
    const models = byProvider.get(observation.provider) ?? []
    models.push(observation.model)
    byProvider.set(observation.provider, models)
    byCreatedAt.set(observation.runCreatedAt, byProvider)
  }

  return [...byCreatedAt.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([observedAt, byProvider]) => ({ observedAt, byProvider }))
}

/**
 * Builds deterministic, window-scoped provider evidence. Same-timestamp
 * multi-location runs are deliberately collapsed into one logical sweep.
 */
export function buildModelAttribution(input: BuildModelAttributionInput): ModelAttribution {
  const sweeps = logicalSweeps(input.observations)
  const providerNames = new Set<string>()
  for (const sweep of sweeps) {
    for (const provider of sweep.byProvider.keys()) providerNames.add(provider)
  }

  const attribution: ModelAttribution = {}
  for (const provider of [...providerNames].sort((a, b) => a.localeCompare(b))) {
    let previous = input.anchors?.[provider]
    // The first comparison uses the pre-window anchor, so its transition can't
    // be dated inside the window. Every later one compares two in-window sweeps.
    let previousIsAnchor = previous !== undefined
    let latestObservation: ModelAttribution[string]['latestObservation'] | undefined
    const events: ModelAttribution[string]['events'] = []

    for (const sweep of sweeps) {
      const values = sweep.byProvider.get(provider)
      if (!values) continue // Provider absence is not unknown evidence.

      const state = classifyModelEvidence(values)
      if (previous && !modelEvidenceStatesEqual(previous, state)) {
        events.push({
          observedAt: sweep.observedAt,
          bucketStartDate: input.bucketStartFor(sweep.observedAt),
          from: previous,
          to: state,
          ...(previousIsAnchor ? { fromPreWindowAnchor: true } : {}),
        })
      }
      previous = state
      previousIsAnchor = false
      latestObservation = { observedAt: sweep.observedAt, state }
    }

    if (latestObservation) {
      // Keep the most recent transitions: the oldest retained event's `from` is
      // still a real observed state, so truncation never invents a jump.
      attribution[provider] = {
        latestObservation,
        events: events.length > MODEL_ATTRIBUTION_EVENT_LIMIT ? events.slice(-MODEL_ATTRIBUTION_EVENT_LIMIT) : events,
        eventTotal: events.length,
      }
    }
  }

  return attribution
}
