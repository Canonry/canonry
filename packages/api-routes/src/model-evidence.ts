import type { ModelEvidenceState } from '@ainyc/canonry-contracts'

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

export function modelEvidenceStatesEqual(a: ModelEvidenceState, b: ModelEvidenceState): boolean {
  if (a.status !== b.status) return false
  if (a.status === 'known' && b.status === 'known') return a.model === b.model
  if (a.status === 'unknown' && b.status === 'unknown') return true
  if (a.status !== 'mixed' || b.status !== 'mixed') return false
  return a.includesUnknown === b.includesUnknown &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
}
