import {
  isRouteFamilyConnection,
  ProviderKinds,
  ProviderWorkflows,
  profileRouteFamily,
  routeFamiliesOf,
  type ProviderCatalogEntryDto,
  type ProviderRouteFamily,
  type ProviderWorkflow,
} from '@canonry/canonry-contracts'

type CatalogEntry = Pick<ProviderCatalogEntryDto, 'name' | 'kind' | 'connection' | 'selectionKind' | 'profiles' | 'workflows'>

/**
 * Route families the server's catalog describes: OpenRouter always, plus one
 * profile family per answer-service connection. Read from data, so a new
 * service needs no dashboard edit.
 */
export function catalogRouteFamilies(catalog: readonly CatalogEntry[]): ProviderRouteFamily[] {
  return routeFamiliesOf(catalog.flatMap(entry => entry.selectionKind === 'profile' && (entry.connection ?? entry.name) === entry.name && entry.profiles
    ? [{ routes: profileRouteFamily(entry.name, entry.profiles.map(profile => profile.id)) }]
    : []))
}

/** A routed connection (OpenRouter, an answer service) holds a key; it is never an engine to pick. */
export function isRoutedConnection(name: string, families: readonly ProviderRouteFamily[]): boolean {
  return isRouteFamilyConnection(name, families)
}

/** An answer-service route whose profile may run the workflow when someone picks it. */
export function isAnswerServiceRouteFor(entry: CatalogEntry, workflow: ProviderWorkflow): boolean {
  return entry.kind === ProviderKinds['answer-service']
    && (entry.connection ?? entry.name) !== entry.name
    && (entry.workflows ?? []).includes(workflow)
}

export const SWEEP_WORKFLOW = ProviderWorkflows['visibility-sweep']
export const RESEARCH_WORKFLOW = ProviderWorkflows.research
