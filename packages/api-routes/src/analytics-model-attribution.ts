import {
  MODEL_ATTRIBUTION_EVENT_LIMIT,
  type ModelAttribution,
  type ModelEvidenceState,
  type ServedModelAttribution,
} from '@ainyc/canonry-contracts'

import {
  classifyModelEvidence,
  classifyServedModelEvidence,
  distinctServedModelIds,
  modelEvidenceStatesEqual,
  type ModelEvidenceValue,
} from './model-evidence.js'

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
  /**
   * Observation time of each anchor sweep, so an anchor-derived transition can
   * be dated to a closed range instead of an open-ended "on or before".
   */
  anchorObservedAt?: Readonly<Record<string, string>>
  /**
   * Providers whose pre-window anchor search hit its scan bound without finding
   * a sweep. Reported so a consumer can say the history may be incomplete.
   */
  anchorUnavailable?: ReadonlySet<string>
  /**
   * How a sweep's raw values collapse into one categorical state. Defaults to
   * the configured-model classifier; the served series swaps in the top-level
   * (dated-snapshot-insensitive) one. Anchors must be classified the same way.
   */
  classify?: (values: readonly ModelEvidenceValue[]) => ModelEvidenceState
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

  const classify = input.classify ?? classifyModelEvidence

  const attribution: ModelAttribution = {}
  for (const provider of [...providerNames].sort((a, b) => a.localeCompare(b))) {
    let previous = input.anchors?.[provider]
    // The first comparison uses the pre-window anchor, so its transition can't
    // be dated inside the window. Every later one compares two in-window sweeps.
    let previousIsAnchor = previous !== undefined
    const anchorObservedAt = previousIsAnchor ? input.anchorObservedAt?.[provider] : undefined
    let latestObservation: ModelAttribution[string]['latestObservation'] | undefined
    const events: ModelAttribution[string]['events'] = []

    for (const sweep of sweeps) {
      const values = sweep.byProvider.get(provider)
      if (!values) continue // Provider absence is not unknown evidence.

      const state = classify(values)
      if (previous && !modelEvidenceStatesEqual(previous, state)) {
        events.push({
          observedAt: sweep.observedAt,
          bucketStartDate: input.bucketStartFor(sweep.observedAt),
          from: previous,
          to: state,
          ...(previousIsAnchor
            ? {
              fromPreWindowAnchor: true,
              ...(anchorObservedAt ? { anchorObservedAt } : {}),
            }
            : {}),
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
        ...(input.anchorUnavailable?.has(provider) ? { anchorUnavailable: true } : {}),
      }
    }
  }

  return attribution
}

/** One tracked snapshot that actually reported which model answered it. */
export interface ServedModelObservation extends ModelAttributionObservation {
  model: string
}

export interface BuildServedModelAttributionInput extends Omit<BuildModelAttributionInput, 'observations' | 'classify'> {
  /**
   * ONLY snapshots carrying a served id. A snapshot the provider did not stamp
   * is not an observation, so it must be filtered out by the caller rather than
   * classified as `unknown`. That is what keeps the deploy boundary silent: a
   * window with no captured ids yields an empty series and no bootstrap event,
   * instead of an `unknown → known` transition on capture day.
   */
  observations: readonly ServedModelObservation[]
}

/**
 * The served-model series. Structurally identical to the configured one, but
 * classified at top-level granularity so a provider re-pinning the same model
 * to a newer dated snapshot emits nothing, while a tier swap
 * (`gpt-5.6` → `gpt-5.6-sol`) emits a real change.
 */
export function buildServedModelAttribution(
  input: BuildServedModelAttributionInput,
): ServedModelAttribution {
  const base = buildModelAttribution({
    ...input,
    observations: input.observations,
    classify: values => classifyServedModelEvidence(
      values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    ),
  })

  const served: ServedModelAttribution = {}
  for (const [provider, entry] of Object.entries(base)) {
    served[provider] = {
      ...entry,
      // The raw ids behind the latest state. `latestObservation.state` reports
      // the normalized identity; this is what the provider literally said.
      latestServedModelIds: distinctServedModelIds(
        input.observations
          .filter(o => o.provider === provider && o.runCreatedAt === entry.latestObservation.observedAt)
          .map(o => o.model),
      ),
    }
  }
  return served
}
