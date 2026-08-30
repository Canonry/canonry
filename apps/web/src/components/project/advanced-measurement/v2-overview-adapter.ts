import type {
  MeasurementOverviewResponse,
  MeasurementPlanResponse,
  MeasurementReportResponse,
} from '@ainyc/canonry-api-client'

import type {
  AdvancedMeasurementEvidence,
  AdvancedMeasurementMetric,
  AdvancedMeasurementOverviewReport,
  AdvancedMeasurementProperty,
  AdvancedMeasurementSort,
} from './AdvancedMeasurementOverview.js'

type ActivePlan = NonNullable<MeasurementPlanResponse['active']>
type PlanV2 = Extract<ActivePlan['plan'], { schemaVersion: 2 }>
type OverviewMetric = MeasurementOverviewResponse['metrics']['mentionCoverage']
type ReportEvidence = MeasurementReportResponse['evidence'][number]

export interface AdaptV2MeasurementOverviewInput {
  overview: MeasurementOverviewResponse
  activePlan: ActivePlan
  report?: MeasurementReportResponse | null
  reportState?: 'loading' | 'ready' | 'error'
  /** The ordering the caller requested; the response does not echo it. */
  sort?: AdvancedMeasurementSort
}

export function areV2OverviewPagesCompatible(pages: readonly MeasurementOverviewResponse[]): boolean {
  const firstPage = pages[0]
  if (!firstPage) return true
  return pages.every(page => page.mode === firstPage.mode
    && page.scope.kind === firstPage.scope.kind
    && page.scope.key === firstPage.scope.key
    && page.queryClass === firstPage.queryClass
    && page.measurement.displayedRunId === firstPage.measurement.displayedRunId)
}

function metric(value: OverviewMetric): AdvancedMeasurementMetric {
  if (value.state === 'unavailable') {
    return { numerator: null, denominator: null, reason: value.reason }
  }
  if (value.numerator === undefined || value.denominator === undefined || value.denominator <= 0) {
    return { numerator: null, denominator: null, reason: 'not_applicable' }
  }
  return { numerator: value.numerator, denominator: value.denominator }
}

/** The one rendering of a frozen URL matcher. The Property page reuses it so the two surfaces cannot print the same matcher differently. */
export function matcherLabel(matcher: PlanV2['targets'][number]['urlMatchers'][number]): string {
  if (matcher.kind === 'exact') return matcher.url
  if (matcher.kind === 'prefix') return `https://${matcher.host}${matcher.pathPrefix}/*`
  return `https://${matcher.host}/*`
}

function evidenceKind(classification: ReportEvidence['classification']): AdvancedMeasurementEvidence['kind'] {
  if (classification === 'assigned') return 'this-property'
  if (classification === 'sibling') return 'another-property'
  if (classification === 'ownedUnmapped') return 'owned-unassigned'
  if (classification === 'external') return 'external'
  if (classification === 'ambiguous') return 'multiple-properties'
  return 'invalid-url'
}

function evidenceTone(classification: ReportEvidence['classification']): AdvancedMeasurementEvidence['tone'] {
  if (classification === 'assigned') return 'positive'
  if (classification === 'external') return 'neutral'
  if (classification === 'invalid') return 'negative'
  return 'caution'
}

function edgeId(edge: PlanV2['usageEdges'][number]): string {
  return `target:${edge.targetKey}:${edge.queryId}:${edge.executionNodeKey}`
}

/** One linear pass, independent of the number of Properties rendered. */
export function indexV2EvidenceByTarget(
  plan: PlanV2,
  report?: MeasurementReportResponse | null,
  queryClass?: 'branded' | 'non-brand',
): ReadonlyMap<string, AdvancedMeasurementEvidence[]> {
  const indexed = new Map<string, AdvancedMeasurementEvidence[]>()
  if (!report) return indexed
  const targetByEdge = new Map(plan.usageEdges.map(edge => [edgeId(edge), edge.targetKey]))
  const classByAssignment = new Map(plan.assignments.map(assignment => [
    `${assignment.targetKey}:${assignment.queryId}`,
    assignment.queryClass,
  ]))
  const classByEdge = new Map(plan.usageEdges.map(edge => [
    edgeId(edge),
    classByAssignment.get(`${edge.targetKey}:${edge.queryId}`),
  ]))
  for (const item of report.evidence) {
    if (queryClass && classByEdge.get(item.usageEdgeId) !== queryClass) continue
    const targetKey = targetByEdge.get(item.usageEdgeId)
    if (!targetKey) continue
    const rows = indexed.get(targetKey) ?? []
    rows.push({
      id: `${item.observationId}:${item.expectedSlotId}:${item.usageEdgeId}:${item.sourceUrl}`,
      kind: evidenceKind(item.classification),
      query: item.queryText,
      provider: item.provider,
      location: item.location,
      url: item.sourceUrl,
      tone: evidenceTone(item.classification),
      historical: item.historical || item.bridged,
    })
    indexed.set(targetKey, rows)
  }
  return indexed
}

function propertyStatus(row: MeasurementOverviewResponse['properties']['items'][number]): AdvancedMeasurementProperty['status'] {
  if (row.flags > 0) return { label: 'Ambiguous match', tone: 'caution' }
  const reasons = [row.mentionCoverage, row.citationCoverage]
    .filter((value): value is Extract<typeof value, { state: 'unavailable' }> => value.state === 'unavailable')
    .map(value => value.reason)
  if (reasons.includes('no_completed_run')) return { label: 'Not measured', tone: 'neutral' }
  if (reasons.includes('plan_v1')) return { label: 'Update setup', tone: 'caution' }
  if (reasons.includes('evidence_incomplete')) return { label: 'Evidence incomplete', tone: 'caution' }
  if (reasons.includes('no_population')) return { label: 'No queries', tone: 'neutral' }
  if (reasons.includes('not_applicable')) return { label: 'Not applicable', tone: 'neutral' }
  return { label: 'Complete', tone: 'positive' }
}

function measurementStatus(state: MeasurementOverviewResponse['measurement']['state']): AdvancedMeasurementOverviewReport['latestMeasurement']['status'] {
  if (state === 'complete') return { label: 'Complete', tone: 'positive' }
  if (state === 'partial') return { label: 'Partial', tone: 'caution' }
  if (state === 'queued') return { label: 'Queued', tone: 'neutral' }
  if (state === 'running') return { label: 'Running', tone: 'neutral' }
  if (state === 'failed') return { label: 'Failed', tone: 'negative' }
  return { label: 'Not measured', tone: 'neutral' }
}

function reportDate(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function nextActionText(overview: MeasurementOverviewResponse): string | undefined {
  const count = overview.nextAction.count ?? overview.flags.total
  if (overview.nextAction.kind === 'review_flags') return `${count} ambiguous source-to-Property ${count === 1 ? 'match' : 'matches'}.`
  if (overview.nextAction.kind === 'complete_setup') return 'Finish setup.'
  if (overview.nextAction.kind === 'republish_setup') return 'Setup update required.'
  if (overview.nextAction.kind === 'run_measurement') return 'Ready to measure.'
  return undefined
}

export function adaptV2MeasurementOverview({
  overview,
  activePlan,
  report,
  reportState = report ? 'ready' : 'loading',
  sort,
}: AdaptV2MeasurementOverviewInput): AdvancedMeasurementOverviewReport {
  if (activePlan.plan.schemaVersion !== 2 || overview.mode !== 'active-v2') {
    throw new Error('The current overview requires an active version-two setup.')
  }
  if (overview.scope.kind !== 'all' && overview.scope.kind !== 'group') {
    throw new Error('The current overview requires an All Properties or group scope.')
  }

  const plan = activePlan.plan
  const targetByKey = new Map(plan.targets.map(target => [target.stableKey, target]))
  const queryById = new Map(plan.querySnapshots.map(query => [query.queryId, query.queryText]))
  const assignmentsByTarget = new Map<string, Set<string>>()
  for (const assignment of plan.assignments) {
    // `all` means every lane, so it filters nothing. Comparing it to a stored
    // class matched nothing and left every Property with no questions.
    if (overview.queryClass !== 'all' && assignment.queryClass !== overview.queryClass) continue
    const text = queryById.get(assignment.queryId)
    if (!text) continue
    const values = assignmentsByTarget.get(assignment.targetKey) ?? new Set<string>()
    values.add(text)
    assignmentsByTarget.set(assignment.targetKey, values)
  }

  const pinnedReport = report?.revision === activePlan.revision
    && report.run?.id === overview.measurement.displayedRunId
    ? report
    : null
  const evidenceState = overview.measurement.displayedRunId === undefined
    ? 'ready' as const
    : pinnedReport
    ? 'ready' as const
    : reportState === 'error' || report !== undefined && report !== null
      ? 'error' as const
      : 'loading' as const
  const evidenceByTarget = indexV2EvidenceByTarget(
    plan,
    pinnedReport,
    overview.queryClass === 'all' ? undefined : overview.queryClass,
  )
  // One Property belongs to at most one market in practice; when a plan puts it
  // in several, the first is named rather than a joined string, because the
  // subtitle is an identifier and not a list.
  const marketByTarget = new Map<string, string>()
  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) {
      if (!marketByTarget.has(targetKey)) marketByTarget.set(targetKey, group.label)
    }
  }
  const properties = overview.properties.items.map(row => {
    const configured = targetByKey.get(row.targetKey)
    const evidence = evidenceByTarget.get(row.targetKey) ?? []
    return {
      id: row.targetKey,
      name: row.label,
      mentionCoverage: metric(row.mentionCoverage),
      citationCoverage: metric(row.citationCoverage),
      status: propertyStatus(row),
      providers: row.providers?.map(entry => ({
        provider: entry.provider,
        mentionCoverage: metric(entry.mentionCoverage),
        citationCoverage: metric(entry.citationCoverage),
      })),
      market: marketByTarget.get(row.targetKey),
      assignedQueries: [...(assignmentsByTarget.get(row.targetKey) ?? [])],
      urls: configured?.urlMatchers.map(matcherLabel) ?? [],
      evidence,
      evidenceState,
      historical: evidence.some(item => item.historical),
    }
  })

  const shareOfVoice = overview.namedShareOfVoice?.entries.map(entry => ({
    name: entry.label,
    coverage: { numerator: entry.credits, denominator: overview.namedShareOfVoice!.denominator },
  }))
  const flaggedResults = overview.properties.items.flatMap(row => row.flags > 0 ? [{
    id: `property:${row.targetKey}`,
    property: row.label,
    summary: `${row.flags} ambiguous source-to-Property ${row.flags === 1 ? 'match' : 'matches'}.`,
    tone: 'caution' as const,
    count: row.flags,
  }] : [])

  return {
    classReporting: 'available',
    latestMeasurement: {
      status: measurementStatus(overview.measurement.state),
      completedSlots: overview.measurement.completed,
      totalSlots: overview.measurement.expected,
      date: reportDate(overview.measurement.completedAt),
      includesBridgedHistory: overview.measurement.includesHistoricalData === true,
    },
    currentView: {
      scope: overview.scope.kind === 'group'
        ? { kind: 'group', ...(overview.scope.key ? { key: overview.scope.key } : {}) }
        : { kind: 'all' },
      queryClass: overview.queryClass,
      aggregate: {
        metrics: {
          propertiesMentioned: metric(overview.metrics.propertiesMentioned),
          mentionCoverage: metric(overview.metrics.mentionCoverage),
          citationCoverage: metric(overview.metrics.citationCoverage),
        },
        properties,
        ...(shareOfVoice ? { shareOfVoice } : {}),
      },
      propertyTotal: overview.properties.totalEstimate ?? properties.length,
      outcomes: overview.outcomes,
      nextCursor: overview.properties.nextCursor,
      // The response does not echo the ordering it applied, so the requested
      // sort is threaded through here — the header state must reflect what was
      // actually asked for, not what the table happens to look like.
      ...(sort ? { sort } : {}),
    },
    availableGroups: plan.groups.map(group => ({ id: group.stableKey, label: group.label })),
    ...(nextActionText(overview) ? { nextActionText: nextActionText(overview) } : {}),
    flaggedResultsTotal: overview.flags.total,
    flaggedResults,
  }
}
