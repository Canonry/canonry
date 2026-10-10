import type { QueryTrackingContextInput, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

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
  return `${context.location ?? 'No location'} · ${engines}`
}

/** The distinct search location and engines among stored contexts, named as the Add query form names them. */
export function contextLabels(contexts: QueryTrackingWorkspaceResponse['defaultContexts']): string[] {
  return uniqueContextInputs(contexts.map(contextInput)).map(contextLabel)
}
