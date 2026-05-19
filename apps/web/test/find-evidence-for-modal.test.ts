import { test, expect } from 'vitest'

import { findEvidenceForModal } from '../src/mock-data.js'
import type {
  CitationInsightVm,
  DashboardVm,
  ProjectCommandCenterVm,
} from '../src/view-models.js'

// Minimal shapes — only the fields findEvidenceForModal touches matter.

function makeEvidence(id: string): CitationInsightVm {
  return {
    id,
    query: 'test query',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    location: null,
    citationState: 'cited',
    changeLabel: '',
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    recommendedCompetitors: [],
    matchedTerms: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: [],
  } as unknown as CitationInsightVm
}

function makeCommandCenter(name: string, evidence: CitationInsightVm[]): ProjectCommandCenterVm {
  return {
    project: { id: `proj_${name}`, name, displayName: name },
    visibilityEvidence: evidence,
  } as unknown as ProjectCommandCenterVm
}

function makeDashboard(projects: ProjectCommandCenterVm[]): DashboardVm {
  return { projects } as unknown as DashboardVm
}

test('findEvidenceForModal prefers the project command center over the slim dashboard', () => {
  // Regression: this is the View-button bug. The slim `useDashboardOverview`
  // returns dashboard.projects[*].visibilityEvidence = [] by design (see
  // queries/use-dashboard-overview.ts). The full evidence list is on the
  // commandCenter built by useProjectDashboard. Without the cross-source
  // lookup, clicking View navigated the URL but the modal silently never
  // opened because the slim dashboard didn't have the evidence id.

  const evidence = makeEvidence('evidence_ainyc_0')
  const commandCenter = makeCommandCenter('ainyc', [evidence])
  const slimDashboard = makeDashboard([
    makeCommandCenter('ainyc', []),
  ])

  const result = findEvidenceForModal(commandCenter, slimDashboard, 'evidence_ainyc_0')

  expect(result).toBeDefined()
  expect(result!.evidence.id).toBe('evidence_ainyc_0')
  expect(result!.project.project.name).toBe('ainyc')
})

test('findEvidenceForModal falls back to the dashboard when the command center has no match', () => {
  // If the evidence id isn't in the currently-viewed project but is reachable
  // through the full dashboard walk (e.g. future cross-project deep link, or
  // a stale URL), we still find it.

  const evidence = makeEvidence('evidence_other_42')
  const commandCenter = makeCommandCenter('ainyc', [makeEvidence('evidence_ainyc_0')])
  const dashboard = makeDashboard([
    makeCommandCenter('ainyc', []),
    makeCommandCenter('other', [evidence]),
  ])

  const result = findEvidenceForModal(commandCenter, dashboard, 'evidence_other_42')

  expect(result).toBeDefined()
  expect(result!.evidence.id).toBe('evidence_other_42')
  expect(result!.project.project.name).toBe('other')
})

test('findEvidenceForModal works when only the dashboard is available (no project route)', () => {
  // Modal listener runs at the root layout, so on non-project routes
  // currentProjectCommandCenter is null. The dashboard walk is the only
  // available source.

  const evidence = makeEvidence('evidence_x_0')
  const dashboard = makeDashboard([makeCommandCenter('x', [evidence])])

  const result = findEvidenceForModal(null, dashboard, 'evidence_x_0')

  expect(result).toBeDefined()
  expect(result!.evidence.id).toBe('evidence_x_0')
})

test('findEvidenceForModal returns undefined when both sources lack the evidence', () => {
  const commandCenter = makeCommandCenter('ainyc', [makeEvidence('evidence_ainyc_0')])
  const dashboard = makeDashboard([makeCommandCenter('ainyc', [])])

  const result = findEvidenceForModal(commandCenter, dashboard, 'evidence_does_not_exist')

  expect(result).toBeUndefined()
})

test('findEvidenceForModal returns undefined when both sources are null/undefined', () => {
  expect(findEvidenceForModal(null, null, 'anything')).toBeUndefined()
  expect(findEvidenceForModal(undefined, undefined, 'anything')).toBeUndefined()
})
