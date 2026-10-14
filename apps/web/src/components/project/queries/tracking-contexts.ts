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

type StoredContexts = Pick<QueryTrackingWorkspaceResponse, 'defaultContexts' | 'tracked'>

/**
 * Names a search location and its engines from the Add query form's words for
 * it: the search location and the engines by display name, with the form's
 * words, model ids included, as the detail. Two that read alike by display
 * name anywhere in the workspace (one engine on two models) keep the form's
 * words, and so does one that is neither in the workspace nor in `more`.
 */
function searchLocationNamer(workspace: StoredContexts, more: readonly QueryTrackingContextInput[] = []): (detail: string) => { label: string; detail: string } {
  const names = new Map<string, string>()
  const stored = [...workspace.defaultContexts, ...workspace.tracked.flatMap(row => row.assignments.flatMap(assignment => assignment.contexts))]
  for (const context of [...stored.map(contextInput), ...more]) {
    const detail = contextLabel(context)
    if (!names.has(detail)) names.set(detail, `${context.location ?? 'No search location'} · ${context.providers.map(providerDisplayName).join(', ')}`)
  }
  const uses = new Map<string, number>()
  for (const name of names.values()) uses.set(name, (uses.get(name) ?? 0) + 1)
  return detail => {
    const name = names.get(detail)
    return { label: name !== undefined && uses.get(name) === 1 ? name : detail, detail }
  }
}

/** Where a query is asked, as a tracked row's detail names it (`searchLocationNamer`). */
export function searchLocationNames(workspace: StoredContexts): TrackedContextLabels {
  const named = searchLocationNamer(workspace)
  return contexts => contextLabels(contexts).map(named)
}

/**
 * The distinct search location and engines the plan's rows are asked with, the
 * most used first. One at a search location the project no longer has is left
 * out: a new query cannot be asked from it.
 */
function plannedContexts(workspace: StoredContexts): QueryTrackingContextInput[] {
  const configured = new Set(workspace.defaultContexts.map(context => context.location?.label ?? null))
  const used = new Map<string, { input: QueryTrackingContextInput; uses: number }>()
  for (const row of workspace.tracked) {
    for (const assignment of row.assignments) {
      for (const input of assignment.contexts.map(contextInput)) {
        if (input.location !== null && !configured.has(input.location)) continue
        const key = contextKey(input)
        const entry = used.get(key)
        if (entry) entry.uses += 1
        else used.set(key, { input, uses: 1 })
      }
    }
  }
  return [...used.values()].sort((left, right) => right.uses - left.uses || contextLabel(left.input).localeCompare(contextLabel(right.input))).map(entry => entry.input)
}

/** One choice of where a new query is asked: its name, the Add query form's words for it (model ids included) and what a change sends. */
export interface ContextChoice { label: string; detail: string; input: QueryTrackingContextInput }

/**
 * The search location and engines a query that takes its own can be asked
 * with: what the plan's rows are asked with first, then the project's own
 * setting, each once. The two can differ (a plan published on three engines,
 * a project now set to two), and a query added beside the plan's is offered
 * the plan's. `more` are choices a form already holds, listed last. Labels
 * are unique, so a select can key on them.
 */
export function contextChoices(workspace: StoredContexts, more: readonly QueryTrackingContextInput[] = []): ContextChoice[] {
  const named = searchLocationNamer(workspace, more)
  // The first of each is kept, as it is stored: the plan's own before the project's, and a form's last.
  const listed = new Set<string>()
  return [...plannedContexts(workspace), ...workspace.defaultContexts.map(contextInput), ...more].flatMap(input => {
    const key = contextKey(input)
    if (listed.has(key)) return []
    listed.add(key)
    return [{ ...named(contextLabel(input)), input }]
  })
}

/**
 * The same choices for a sheet, which takes a label and what to send. A sheet
 * names a lone choice itself, by display name, with the label given here
 * behind that name, so a lone choice is labelled with the form's own words
 * and its model ids stay in reach. Several are a select of their names.
 */
export function sheetContextChoices(workspace: StoredContexts): { label: string; input: QueryTrackingContextInput }[] {
  const choices = contextChoices(workspace)
  return choices.map(choice => ({ label: choices.length === 1 ? choice.detail : choice.label, input: choice.input }))
}

/** What a form for a new query opens on: the plan's own search location and engines, when every row of it is asked one way. */
export function plannedContext(workspace: StoredContexts): QueryTrackingContextInput | undefined {
  const planned = plannedContexts(workspace)
  return planned.length === 1 ? planned[0] : undefined
}
