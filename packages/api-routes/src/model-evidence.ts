import { modelIdsEquivalent, normalizeModelId, type ModelEvidenceState } from '@ainyc/canonry-contracts'

export type ModelEvidenceValue = string | null | undefined

/**
 * Classify raw snapshot model values without discarding legacy null evidence.
 * A missing provider observation is handled by callers; this function is only
 * for a provider that contributed one or more snapshots to a group or bucket.
 */
export function classifyModelEvidence(values: Iterable<ModelEvidenceValue>): ModelEvidenceState {
  const models = new Set<string>()
  let includesUnknown = false

  for (const value of values) {
    const model = value?.trim()
    if (model) {
      models.add(model)
    } else {
      includesUnknown = true
    }
  }

  const knownModels = [...models].sort()
  if (knownModels.length === 0) return { status: 'unknown' }
  if (knownModels.length === 1 && !includesUnknown) {
    return { status: 'known', model: knownModels[0]! }
  }
  return {
    status: 'mixed',
    models: knownModels,
    includesUnknown,
  }
}

/**
 * Classify SERVED evidence at top-level model granularity. Two dated snapshots
 * of the same model collapse to one `known` state instead of reading as `mixed`
 * — a provider rolling `gpt-5.4-2026-03-05` out across a sweep is not serving
 * two models. A capability tier survives normalization, so `gpt-5.6` alongside
 * `gpt-5.6-sol` still reports as genuinely mixed.
 *
 * Callers must drop null/empty values BEFORE calling: an absent served id is an
 * absent observation, not `unknown` evidence.
 */
export function classifyServedModelEvidence(values: Iterable<string>): ModelEvidenceState {
  return classifyModelEvidence([...values].map(normalizeModelId))
}

/** Every distinct raw served id behind an observation, sorted — forensics, not comparison. */
export function distinctServedModelIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(value => value.length > 0))].sort()
}

/**
 * True when configured and served evidence are both known and name different
 * top-level models. A dated snapshot of the configured model is agreement.
 */
export function modelEvidenceMismatched(configured: ModelEvidenceState, served: ModelEvidenceState): boolean {
  if (configured.status !== 'known' || served.status !== 'known') return false
  return !modelIdsEquivalent(configured.model, served.model)
}

export function modelEvidenceStatesEqual(a: ModelEvidenceState, b: ModelEvidenceState): boolean {
  if (a.status !== b.status) return false
  if (a.status === 'known' && b.status === 'known') return a.model === b.model
  if (a.status === 'unknown' && b.status === 'unknown') return true
  if (a.status !== 'mixed' || b.status !== 'mixed') return false
  return a.includesUnknown === b.includesUnknown &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
}
