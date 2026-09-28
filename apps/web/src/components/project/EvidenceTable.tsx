import { Fragment, useId, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CitationStates, brandLabelFromDomain, type QueryClass } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import {
  DataTablePagination,
  DataTableSearch,
  useClientTable,
} from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import { highlightTermsInText, type HighlightTermGroup } from '../../lib/highlight.js'
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

export function EvidenceTable({
  evidence,
  compareLocations = false,
  defaultDensity = 'detailed',
}: {
  evidence: CitationInsightVm[]
  compareLocations?: boolean
  defaultDensity?: Density
}) {
  const { openEvidence } = useDrawer()
  const panelId = useId()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<CoverageMode>('mentions')
  const [density, setDensity] = useState<Density>(defaultDensity)
  const [queryClassSelection, setQueryClassSelection] = useState<QueryClassSelection>('all')
  const [providerSelection, setProviderSelection] = useState('')
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
    return [...map.values()]
  }, [evidence, mode, compareLocations, providerSelection])
  const classGroups = useMemo(() => groups.filter(group =>
    queryClassSelection === 'all'
    || (queryClassSelection === 'unclassified' ? group.queryClass === null : group.queryClass === queryClassSelection),
  ), [groups, queryClassSelection])
  const groupsTable = useClientTable({
    rows: classGroups,
    getSearchText: evidenceGroupSearchText,
  })
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
              {providers.map(provider => <option key={provider} value={provider}>{provider}</option>)}
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
                <th scope="col">{historyHeader}</th>
                <th scope="col">Latest run</th>
                <th><span className="sr-only">Answer</span></th>
              </tr>
            </thead>
            <tbody>
              {groupsTable.rows.map(({ key: groupKey, phrase, queryClass, location, items, rawItems }, groupIndex) => {
                const isExpanded = expandedRows.has(groupKey)
                const metadataId = `${panelId}-query-${groupIndex}`
                const states = items.map(i => i.citationState)
                const aggState: CitationState =
                  states.includes('cited') ? 'cited' :
                  states.includes('emerging') ? 'emerging' :
                  states.includes('lost') ? 'lost' :
                  states.every(s => s === 'pending') ? 'pending' : 'not-cited'

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
                              {items.filter(item => item.provider).map(item => <span key={item.id}>{item.provider}</span>)}
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
                      <td>
                        <CitationTimeline history={mergedHistory} signal={mode} />
                      </td>
                      <td className="evidence-change-cell">
                        <SignalStrip items={rawItems} />
                      </td>
                      <td />
                    </tr>
                    {isExpanded && items.map((item, index) => (
                      <Fragment key={item.id}>
                        <tr className="query-evidence-engine-row">
                          <td className="evidence-query-cell">
                            <span className="text-sm text-secondary">{item.provider || 'Awaiting engine'}</span>
                          </td>
                          <td>
                            <CitationBadge
                              state={item.citationState}
                              className="rounded-none border-0 bg-transparent p-0 text-sm tracking-normal"
                              label={statusLabelForMode(item.citationState, mode)}
                            />
                          </td>
                          <td>
                            <CitationTimeline history={item.runHistory} signal={mode} />
                          </td>
                          <td className="evidence-change-cell">
                            <SignalStrip items={[rawItems[index] ?? item]} />
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              className="min-h-11"
                              type="button"
                              title={`View ${item.provider || 'saved'} answer for ${item.query}`}
                              onClick={(e) => { e.stopPropagation(); void openEvidence(item.id) }}
                            >
                              View
                            </Button>
                          </td>
                        </tr>
                        {density === 'detailed' && (
                          <tr className="query-evidence-preview-row">
                            <td colSpan={5}>
                              <AnswerInlinePanel
                                item={item}
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

export function buildHighlightGroups(item: CitationInsightVm): HighlightTermGroup[] {
  const brandTerms = (item.matchedTerms ?? []).filter(t => t.trim().length > 2)
  const competitorTerms = [
    ...(item.mentionedCompetitorDomains ?? []).flatMap(d => {
      const brand = brandLabelFromDomain(d)
      return brand.length >= 4 ? [brand] : []
    }),
    ...(item.recommendedCompetitors ?? []),
  ].filter(t => t.trim().length > 2)
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

function truncate(text: string, max: number): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false }
  const cut = text.lastIndexOf(' ', max)
  const body = text.slice(0, cut > max - 40 ? cut : max).trimEnd()
  return { body: `${body}…`, truncated: true }
}

function AnswerInlinePanel({
  item,
  onViewFull,
}: {
  item: CitationInsightVm
  onViewFull: () => void
}) {
  const hasAnswer = item.answerSnippet.trim().length > 0
  if (!hasAnswer) {
    return (
      <p className="text-sm text-secondary">
        No answer text captured for this run.
      </p>
    )
  }

  const { body, truncated } = truncate(item.answerSnippet, ANSWER_PREVIEW_MAX)
  const groups = buildHighlightGroups(item)

  return (
    <div className="max-w-prose space-y-3">
      <p className="text-[13px] font-medium text-secondary">Answer text</p>
      <p className="text-sm leading-relaxed text-neutral">
        {highlightTermsInText(body, groups)}
      </p>
      {(item.citedDomains.length > 0 || (item.mentionedCompetitorDomains?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-secondary">
          {item.citedDomains.length > 0 && (
            <>
              <span className="font-medium">Cited:</span>
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
            </>
          )}
          {(item.mentionedCompetitorDomains?.length ?? 0) > 0 && (
            <>
              <span className="font-medium">Competitors in answer:</span>
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
            </>
          )}
        </div>
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
