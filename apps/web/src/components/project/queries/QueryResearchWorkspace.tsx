import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { MeasurementQueryTemplate, QueryTrackingMode, QueryTrackingWorkspaceResponse, ResearchRunScope } from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
} from '@canonry/canonry-api-client/react-query'

import { heyClient, isEmbed, isPublicDemo } from '../../../api.js'
import type { ViewerResearchConfig } from '../../../api.js'
import { useAccount } from '../../../contexts/account-context.js'
// The host imports this file too. Take only types and function declarations from it: those need no load order.
import type { QueriesSectionProps, ResearchWorkspaceMode, SavedTrackingSource } from '../DiscoverySection.js'
import { ResearchQueriesSection, ResearchStartControl, type ResearchTemplateOption } from '../ResearchQueriesSection.js'
import { FindQueriesSection } from './FindQueriesSection.js'
import { statusLabel, subjectLabel, toTrackedRows } from './advanced/tracked-view-model.js'
import { ResearchTrackingContext, type ResearchTracking } from './research/ResearchResults.js'
import { TrackResearchBar, useTrackSelection } from './research/TrackResearchSheet.js'

const NO_SCOPE_OPTIONS: NonNullable<QueryTrackingWorkspaceResponse['scopeOptions']> = []
const NO_TEMPLATES: readonly MeasurementQueryTemplate[] = []

/**
 * Research is one page under the Tracked | Research row, with no tab row of
 * its own. "Start from" picks the form: Write, Pattern, or Find ideas, which
 * only an account that can write gets. The choice is the host's `researchMode`,
 * so a link or a reload opens the same form; with none named the page opens on
 * Write, which reads saved runs and starts nothing.
 *
 * A form is drawn once it has been chosen and then kept, hidden while the
 * other shows. An arrow key passes through every choice of "Start from", so a
 * draft, a preview and the last batch's runs have to outlive the trip. A link
 * that names Find ideas still reads nothing of Write or Pattern.
 *
 * On an Advanced project a result is tracked from here: a Tracked column says
 * which queries are tracked already, the rest can be ticked, and the bar for
 * the ticked rows opens the Track sheet, which ends in the shared review. Rows
 * ticked in several runs go in one publish, each for its own run's Subject.
 * Find ideas reads the tracked queries only once a run lists results. A
 * Simple project keeps "Review for tracking", which hands one result to the
 * Add query form on Tracked. So does Find ideas while the project's mode is
 * not known: it reads nothing of the plan to learn it.
 */
export function QueryResearchWorkspace({
  projectName,
  selection,
  mode,
  onModeChange,
  onReviewSavedSource,
  viewerResearchConfig,
  trackedMode,
  sweepActive = false,
  nextSweepDate,
  paused = false,
}: {
  projectName: string
  selection: NonNullable<QueriesSectionProps['selection']>
  mode?: ResearchWorkspaceMode
  onModeChange: (mode: ResearchWorkspaceMode) => void
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
  /** A Simple project's way into tracking: one saved result, in the Add query form. */
  onReviewSavedSource: (source: SavedTrackingSource, scope?: ResearchRunScope | null) => void
  viewerResearchConfig: ViewerResearchConfig | null
  /** The project's mode where the host already knows it. The tracked queries, once read, have the last word. */
  trackedMode?: QueryTrackingMode
  /** A sweep is queued or running, so the review holds Publish back. */
  sweepActive?: boolean
  nextSweepDate?: string
  /** The Tracked workspace is visible; retain drafts but stop background reads and focus changes. */
  paused?: boolean
}) {
  const { canWrite } = useAccount()
  const navigate = useNavigate()
  const start: ResearchWorkspaceMode = mode === 'find' && canWrite ? 'find' : mode === 'pattern' ? 'pattern' : 'write'
  // The form Write and Pattern share, as last chosen. Null until one of them has been shown.
  const [form, setForm] = useState<Exclude<ResearchWorkspaceMode, 'find'> | null>(start === 'find' ? null : start)
  if (start !== 'find' && form !== start) setForm(start)
  const [findShown, setFindShown] = useState(start === 'find')
  if (start === 'find' && !findShown) setFindShown(true)
  // Find ideas is another form with its own copy of "Start from". A choice made on one lands focus on the other's, so arrow keys keep working across the swap.
  // Only a choice that changes the form moves focus: a change that comes from the host, such as Back, leaves it where the reader put it.
  const researchPane = useRef<HTMLDivElement>(null)
  const findPane = useRef<HTMLDivElement>(null)
  const chosen = useRef<ResearchWorkspaceMode | null>(null)
  const changeStart = (next: ResearchWorkspaceMode) => { chosen.current = next === start ? null : next; onModeChange(next) }
  useEffect(() => {
    const picked = chosen.current === start
    chosen.current = null
    if (picked && !paused) (start === 'find' ? findPane : researchPane).current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
  }, [start, paused])
  // Find ideas reads neither the plan nor the saved patterns. On an Advanced project it reads the tracked queries once a run lists results to tick.
  const researchWorkspaceEnabled = start !== 'find'
  const [findListsResults, setFindListsResults] = useState(false)
  const onFindResultsListed = useCallback(() => setFindListsResults(true), [])
  const [knownAdvanced, setKnownAdvanced] = useState(false)
  const workspaceQuery = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !paused && (researchWorkspaceEnabled || (findListsResults && (trackedMode === 'advanced' || knownAdvanced))),
    staleTime: 60_000,
  })
  const workspace = workspaceQuery.data
  const advanced = (workspace?.mode ?? trackedMode) === 'advanced'
  // Kept once read, so Find ideas goes on following the tracked queries after a publish.
  if (workspace?.mode === 'advanced' && !knownAdvanced) setKnownAdvanced(true)
  // An embed keeps the Research page it had: no Tracked column, and so nothing to tick. The public demo reads the column and ticks nothing.
  const tracksHere = advanced && !isEmbed()
  const canTrack = canWrite && !isPublicDemo()
  // Every tracked query by its identity text, with its Subject as the Tracked table words it. One that is asked nowhere has no Subject to name.
  const subjects = useMemo(() => workspace?.mode === 'advanced'
    ? new Map(toTrackedRows(workspace, NO_TEMPLATES).map(row => [row.tracked.normalizedText, row.subject.kind === 'none' ? statusLabel('not-asked') : subjectLabel(row.subject)]))
    : undefined, [workspace])
  const picks = useTrackSelection(subjects)
  const barId = useId()
  const trackedFailed = !workspace && workspaceQuery.isError
  const retryTracked = workspaceQuery.refetch
  const researchTracking = useMemo<ResearchTracking | null>(() => tracksHere ? {
    subjects,
    failed: trackedFailed,
    onRetry: () => { void retryTracked() },
    selection: canTrack ? { pickedIds: picks.pickedIds, onPick: picks.pick, barId } : undefined,
  } : null, [tracksHere, subjects, trackedFailed, retryTracked, canTrack, picks.pickedIds, picks.pick, barId])
  // Track and Clear take the bar off the page: the results table's first box takes the focus, or the Results heading.
  const focusResults = () => {
    const results = researchPane.current?.querySelector('[role="region"]')
    ;(results?.querySelector<HTMLElement>('table input:not(:disabled)') ?? results?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true })
  }
  const researchTemplatesQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementQueryTemplatesOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !paused && researchWorkspaceEnabled,
    staleTime: 60_000,
  })
  // The server's own list of places. One that predates it offers research with no Subject and across search locations.
  const researchScopeOptions = workspaceQuery.data?.scopeOptions ?? NO_SCOPE_OPTIONS
  const researchTemplates = useMemo<ResearchTemplateOption[]>(() => (researchTemplatesQuery.data?.templates ?? []).map(template => ({
    id: template.id,
    version: template.updatedAt,
    label: template.name,
    pattern: template.pattern,
    variables: template.variables,
  })), [researchTemplatesQuery.data])
  const researchProps = {
    projectName,
    scopeOptions: researchScopeOptions,
    planRevision: workspaceQuery.data?.active?.revision ?? null,
    selectedScope: (() => {
      const option = researchScopeOptions.find(item => item.kind === selection.measurementScope && item.id === selection.measurementScopeKey)
      const revision = workspaceQuery.data?.active?.revision
      return option && revision && (option.kind === 'market' || option.kind === 'property')
        ? { kind: option.kind, key: option.id, label: option.label, planRevision: revision, expectedPlanRevision: revision }
        : (selection.measurementScope === 'market' || selection.measurementScope === 'property') && selection.measurementScopeKey
          ? { kind: selection.measurementScope, key: selection.measurementScopeKey, label: selection.measurementScopeKey, planRevision: revision ?? 0, expectedPlanRevision: revision ?? 0 }
        : null
    })(),
    scopePending: workspaceQuery.isPending || workspaceQuery.isFetching,
    scopeError: workspaceQuery.isError,
    onRetryScope: () => { void workspaceQuery.refetch() },
    templates: researchTemplates,
  }
  return (
    <>
      {findShown && canWrite && <div ref={findPane} hidden={start !== 'find'}>
        <FindQueriesSection
          projectName={projectName}
          startControl={<ResearchStartControl value="find" onChange={changeStart} findIdeas />}
          paused={paused || start !== 'find'}
          onReviewDiscoveryProbe={advanced ? undefined : (discoveryProbeId) => onReviewSavedSource({ source: 'discovery', discoveryProbeId })}
          tracking={researchTracking?.selection ? { subjects, failed: researchTracking.failed, onRetry: researchTracking.onRetry, workspace, onResultsListed: onFindResultsListed, sweepActive, nextSweepDate } : undefined}
        />
      </div>}
      {form && <div ref={researchPane} hidden={start === 'find'}>
        <ResearchTrackingContext.Provider value={researchTracking}>
          <ResearchQueriesSection
            {...researchProps}
            start={form}
            onStartChange={changeStart}
            findIdeas={canWrite}
            paused={paused || start === 'find'}
            viewerResearchConfig={viewerResearchConfig}
            onReviewForTracking={canWrite && !advanced ? ({ researchRunQueryId, scope }) => onReviewSavedSource({ source: 'research', researchRunQueryId }, scope ?? null) : undefined}
            onConnectEngine={() => { void navigate({ to: '/settings' }) }}
          />
        </ResearchTrackingContext.Provider>
        {/* After the page it rides over, so it comes to rest under Past research. */}
        {!paused && start !== 'find' && workspace && researchTracking?.selection ? <TrackResearchBar id={barId} projectName={projectName} workspace={workspace} items={picks.items} sweepActive={sweepActive} nextSweepDate={nextSweepDate} onClear={picks.clear} onRemove={items => picks.pick(items, false)} returnFocus={focusResults} /> : null}
      </div>}
    </>
  )
}
