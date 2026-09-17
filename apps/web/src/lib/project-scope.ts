/**
 * Where the project context row puts measurement scope, per tab.
 *
 * Scope filters only AI Visibility and tracked Queries. Every other tab covers
 * the whole project, so the row says so instead of offering a control that
 * would change nothing on the page. Each tab keeps its own recovery for a saved
 * scope that no longer exists; the row only reports it.
 */
import type { QueryTrackingMode, QueryTrackingWorkspaceResponse, VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import type { ViewerResearchConfig } from '../api.js'
import type { AdvancedMeasurementSurface } from '../components/project/advanced-measurement/model.js'
import type { ProjectPageTab } from '../pages/ProjectPage.js'
import type { VisibilitySelectionState } from './measurement-view-url.js'

export type QueryWorkspace = 'tracked' | 'research'

/** The plan-derived overview surface, or `unresolved` while neither plan read has landed. */
export type ProjectScopeSurface = AdvancedMeasurementSurface | 'unresolved'

/** The query-tracking workspace read as the row sees it. */
export type ProjectScopeTracking =
  | { state: 'pending' | 'error' }
  | { state: 'ready'; mode: QueryTrackingMode; scopeUnavailable: boolean }

export type ProjectScopeSlot =
  | { kind: 'report-picker' }
  | { kind: 'tracking-picker' }
  | { kind: 'scope-unavailable' }
  | { kind: 'project-wide' }
  | { kind: 'none' }

export interface ProjectScopeSlotInput {
  tab: ProjectPageTab
  surface: ProjectScopeSurface
  embedded: boolean
  /** See `isMeasurementScoped`. */
  scoped: boolean
  /** The effective workspace, after research access is applied. */
  queryWorkspace: QueryWorkspace
  tracking: ProjectScopeTracking
}

export const PROJECT_SCOPE_COPY = {
  projectWide: 'Project-wide',
  projectWideHelp: 'This tab covers the whole project. Your measurement scope stays selected for AI Visibility and Queries.',
  savedScopeUnavailable: 'Saved scope unavailable',
} as const

/** Operators always have Research; a viewer needs the deployment's research grant. */
export function canUseResearchWorkspace(role: 'admin' | 'viewer' | undefined, viewerResearchConfig: ViewerResearchConfig | null): boolean {
  return role !== 'viewer' || viewerResearchConfig !== null
}

/** A Research link opened without research access shows Tracked instead. */
export function effectiveQueryWorkspace(requested: QueryWorkspace, canUseResearch: boolean): QueryWorkspace {
  return requested === 'research' && !canUseResearch ? 'tracked' : requested
}

/** Whether the URL names a tracking scope the current workspace no longer has. */
export function unavailableTrackingScope(
  workspace: Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>,
  selection: Pick<VisibilitySelectionState, 'measurementScope' | 'measurementScopeKey'>,
): boolean {
  if (selection.measurementScope === 'project') return false
  if (!selection.measurementScopeKey) return true
  const scopes = selection.measurementScope === 'group'
    ? workspace.groups
    : selection.measurementScope === 'property'
      ? workspace.targets
      : workspace.markets
  return !scopes.some(scope => scope.stableKey === selection.measurementScopeKey)
}

/**
 * The option a URL selection names: the project option by kind alone, any
 * other scope by kind and key. `undefined` when the options lack it.
 */
export function selectedScopeOption<Option extends Pick<VisibilityReportScopeOption, 'id' | 'kind'>>(
  options: readonly Option[],
  selection: Pick<VisibilitySelectionState, 'measurementScope' | 'measurementScopeKey'>,
): Option | undefined {
  return options.find(option => option.kind === selection.measurementScope
    && (option.kind === 'project' || option.id === selection.measurementScopeKey))
}

/** A selection narrower than the whole project: a scope, or a market refinement. */
export function isMeasurementScoped(selection: Pick<VisibilitySelectionState, 'measurementScope' | 'marketKey'>): boolean {
  return selection.measurementScope !== 'project' || selection.marketKey !== undefined
}

export function projectScopeSlot(input: ProjectScopeSlotInput): ProjectScopeSlot {
  // Embeds are read-only client views with no scope control.
  if (input.embedded) return { kind: 'none' }
  const { tab } = input
  switch (tab) {
    case 'overview':
      // Only the v2 report offers scope options.
      return input.surface === 'advanced-overview' ? { kind: 'report-picker' } : { kind: 'none' }
    case 'queries':
    case 'discovery': {
      // Every role loads the tracking workspace, but viewers load no plan reads
      // here, so the workspace decides and the plan surface never does.
      const { tracking } = input
      if (input.queryWorkspace !== 'tracked' || tracking.state !== 'ready' || tracking.mode !== 'advanced') return { kind: 'none' }
      return tracking.scopeUnavailable ? { kind: 'scope-unavailable' } : { kind: 'tracking-picker' }
    }
    case 'search-console':
    case 'activity':
    case 'technical-aeo':
    case 'conversions':
    case 'local':
    case 'backlinks':
    case 'report':
    case 'history':
      return input.scoped && input.surface === 'advanced-overview' ? { kind: 'project-wide' } : { kind: 'none' }
    case 'settings':
    case 'portfolio':
      return { kind: 'none' }
    default: {
      const unhandled: never = tab
      return unhandled
    }
  }
}
