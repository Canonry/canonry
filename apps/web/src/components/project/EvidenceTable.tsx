import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { CitationStates, hostOf, normalizeQueryText, type QueryClass } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import {
  DataTablePagination,
  DataTableSearch,
  useClientTable,
} from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SourceLink } from '../shared/SourceLink.js'
import { AnswerMarkdown } from '../shared/AnswerMarkdown.js'
import { SentimentControls, SentimentHeadlines, SentimentQueryScore, SentimentAnswerOutcome, useSentimentConfigured } from './SentimentSection.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { competitorHighlightTerms, type HighlightTermGroup } from '../../lib/highlight.js'
import type { CitationInsightVm, CitationState, RunHistoryPoint } from '../../view-models.js'

export type CoverageMode = 'citations' | 'mentions'
type Density = 'compact' | 'detailed'
type QueryClassSelection = 'all' | QueryClass | 'unclassified'
type SignalTone = 'positive' | 'negative' | 'neutral' | 'pending'

export interface EvidenceSignalSummary {
  key: CoverageMode
  label: string
  tone: SignalTone
}

interface EvidenceGroup {
  key: string
  phrase: string
  queryClass: QueryClass | null
  location: string | null
  items: CitationInsightVm[]
  rawItems: CitationInsightVm[]
}

const ANSWER_PREVIEW_MAX = 320

function queryClassLabel(queryClass: QueryClass | null): string {
  return queryClass === 'branded' ? 'Branded' : queryClass === 'non-brand' ? 'Non-brand' : 'Unclassified'
}

/** Rows read Non-brand first, then Branded, then anything the project could not classify. */
function queryClassRank(queryClass: QueryClass | null): number {
  return queryClass === 'non-brand' ? 0 : queryClass === 'branded' ? 1 : 2
}

/** Consecutive rows of one class, so each class gets its own labelled row group. */
function classRuns<T extends { queryClass: QueryClass | null }>(rows: readonly T[]): Array<{ queryClass: QueryClass | null; rows: T[] }> {
  const runs: Array<{ queryClass: QueryClass | null; rows: T[] }> = []
  for (const row of rows) {
    const last = runs.at(-1)
    if (last && last.queryClass === row.queryClass) last.rows.push(row)
    else runs.push({ queryClass: row.queryClass, rows: [row] })
  }
  return runs
}

function evidenceGroupSearchText(group: EvidenceGroup): string {
  return group.phrase
}

/** Map a snapshot to the state value driving the column for the active mode.
 *  In citations mode we read `citationState` directly. In mentions mode we
 *  collapse to `cited`/`not-cited`/`pending` based on `answerMentioned` (with
 *  `visibilityState` as a fallback) so the visualization can reuse the same
 *  dot palette and badge component. */
function deriveStateForMode(
  input: { citationState: string; answerMentioned?: boolean; visibilityState?: string },
  mode: CoverageMode,
): CitationState {
  if (mode === 'citations') return input.citationState as CitationState
  if (input.visibilityState === 'pending') return 'pending'
  if (input.answerMentioned == null && input.visibilityState == null) return 'pending'
  const mentioned = input.visibilityState === 'visible' || input.answerMentioned === true
  return mentioned ? 'cited' : 'not-cited'
}

function statusLabelForMode(state: CitationState, mode: CoverageMode): string {
  if (mode === 'mentions') {
    switch (state) {
      case 'cited': return 'Mentioned'
      case 'not-cited': return 'Not Mentioned'
      case 'pending': return 'Pending'
      // 'emerging' / 'lost' are collapsed by deriveStateForMode in mentions mode,
      // but fall through here defensively if a caller passes them anyway.
      case 'emerging': return 'Newly Mentioned'
      case 'lost': return 'No Longer Mentioned'
    }
  }
  switch (state) {
    case 'cited': return 'Cited'
    case 'not-cited': return 'Not Cited'
    case 'lost': return 'Lost'
    case 'emerging': return 'Emerging'
    case 'pending': return 'Pending'
  }
}

function projectItemsForMode(items: CitationInsightVm[], mode: CoverageMode): CitationInsightVm[] {
  return items.map(item => projectItemForMode(item, mode))
}

function projectItemForMode(item: CitationInsightVm, mode: CoverageMode): CitationInsightVm {
  if (mode === 'citations') return item
  return {
    ...item,
    citationState: deriveStateForMode(item, mode),
    runHistory: item.runHistory.map(h => ({ ...h, citationState: deriveStateForMode(h, mode) })),
  }
}

function historyForMode(history: RunHistoryPoint[], mode: CoverageMode): RunHistoryPoint[] {
  if (mode === 'citations') return history
  return history.map(point => ({
    ...point,
    citationState: deriveStateForMode(point, mode),
  }))
}

function summarizeProjectedSignalHistory(projected: RunHistoryPoint[], mode: CoverageMode): EvidenceSignalSummary {
  const subject = mode === 'mentions' ? 'mention' : 'citation'
  const subjectCap = mode === 'mentions' ? 'Mention' : 'Citation'
  if (projected.length === 0) {
    return { key: mode, label: `${subjectCap} pending`, tone: 'pending' }
  }

  const latest = projected[projected.length - 1]!.citationState
  const previous = projected.length >= 2 ? projected[projected.length - 2]!.citationState : null
  const isPresent = latest === 'cited' || latest === 'emerging'
  const wasPresent = previous === 'cited' || previous === 'emerging'

  if (latest === 'lost' || (previous !== null && wasPresent && !isPresent)) {
    return { key: mode, label: `Lost ${subject}`, tone: 'negative' }
  }
  if (latest === 'emerging' || (previous !== null && !wasPresent && isPresent)) {
    return { key: mode, label: `New ${subject}`, tone: 'positive' }
  }
  if (previous === null && isPresent) {
    return { key: mode, label: `First ${subject}`, tone: 'positive' }
  }
  if (isPresent) {
    return { key: mode, label: mode === 'mentions' ? 'Still mentioned' : 'Still cited', tone: 'neutral' }
  }
  return { key: mode, label: `No ${subject}`, tone: 'neutral' }
}

export function summarizeSignalHistory(history: RunHistoryPoint[], mode: CoverageMode): EvidenceSignalSummary {
  return summarizeProjectedSignalHistory(historyForMode(history, mode), mode)
}

export function summarizeSignalsForItems(items: CitationInsightVm[]): EvidenceSignalSummary[] {
  const mentionHistory = mergeProviderHistories(projectItemsForMode(items, 'mentions'))
  const citationHistory = mergeProviderHistories(items)
  return [
    summarizeProjectedSignalHistory(mentionHistory, 'mentions'),
    summarizeProjectedSignalHistory(citationHistory, 'citations'),
  ]
}

function SignalLabel({ signal }: { signal: EvidenceSignalSummary }) {
  const toneClass = signal.tone === 'positive'
    ? 'text-positive'
    : signal.tone === 'negative'
      ? 'text-negative'
      : signal.tone === 'pending'
        ? 'text-caution'
        : 'text-secondary'
  return (
    <span className={toneClass}>
      {signal.label}
    </span>
  )
}

function SignalStrip({ items }: { items: CitationInsightVm[] }) {
  return (
    <div className="query-evidence-signals" aria-label="Latest run mention and citation signals">
      {summarizeSignalsForItems(items).map(signal => (
        <SignalLabel key={signal.key} signal={signal} />
      ))}
    </div>
  )
}

/**
 * The top of Query evidence: the section's actions on the right, then the
 * Sentiment block at the section's full width, its legend under its title and
 * Manage sentiment in its title row when the section has actions. An embed has
 * no actions row. Without a query class it is the actions alone, for while the
 * evidence loads or after it fails.
 */
export function QueryEvidenceSummary({ queryClass, actions }: { queryClass?: QueryClassSelection; actions?: ReactNode }) {
  return (
    <>
      {/* Without a query class (evidence loading or failed) there is no Sentiment block, so Manage sentiment joins the actions. */}
      {actions ? <div className="query-evidence-toolbar"><div className="query-evidence-actions">{!queryClass && <SentimentControls />}{actions}</div></div> : null}
      {queryClass ? <SentimentHeadlines queryClass={queryClass} manage={Boolean(actions)} /> : null}
    </>
  )
}

export function EvidenceTable({
  evidence,
  compareLocations = false,
  defaultDensity = 'detailed',
  providerSelection: controlledProvider,
  onProviderSelectionChange,
  addedQueries = [],
  actions,
  actionPanel,
}: {
  evidence: CitationInsightVm[]
  compareLocations?: boolean
  defaultDensity?: Density
  providerSelection?: string
  onProviderSelectionChange?: (provider: string) => void
  /**
   * Queries first tracked in the latest sweep (`movementComparison.addedQueries`).
   * Only these read "new query": a query whose history is merely short (an
   * engine new to an old query, a first sweep) keeps its signal labels.
   */
  addedQueries?: readonly string[]
  /** The section's actions, at the right of the row above the sentiment bars. */
  actions?: ReactNode
  /** What an action opens (the query editor), directly under the bars. */
  actionPanel?: ReactNode
}) {
  const { openEvidence } = useDrawer()
  const panelId = useId()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const sentimentConfigured = useSentimentConfigured()
  const [mode, setMode] = useState<CoverageMode>('mentions')
  const [density, setDensity] = useState<Density>(defaultDensity)
  const [queryClassSelection, setQueryClassSelection] = useState<QueryClassSelection>('all')
  const [localProvider, setLocalProvider] = useState('')
  const providerSelection = controlledProvider ?? localProvider
  const setProviderSelection = (provider: string) => { setLocalProvider(provider); onProviderSelectionChange?.(provider) }
  const providers = useMemo(() => [...new Set([
    ...evidence.map(item => item.provider).filter(Boolean),
    ...(providerSelection ? [providerSelection] : []),
  ])].sort(), [evidence, providerSelection])

  const groups = useMemo(() => {
    const map = new Map<string, EvidenceGroup>()
    for (const rawItem of evidence) {
      if (providerSelection && rawItem.provider !== providerSelection) continue
      const phrase = rawItem.query
      const queryClass = rawItem.queryClass ?? null
      const location = compareLocations ? (rawItem.location ?? null) : null
      const key = JSON.stringify([phrase, queryClass, location])
      const existing = map.get(key) ?? { key, phrase, queryClass, location, items: [], rawItems: [] }
      existing.items.push(projectItemForMode(rawItem, mode))
      existing.rawItems.push(rawItem)
      map.set(key, existing)
    }
    // A stable sort, so rows keep their order within a class.
    return [...map.values()].sort((a, b) => queryClassRank(a.queryClass) - queryClassRank(b.queryClass))
  }, [evidence, mode, compareLocations, providerSelection])
  const classGroups = useMemo(() => groups.filter(group =>
    queryClassSelection === 'all'
    || (queryClassSelection === 'unclassified' ? group.queryClass === null : group.queryClass === queryClassSelection),
  ), [groups, queryClassSelection])
  const groupsTable = useClientTable({
    rows: classGroups,
    getSearchText: evidenceGroupSearchText,
  })
  // Each class heading counts that class's queries across every page, after the
  // filters; a compared location adds rows, never queries.
  const classQueryCounts = useMemo(() => {
    const phrases = new Map<QueryClass | null, Set<string>>()
    for (const group of groupsTable.filteredRows) {
      const set = phrases.get(group.queryClass) ?? new Set<string>()
      set.add(group.phrase)
      phrases.set(group.queryClass, set)
    }
    return phrases
  }, [groupsTable.filteredRows])
  const added = useMemo(() => new Set(addedQueries.map(normalizeQueryText)), [addedQueries])
  const columnCount = sentimentConfigured ? 6 : 5
  const visibleGroupKeys = groupsTable.rows.map((group) => group.key)
  const visibleGroupsExpanded = visibleGroupKeys.length > 0
    && visibleGroupKeys.every((key) => expandedRows.has(key))

  const toggleRow = (key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const presenceVerb = mode === 'mentions' ? 'mentioned' : 'cited'
  const historyHeader = mode === 'mentions' ? 'Mention History' : 'Citation History'
  const countNoun = mode === 'mentions' ? 'mentioned' : 'cited'

  return (
    <div className="query-evidence">
      <QueryEvidenceSummary queryClass={queryClassSelection} actions={actions} />
      {actionPanel}
      <div className="query-evidence-view-row">
        <div className="flex items-center gap-3">
          <div className="query-evidence-tabs" role="tablist" aria-label="Citation tracking view">
            {(['mentions', 'citations'] as const).map(value => (
              <button
                key={value}
                id={`${panelId}-${value}`}
                type="button"
                role="tab"
                aria-controls={panelId}
                aria-selected={mode === value}
                tabIndex={mode === value ? 0 : -1}
                onClick={() => setMode(value)}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next = event.key === 'Home' ? 'mentions' : event.key === 'End' ? 'citations' : value === 'mentions' ? 'citations' : 'mentions'
                  setMode(next)
                  document.getElementById(`${panelId}-${next}`)?.focus()
                }}
              >
                {value === 'mentions' ? 'Mentions' : 'Citations'}
              </button>
            ))}
          </div>
          <InfoTooltip text="Mentions track your brand or domain in answer text. Citations track your domain in source links. Each signal is measured independently." />
        </div>
        <div className="query-evidence-display-controls">
          <label className="query-evidence-preview-toggle">
            <input type="checkbox" checked={density === 'detailed'} onChange={event => setDensity(event.target.checked ? 'detailed' : 'compact')} />
            Show answer previews
          </label>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={visibleGroupKeys.length === 0}
            onClick={() => {
              setExpandedRows(previous => {
                const next = new Set(previous)
                for (const key of visibleGroupKeys) {
                  if (visibleGroupsExpanded) next.delete(key)
                  else next.add(key)
                }
                return next
              })
            }}
          >
            {visibleGroupsExpanded ? 'Collapse page' : 'Expand page'}
          </Button>
        </div>
      </div>
      {evidence.length > 0 || providerSelection ? (
        <div className="query-evidence-filters">
          <DataTableSearch
            value={groupsTable.query}
            onChange={groupsTable.setQuery}
            label="Find a query"
            placeholder="Find a query"
            className="query-evidence-search"
          />
          <label className="query-evidence-filter">
            <span className="sr-only">Answer engine</span>
            <select value={providerSelection} onChange={event => { setProviderSelection(event.target.value); groupsTable.setPage(1) }}>
              <option value="">All engines</option>
              {providers.map(provider => <option key={provider} value={provider}>{providerDisplayName(provider)}</option>)}
            </select>
          </label>
          <label className="query-evidence-filter">
            <span className="sr-only">Query class</span>
            <select value={queryClassSelection} onChange={event => { setQueryClassSelection(event.target.value as QueryClassSelection); groupsTable.setPage(1) }}>
              <option value="all">All queries</option>
              <option value="branded">Branded</option>
              <option value="non-brand">Non-brand</option>
              <option value="unclassified">Unclassified</option>
            </select>
          </label>
        </div>
      ) : null}
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${mode}`}>
        <div className="query-evidence-table-wrap">
          <table className="evidence-table query-evidence-table">
            <thead>
              <tr>
                <th scope="col">Query</th>
                <th scope="col">Status</th>
                {sentimentConfigured && <th scope="col" aria-label="Sentiment"><span className="inline-flex items-center">Sentiment<InfoTooltip text="Branded query rows show the favorable share of judged answers. Non-brand rows show only their unfavorable and mixed answers. Expanded engine rows show each stored answer’s sentiment; factual and unmentioned answers are not judgments." /></span></th>}
                <th scope="col">{historyHeader}</th>
                <th scope="col">Latest run</th>
                <th><span className="sr-only">Answer</span></th>
              </tr>
            </thead>
            {classRuns(groupsTable.rows).map(run => (
              <tbody key={run.queryClass ?? 'unclassified'}>
                <tr className="query-evidence-group">
                  <th scope="rowgroup" colSpan={columnCount}>
                    {queryClassLabel(run.queryClass)} ({classQueryCounts.get(run.queryClass)?.size ?? 0})
                  </th>
                </tr>
                {run.rows.map(({ key: groupKey, phrase, queryClass, location, items, rawItems }) => {
                  const isExpanded = expandedRows.has(groupKey)
                  const groupIndex = visibleGroupKeys.indexOf(groupKey)
                  const metadataId = `${panelId}-query-${groupIndex}`
                  const isNewQuery = added.has(normalizeQueryText(phrase))
                  const states = items.map(i => i.citationState)
                  const aggState: CitationState =
                    states.includes('cited') ? 'cited' :
                    states.includes('emerging') ? 'emerging' :
                    states.includes('lost') ? 'lost' :
                    states.every(s => s === 'pending') ? 'pending' : 'not-cited'

                  const queryIds = [...new Set(rawItems.map(item => item.queryId).filter((id): id is string => Boolean(id)))]
                  const sourceSnapshotIds = rawItems.map(item => item.sourceSnapshotId).filter((id): id is string => Boolean(id))
                  const mergedHistory = mergeProviderHistories(items)
                  const presentCount = items.filter(i => i.citationState === CitationStates.cited || i.citationState === 'emerging').length

                  return (
                    <Fragment key={groupKey}>
                      <tr className="query-evidence-row" onClick={() => toggleRow(groupKey)}>
                        <td className="evidence-query-cell">
                          <button
                            type="button"
                            className="query-evidence-query"
                            aria-label={phrase}
                            aria-describedby={metadataId}
                            aria-expanded={isExpanded}
                            onClick={event => { event.stopPropagation(); toggleRow(groupKey) }}
                          >
                            <ChevronRight size={16} aria-hidden="true" className={isExpanded ? 'rotate-90' : ''} />
                            <span className="min-w-0">
                              <span>{phrase}</span>
                              <span id={metadataId} className="query-evidence-meta">
                                <span>{queryClassLabel(queryClass)}</span>
                                {compareLocations && <span>{location ?? 'No location'}</span>}
                                {items.filter(item => item.provider).map(item => <span key={item.id}>{providerDisplayName(item.provider)}</span>)}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <CitationBadge state={aggState} label={statusLabelForMode(aggState, mode)} className="rounded-none border-0 bg-transparent p-0 text-sm tracking-normal" />
                            <span
                              className="text-sm text-secondary tabular-nums"
                              aria-label={`${presentCount} of ${items.length} engines ${countNoun}`}
                              title={`${presentCount} of ${items.length} engines ${countNoun}`}
                            >
                              {presentCount}/{items.length}
                            </span>
                          </div>
                        </td>
                        {sentimentConfigured && <td><SentimentQueryScore queryId={queryIds.length === 1 ? queryIds[0] : null} sourceSnapshotIds={queryIds.length > 1 ? [] : sourceSnapshotIds} queryClass={queryClass} location={compareLocations ? location : undefined} /></td>}
                        <td>
                          <CitationTimeline history={mergedHistory} signal={mode} />
                        </td>
                        <td className="evidence-change-cell">
                          {isNewQuery ? <span className="query-evidence-new">new query</span> : <SignalStrip items={rawItems} />}
                        </td>
                        <td />
                      </tr>
                      {isExpanded && items.map((item, index) => (
                        <Fragment key={item.id}>
                          <tr className="query-evidence-engine-row">
                            <td className="evidence-query-cell">
                              <span className="text-sm text-secondary">{item.provider ? providerDisplayName(item.provider) : 'Awaiting engine'}</span>
                            </td>
                            <td>
                              <CitationBadge
                                state={item.citationState}
                                className="rounded-none border-0 bg-transparent p-0 text-sm tracking-normal"
                                label={statusLabelForMode(item.citationState, mode)}
                              />
                            </td>
                            {sentimentConfigured && <td><SentimentAnswerOutcome queryId={item.queryId} sourceSnapshotIds={item.sourceSnapshotId ? [item.sourceSnapshotId] : []} queryClass={item.queryClass} provider={item.provider} location={item.location ?? null} /></td>}
                            <td>
                              <CitationTimeline history={item.runHistory} signal={mode} />
                            </td>
                            <td className="evidence-change-cell">
                              {/* The query row already says "new query"; every engine is new with it. */}
                              {isNewQuery ? null : <SignalStrip items={[rawItems[index] ?? item]} />}
                            </td>
                            <td>
                              <Button
                                variant="ghost"
                                className="min-h-11"
                                type="button"
                                title={`View ${item.provider ? providerDisplayName(item.provider) : 'saved'} answer for ${item.query}`}
                                onClick={(e) => { e.stopPropagation(); void openEvidence(item.id) }}
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                          {density === 'detailed' && (
                            <tr className="query-evidence-preview-row">
                              <td colSpan={columnCount}>
                                <EvidenceInlinePanel
                                  key={mode}
                                  item={item}
                                  mode={mode}
                                  onViewFull={() => openEvidence(item.id)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </Fragment>
                  )
                })}
              </tbody>
            ))}
          </table>
        </div>
        {groupsTable.totalRows === 0 && (groupsTable.hasQuery || queryClassSelection !== 'all' || providerSelection) ? (
          <p className="supporting-copy mt-3">No tracked queries match this filter.</p>
        ) : null}
        <DataTablePagination
          page={groupsTable.page}
          pageSize={groupsTable.pageSize}
          visibleRows={groupsTable.rows.length}
          totalRows={groupsTable.totalRows}
          onPageChange={groupsTable.setPage}
          itemLabel={groupsTable.hasQuery || queryClassSelection !== 'all' || providerSelection ? 'matches' : 'queries'}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        Showing {presenceVerb === 'cited' ? 'citations (sources)' : 'mentions (answer text)'}.
      </p>
    </div>
  )
}

export function buildHighlightGroups(item: Pick<CitationInsightVm, 'matchedTerms' | 'mentionedCompetitorDomains' | 'mentionedCompetitorTerms' | 'recommendedCompetitors'>): HighlightTermGroup[] {
  const brandTerms = (item.matchedTerms ?? []).filter(t => t.trim().length > 2)
  const competitorTerms = competitorHighlightTerms(item)
  const groups: HighlightTermGroup[] = []
  if (brandTerms.length > 0) groups.push({ terms: brandTerms, className: 'answer-highlight-brand' })
  if (competitorTerms.length > 0) groups.push({ terms: competitorTerms, className: 'answer-highlight-competitor' })
  return groups
}

export function isCitedCompetitorDomain(item: CitationInsightVm, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '')
  return (item.citedCompetitorDomains ?? []).some(
    candidate => candidate.toLowerCase().replace(/^www\./, '') === normalized,
  )
}

function EvidenceInlinePanel({ item, mode, onViewFull }: {
  item: CitationInsightVm
  mode: CoverageMode
  onViewFull: () => void
}) {
  const [answerExpanded, setAnswerExpanded] = useState(false)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  if (mode === 'mentions') return <AnswerInlinePanel item={item} onViewFull={onViewFull} />

  const sources = item.evidenceUrls.length > 0
    ? item.evidenceUrls.map(url => ({ uri: url, title: item.groundingSources.find(source => source.uri === url)?.title }))
    : item.groundingSources
  return (
    <div className="query-evidence-preview space-y-3">
      <p className="text-[13px] font-medium text-secondary">
        {item.evidenceUrls.length > 0 ? 'Cited sources' : sources.length > 0 ? 'Grounding sources' : 'Cited domains'}
      </p>
      {sources.length > 0 ? (
        <ul className="space-y-4">
          {sources.slice(0, sourcesExpanded ? undefined : 6).map((source, index) => (
            <li key={`${index}-${source.uri}`} className="min-w-0">
              <SourceLink url={source.uri} title={source.title} />
              {isCitedCompetitorDomain(item, hostOf(source.uri) ?? '') && <p className="mt-1 text-[13px] text-secondary">Competitor source</p>}
            </li>
          ))}
        </ul>
      ) : item.citedDomains.length > 0 ? (
        <ul className="space-y-1 text-sm text-secondary">
          {item.citedDomains.slice(0, sourcesExpanded ? undefined : 6).map(domain => (
            <li key={domain} className="[overflow-wrap:anywhere]">
              {domain}{isCitedCompetitorDomain(item, domain) ? ' · competitor source' : ''}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-secondary">No cited sources captured for this run.</p>}
      {(sources.length > 6 || (sources.length === 0 && item.citedDomains.length > 6)) && (
        <Button type="button" variant="ghost" className="min-h-11" aria-expanded={sourcesExpanded} onClick={() => setSourcesExpanded(expanded => !expanded)}>
          {sourcesExpanded ? 'Show fewer sources' : 'View all sources'}
        </Button>
      )}
      {item.answerSnippet.trim() ? (
        <details open={answerExpanded} className="border-t border-subtle pt-1">
          <summary className="min-h-11 cursor-pointer py-3 text-sm text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={event => { event.preventDefault(); setAnswerExpanded(expanded => !expanded) }}>Answer text</summary>
          {answerExpanded && <AnswerInlinePanel item={item} onViewFull={onViewFull} contextOnly />}
        </details>
      ) : <p className="text-sm text-secondary">No answer text captured for this run.</p>}
    </div>
  )
}

function AnswerInlinePanel({
  item,
  onViewFull,
  contextOnly = false,
}: {
  item: CitationInsightVm
  onViewFull: () => void
  contextOnly?: boolean
}) {
  const { matchedTerms, mentionedCompetitorDomains, mentionedCompetitorTerms, recommendedCompetitors } = item
  const groups = useMemo(
    () => buildHighlightGroups({ matchedTerms, mentionedCompetitorDomains, mentionedCompetitorTerms, recommendedCompetitors }),
    [matchedTerms, mentionedCompetitorDomains, mentionedCompetitorTerms, recommendedCompetitors],
  )
  const hasAnswer = item.answerSnippet.trim().length > 0
  if (!hasAnswer) {
    return (
      <p className="text-sm text-secondary">
        No answer text captured for this run.
      </p>
    )
  }

  const truncated = item.answerSnippet.length > ANSWER_PREVIEW_MAX

  return (
    <div className="query-evidence-preview space-y-3">
      {!contextOnly && <p className="text-[13px] font-medium text-secondary">Answer text</p>}
      <AnswerMarkdown headingLevel={4} highlightGroups={groups} previewLength={ANSWER_PREVIEW_MAX}>
        {item.answerSnippet}
      </AnswerMarkdown>
      {((!contextOnly && item.citedDomains.length > 0) || (item.mentionedCompetitorDomains?.length ?? 0) > 0) && (
        <dl className="space-y-2 text-[13px] leading-6 text-secondary">
          {!contextOnly && item.citedDomains.length > 0 && (
            <div>
              <dt className="font-medium">Cited domains</dt>
              <dd className="flex flex-wrap gap-x-3 gap-y-1">
                {item.citedDomains.slice(0, 6).map(d => (
                  <span
                    key={`c-${d}`}
                    className="[overflow-wrap:anywhere]"
                  >
                    {d}{isCitedCompetitorDomain(item, d) ? ' · competitor source' : ''}
                  </span>
                ))}
                {item.citedDomains.length > 6 && (
                  <span>+{item.citedDomains.length - 6} more</span>
                )}
              </dd>
            </div>
          )}
          {(item.mentionedCompetitorDomains?.length ?? 0) > 0 && (
            <div>
              <dt className="font-medium">Competitors in answer</dt>
              <dd className="flex flex-wrap gap-x-3 gap-y-1">
                {item.mentionedCompetitorDomains!.slice(0, 4).map(d => (
                  <span
                    key={`co-${d}`}
                    className="[overflow-wrap:anywhere]"
                  >
                    {d}
                  </span>
                ))}
                {item.mentionedCompetitorDomains!.length > 4 && (
                  <span>+{item.mentionedCompetitorDomains!.length - 4} more</span>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {truncated && (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={(e) => { e.stopPropagation(); onViewFull() }}
        >
          View full answer
        </Button>
      )}
    </div>
  )
}
