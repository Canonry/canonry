import { describe, expect, it } from 'vitest'
import type { QueryTrackingWorkspaceResponse, VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import type { ProjectPageTab } from '../src/pages/ProjectPage.js'
import {
  canUseResearchWorkspace,
  effectiveQueryWorkspace,
  isMeasurementScoped,
  PROJECT_SCOPE_COPY,
  projectScopeSlot,
  selectedScopeOption,
  unavailableTrackingScope,
  type ProjectScopeSlot,
  type ProjectScopeSurface,
  type ProjectScopeTracking,
  type QueryWorkspace,
} from '../src/lib/project-scope.js'

const TABS = [
  'overview', 'portfolio', 'search-console', 'conversions', 'local', 'queries', 'discovery',
  'report', 'activity', 'backlinks', 'technical-aeo', 'history', 'settings',
] as const satisfies readonly ProjectPageTab[]

const SURFACES = ['simple-overview', 'advanced-overview-v1', 'advanced-overview', 'unresolved'] as const satisfies readonly ProjectScopeSurface[]
const WORKSPACES = ['tracked', 'research'] as const satisfies readonly QueryWorkspace[]
const TRACKING: Record<string, ProjectScopeTracking> = {
  pending: { state: 'pending' },
  error: { state: 'error' },
  simple: { state: 'ready', mode: 'simple', scopeUnavailable: false },
  'simple with an unavailable scope': { state: 'ready', mode: 'simple', scopeUnavailable: true },
  advanced: { state: 'ready', mode: 'advanced', scopeUnavailable: false },
  'advanced with an unavailable scope': { state: 'ready', mode: 'advanced', scopeUnavailable: true },
}

const QUERY_TABS: readonly ProjectPageTab[] = ['queries', 'discovery']
const SCOPE_BLIND_TABS: readonly ProjectPageTab[] = ['search-console', 'activity', 'technical-aeo', 'conversions', 'local', 'backlinks', 'report', 'history']

type SlotInput = Parameters<typeof projectScopeSlot>[0]

/** The plan's D2 table, row by row. Embed always wins. */
function tableSlot(input: SlotInput): ProjectScopeSlot['kind'] {
  if (input.embedded) return 'none'
  if (input.tab === 'overview') return input.surface === 'advanced-overview' ? 'report-picker' : 'none'
  if (QUERY_TABS.includes(input.tab)) {
    // Tracked Queries read the tracking workspace for every role, never the plan surface.
    if (input.queryWorkspace === 'research') return 'none'
    if (input.tracking.state !== 'ready' || input.tracking.mode === 'simple') return 'none'
    return input.tracking.scopeUnavailable ? 'scope-unavailable' : 'tracking-picker'
  }
  if (SCOPE_BLIND_TABS.includes(input.tab)) return input.scoped && input.surface === 'advanced-overview' ? 'project-wide' : 'none'
  return 'none'
}

describe('projectScopeSlot', () => {
  it('follows the scope table for every tab, surface, scope, workspace, tracking state, and embed', () => {
    const counts: Record<ProjectScopeSlot['kind'], number> = { 'report-picker': 0, 'tracking-picker': 0, 'scope-unavailable': 0, 'project-wide': 0, none: 0 }
    const mismatches: string[] = []
    for (const tab of TABS) for (const surface of SURFACES) for (const scoped of [false, true]) {
      for (const queryWorkspace of WORKSPACES) for (const [trackingName, tracking] of Object.entries(TRACKING)) for (const embedded of [false, true]) {
        const input: SlotInput = { tab, surface, scoped, queryWorkspace, tracking, embedded }
        const slot = projectScopeSlot(input)
        counts[slot.kind] += 1
        if (slot.kind !== tableSlot(input)) {
          mismatches.push(`${tab} ${surface} scoped=${scoped} ${queryWorkspace} ${trackingName} embedded=${embedded}: ${slot.kind}`)
        }
      }
    }
    expect(mismatches).toEqual([])
    // 13 tabs x 4 surfaces x 2 scope states x 2 workspaces x 6 tracking states x 2 embed states.
    expect(counts).toEqual({
      'report-picker': 24, // overview x v2 x 2 x 2 x 6
      'tracking-picker': 16, // queries+discovery x 4 surfaces x 2 x tracked x advanced
      'scope-unavailable': 16,
      'project-wide': 96, // 8 scope-blind tabs x v2 x scoped x 2 x 6
      none: 2344,
    })
  })

  it('decides tracked Queries from the tracking workspace even when the plan surface looks Simple', () => {
    // A viewer on Queries loads no plan reads, so the surface resolves to Simple.
    const viewer = { tab: 'queries', surface: 'simple-overview', scoped: false, queryWorkspace: 'tracked', embedded: false } as const
    expect(projectScopeSlot({ ...viewer, tracking: { state: 'ready', mode: 'advanced', scopeUnavailable: false } })).toEqual({ kind: 'tracking-picker' })
    expect(projectScopeSlot({ ...viewer, tracking: { state: 'ready', mode: 'advanced', scopeUnavailable: true } })).toEqual({ kind: 'scope-unavailable' })
    // A v1 plan makes the tracking read fail; the body owns that error.
    expect(projectScopeSlot({ ...viewer, surface: 'advanced-overview-v1', tracking: { state: 'error' } })).toEqual({ kind: 'none' })
    expect(projectScopeSlot({ ...viewer, surface: 'advanced-overview', tracking: { state: 'ready', mode: 'simple', scopeUnavailable: false } })).toEqual({ kind: 'none' })
  })

  it('shows Project-wide on a scope-blind tab only for a scoped v2 selection', () => {
    const siteHealth = { tab: 'technical-aeo', queryWorkspace: 'tracked', tracking: { state: 'pending' }, embedded: false } as const
    expect(projectScopeSlot({ ...siteHealth, surface: 'advanced-overview', scoped: true })).toEqual({ kind: 'project-wide' })
    expect(projectScopeSlot({ ...siteHealth, surface: 'advanced-overview', scoped: false })).toEqual({ kind: 'none' })
    expect(projectScopeSlot({ ...siteHealth, surface: 'advanced-overview-v1', scoped: true })).toEqual({ kind: 'none' })
    expect(projectScopeSlot({ ...siteHealth, surface: 'unresolved', scoped: true })).toEqual({ kind: 'none' })
    expect(projectScopeSlot({ ...siteHealth, tab: 'settings', surface: 'advanced-overview', scoped: true })).toEqual({ kind: 'none' })
    expect(projectScopeSlot({ ...siteHealth, surface: 'advanced-overview', scoped: true, embedded: true })).toEqual({ kind: 'none' })
  })
})

describe('isMeasurementScoped', () => {
  it('treats a non-project scope or any market refinement as scoped', () => {
    expect(isMeasurementScoped({ measurementScope: 'project' })).toBe(false)
    expect(isMeasurementScoped({ measurementScope: 'project', marketKey: 'coastal-maine' })).toBe(true)
    expect(isMeasurementScoped({ measurementScope: 'group', measurementScopeKey: 'north' })).toBe(true)
    expect(isMeasurementScoped({ measurementScope: 'property', measurementScopeKey: 'harbor-house' })).toBe(true)
  })
})

describe('query workspace access', () => {
  it('lets operators and granted viewers use Research, and coerces other viewers to Tracked', () => {
    expect(canUseResearchWorkspace(undefined, null)).toBe(true)
    expect(canUseResearchWorkspace('admin', null)).toBe(true)
    expect(canUseResearchWorkspace('viewer', null)).toBe(false)
    expect(canUseResearchWorkspace('viewer', { allowViewers: true, viewerDailyRunLimit: 5 })).toBe(true)

    expect(effectiveQueryWorkspace('research', false)).toBe('tracked')
    expect(effectiveQueryWorkspace('research', true)).toBe('research')
    expect(effectiveQueryWorkspace('tracked', false)).toBe('tracked')
    expect(effectiveQueryWorkspace('tracked', true)).toBe('tracked')
    // A viewer without research access who follows a Research link sees Tracked.
    expect(effectiveQueryWorkspace('research', canUseResearchWorkspace('viewer', null))).toBe('tracked')
  })
})

describe('unavailableTrackingScope', () => {
  const workspace = {
    targets: [{ stableKey: 'harbor-house', label: 'Harbor House' }],
    groups: [{ stableKey: 'north', label: 'North', targetKeys: ['harbor-house'] }],
    markets: [{ stableKey: 'coastal-maine', label: 'Coastal Maine', usageEdges: [] }],
  } satisfies Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>

  it('finds each scope only in its own collection', () => {
    expect(unavailableTrackingScope(workspace, { measurementScope: 'project' })).toBe(false)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'group' })).toBe(true)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'group', measurementScopeKey: 'north' })).toBe(false)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'group', measurementScopeKey: 'south' })).toBe(true)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'property', measurementScopeKey: 'harbor-house' })).toBe(false)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'property', measurementScopeKey: 'north' })).toBe(true)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'market', measurementScopeKey: 'coastal-maine' })).toBe(false)
    expect(unavailableTrackingScope(workspace, { measurementScope: 'market', measurementScopeKey: 'harbor-house' })).toBe(true)
  })
})

describe('selectedScopeOption', () => {
  const options: VisibilityReportScopeOption[] = [
    { id: 'project', label: 'Project', kind: 'project', targetCount: 2 },
    { id: 'north', label: 'North', kind: 'group', targetCount: 2 },
    { id: 'north', label: 'North', kind: 'market', targetCount: 2 },
    { id: 'harbor-house', label: 'Harbor House', kind: 'property', targetCount: 1 },
  ]

  it('matches the URL scope by kind and key, and the project option by kind alone', () => {
    expect(selectedScopeOption(options, { measurementScope: 'project' })).toBe(options[0])
    expect(selectedScopeOption(options, { measurementScope: 'group', measurementScopeKey: 'north' })).toBe(options[1])
    expect(selectedScopeOption(options, { measurementScope: 'market', measurementScopeKey: 'north' })).toBe(options[2])
    expect(selectedScopeOption(options, { measurementScope: 'property', measurementScopeKey: 'north' })).toBeUndefined()
    expect(selectedScopeOption(options, { measurementScope: 'group', measurementScopeKey: 'south' })).toBeUndefined()
    expect(selectedScopeOption(options.slice(1), { measurementScope: 'project' })).toBeUndefined()
  })
})

describe('PROJECT_SCOPE_COPY', () => {
  it('names the row notices', () => {
    expect(PROJECT_SCOPE_COPY).toEqual({
      projectWide: 'Project-wide',
      projectWideHelp: 'This tab covers the whole project. Your measurement scope stays selected for AI Visibility and Queries.',
      savedScopeUnavailable: 'Saved scope unavailable',
    })
  })
})
