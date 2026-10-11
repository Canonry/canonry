import type { QueryTrackingContextInput, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { providerDisplayName } from '../../../lib/visibility-trend-helpers.js'
import type { TrackedContextLabels } from './advanced/TrackedRowDetail.js'

export function contextInput(context: QueryTrackingWorkspaceResponse['defaultContexts'][number]): QueryTrackingContextInput {
  return {
    providers: [...context.providers],
    models: { ...context.models },
    location: context.location?.label ?? null,
  }
}

export function contextKey(context: QueryTrackingContextInput): string {
  return JSON.stringify({
    providers: [...context.providers].sort(),
    models: Object.fromEntries(Object.entries(context.models).sort(([left], [right]) => left.localeCompare(right))),
    location: context.location,
  })
}

export function uniqueContextInputs(contexts: readonly QueryTrackingContextInput[]): QueryTrackingContextInput[] {
  return [...new Map(contexts.map(context => [contextKey(context), context])).values()]
}

export function contextLabel(context: QueryTrackingContextInput): string {
  const engines = context.providers.map(provider => {
    const model = context.models[provider]
    return model ? `${provider} (${model})` : provider
  }).join(', ')
  return `${context.location ?? 'No search location'} · ${engines}`
}

/** The distinct search location and engines among stored contexts, named as the Add query form names them. */
export function contextLabels(contexts: QueryTrackingWorkspaceResponse['defaultContexts']): string[] {
  return uniqueContextInputs(contexts.map(contextInput)).map(contextLabel)
}

/**
 * Where a query is asked, as a tracked row's detail names it: the search location and
 * its engines by display name, with the Add query form's words for them, model
 * ids included, behind the value. Two that read alike by display name anywhere
 * in the workspace (one engine on two models) keep the form's words.
 */
export function searchLocationNames(workspace: Pick<QueryTrackingWorkspaceResponse, 'defaultContexts' | 'tracked'>): TrackedContextLabels {
  const names = new Map<string, string>()
  const stored = [...workspace.defaultContexts, ...workspace.tracked.flatMap(row => row.assignments.flatMap(assignment => assignment.contexts))]
  for (const context of stored) {
    const detail = contextLabel(contextInput(context))
    if (!names.has(detail)) names.set(detail, `${context.location?.label ?? 'No search location'} · ${context.providers.map(providerDisplayName).join(', ')}`)
  }
  const uses = new Map<string, number>()
  for (const name of names.values()) uses.set(name, (uses.get(name) ?? 0) + 1)
  return contexts => contextLabels(contexts).map(detail => {
    const name = names.get(detail)
    return { label: name !== undefined && uses.get(name) === 1 ? name : detail, detail }
  })
}
