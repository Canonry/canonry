import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { effectiveDomains, normalizeProjectDomain } from '@ainyc/canonry-contracts'

import { CitationBadge } from '../shared/CitationBadge.js'
import { highlightTermsInText } from '../../lib/highlight.js'
import { fetchRunDetail, type GroundingSource } from '../../api.js'
import type { CitationInsightVm, ProjectCommandCenterVm } from '../../view-models.js'

/** Shape of snapshot data used for display — works for both current evidence and fetched historical snapshots. */
export interface EvidenceDisplayData {
  citationState: string
  provider: string
  model: string | null
  answerSnippet: string
  citedDomains: string[]
  competitorDomains: string[]
  groundingSources: GroundingSource[]
  evidenceUrls: string[]
  changeLabel: string
  summary: string
}

export function EvidenceDetailModal({
  evidence,
  project,
  onClose,
}: {
  evidence: CitationInsightVm
  project: ProjectCommandCenterVm
  onClose: () => void
}) {
  const [showFullAnswer, setShowFullAnswer] = useState(false)
  const [selectedRunIdx, setSelectedRunIdx] = useState(-1) // -1 = latest (current)
  const [historicalSnapshot, setHistoricalSnapshot] = useState<EvidenceDisplayData | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  // Cache fetched run details so re-clicking a dot is instant
  const [runCache, setRunCache] = useState<Record<string, EvidenceDisplayData>>({})

  const projectDomains = effectiveDomains(project.project)
  const myDomains = new Set(projectDomains.map(normalizeProjectDomain))
  const history = evidence.runHistory
  const hasHistory = history.length > 1

  // Current display data — from historical snapshot when viewing past runs, otherwise from latest evidence
  const isViewingHistory = selectedRunIdx >= 0 && historicalSnapshot !== null
  const display: EvidenceDisplayData = isViewingHistory ? historicalSnapshot : {
    citationState: evidence.citationState,
    provider: evidence.provider,
    model: evidence.model,
    answerSnippet: evidence.answerSnippet,
    citedDomains: evidence.citedDomains,
    competitorDomains: evidence.competitorDomains,
    groundingSources: evidence.groundingSources,
    evidenceUrls: evidence.evidenceUrls,
    changeLabel: evidence.changeLabel,
    summary: evidence.summary,
  }

  const isCited = display.citationState === 'cited' || display.citationState === 'emerging'
  const positionIndex = display.citedDomains.findIndex(
    d => myDomains.has(d.toLowerCase().replace(/^www\./, '')),
  )
  const position = positionIndex + 1
  const totalCited = display.citedDomains.length

  // Terms to highlight in the AI answer
  const projectDisplayName = project.project.displayName || project.project.name
  const highlightTerms = [
    ...projectDomains.map(normalizeProjectDomain),
    projectDisplayName,
    projectDisplayName.split(' ').slice(0, 2).join(' '),
  ].filter(t => t.trim().length > 2)

  // State key for CSS variants
  const stateKey: 'cited' | 'not-cited' | 'lost' | 'pending' =
    isCited ? 'cited' :
    display.citationState === 'lost' ? 'lost' :
    display.citationState === 'pending' ? 'pending' : 'not-cited'

  // Guard against out-of-order async completions when clicking dots quickly
  const activeRequestRef = useRef(0)

  // Fetch historical run data when a dot is clicked
  const selectHistoricalRun = useCallback(async (idx: number) => {
    const requestId = ++activeRequestRef.current

    if (idx === -1 || idx === history.length - 1) {
      setSelectedRunIdx(-1)
      setHistoricalSnapshot(null)
      setShowFullAnswer(false)
      return
    }
    setSelectedRunIdx(idx)
    setShowFullAnswer(false)

    const run = history[idx]
    // Check cache first
    const cacheKey = `${run.runId}::${evidence.keyword}::${evidence.provider}`
    if (runCache[cacheKey]) {
      setHistoricalSnapshot(runCache[cacheKey])
      return
    }

    setLoadingHistory(true)
    try {
      const runDetail = await fetchRunDetail(run.runId)
      // Discard result if a newer request was fired while we were fetching
      if (requestId !== activeRequestRef.current) return

      // Find the snapshot matching this keyword + provider
      const snap = runDetail.snapshots.find(
        s => s.keyword === evidence.keyword && s.provider === evidence.provider,
      ) ?? runDetail.snapshots.find(
        s => s.keyword === evidence.keyword,
      )

      const data: EvidenceDisplayData = snap ? {
        citationState: snap.citationState,
        provider: snap.provider,
        model: snap.model ?? null,
        answerSnippet: snap.answerText ?? '',
        citedDomains: snap.citedDomains,
        competitorDomains: snap.competitorOverlap,
        groundingSources: snap.groundingSources,
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: '',
      } : {
        citationState: run.citationState,
        provider: evidence.provider,
        model: run.model ?? null,
        answerSnippet: '',
        citedDomains: [],
        competitorDomains: [],
        groundingSources: [],
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: 'Snapshot data not available for this run.',
      }

      setRunCache(prev => ({ ...prev, [cacheKey]: data }))
      setHistoricalSnapshot(data)
    } catch {
      if (requestId !== activeRequestRef.current) return
      setHistoricalSnapshot({
        citationState: run.citationState,
        provider: evidence.provider,
        model: run.model ?? null,
        answerSnippet: '',
        citedDomains: [],
        competitorDomains: [],
        groundingSources: [],
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: 'Failed to load historical run data.',
      })
    } finally {
      if (requestId === activeRequestRef.current) {
        setLoadingHistory(false)
      }
    }
  }, [history, evidence.keyword, evidence.provider, runCache])

  // Hero copy
  const showModelInHeadline = isViewingHistory || evidence.historyScope !== 'provider'
  const providerMeta = showModelInHeadline && display.model
    ? `${display.provider} (${display.model}) \u00b7 ${display.changeLabel.toLowerCase()}`
    : `${display.provider} \u00b7 ${display.changeLabel.toLowerCase()}`
  const providerMetaNote = !isViewingHistory && evidence.historyScope === 'provider'
    ? [
        evidence.model ? `Current model: ${evidence.model}` : null,
        evidence.modelsSeen && evidence.modelsSeen.length > 1 ? `History spans ${evidence.modelsSeen.length} models` : null,
      ].filter(Boolean).join(' \u00b7 ')
    : ''
  const heroCopy = (() => {
    if (isCited && position > 0) {
      return {
        label: 'Citation confirmed',
        title: `Cited #${position} of ${totalCited} domain${totalCited !== 1 ? 's' : ''}`,
        meta: providerMeta,
      }
    }
    if (isCited) {
      return {
        label: 'Citation confirmed',
        title: 'Cited in this answer',
        meta: providerMeta,
      }
    }
    if (display.citationState === 'lost') {
      return {
        label: 'Citation lost',
        title: totalCited > 0
          ? `${totalCited} domain${totalCited !== 1 ? 's' : ''} cited instead`
          : 'No longer appearing in this answer',
        meta: providerMeta,
      }
    }
    if (display.citationState === 'pending') {
      return {
        label: 'Pending',
        title: 'Awaiting first visibility run',
        meta: 'No provider data yet',
      }
    }
    return {
      label: 'Not in this answer',
      title: totalCited > 0
        ? `${totalCited} domain${totalCited !== 1 ? 's' : ''} cited instead`
        : 'No domains cited for this query',
      meta: providerMeta,
    }
  })()

  // Render markdown-aware AI answer
  const renderHighlightedAnswer = () => {
    if (!display.answerSnippet) return null
    const lines = display.answerSnippet.split('\n')
    const elements: ReactNode[] = []
    let paraLines: string[] = []
    let key = 0

    const flushPara = () => {
      if (paraLines.length === 0) return
      const text = paraLines.join(' ').trim()
      if (text) {
        elements.push(
          <p key={key++} className={elements.length > 0 ? 'mt-2.5' : ''}>
            {highlightTermsInText(text, highlightTerms)}
          </p>,
        )
      }
      paraLines = []
    }

    for (const raw of lines) {
      const line = raw.trim()
      if (/^[-\u2013\u2014]{3,}$/.test(line)) {
        flushPara()
        elements.push(<hr key={key++} className="border-zinc-800/60 my-3" />)
        continue
      }
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
      if (headingMatch) {
        flushPara()
        const level = headingMatch[1].length
        const text = headingMatch[2].replace(/^[\p{Emoji}\p{Emoji_Component}\s#]+/u, '').trim() || headingMatch[2]
        const cls = level === 1
          ? 'text-[13px] font-semibold text-zinc-100 mt-4 mb-1'
          : level === 2
            ? 'text-xs font-semibold text-zinc-200 mt-3 mb-0.5'
            : 'text-xs font-medium text-zinc-300 mt-2'
        elements.push(
          <p key={key++} className={cls}>
            {highlightTermsInText(text, highlightTerms)}
          </p>,
        )
        continue
      }
      if (line === '') {
        flushPara()
        continue
      }
      paraLines.push(line)
    }
    flushPara()
    return elements
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
        <Dialog.Content
          className="evidence-modal"
          aria-describedby={undefined}
        >
          {/* ── Header ── */}
          <div className="evidence-modal-header">
            <div className="min-w-0 flex-1">
              <p className="eyebrow eyebrow-soft">{project.project.name} \u00b7 {display.provider || 'All providers'}</p>
              <Dialog.Title className="text-lg font-semibold text-zinc-50 truncate">{evidence.keyword}</Dialog.Title>
            </div>
            <Dialog.Close className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 shrink-0">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>

          {/* ── Run history timeline ── */}
          {hasHistory && (
            <div className="evidence-modal-timeline">
              <p className="drawer-section-label mb-1.5">Run history</p>
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {history.map((run, i) => {
                  const isSelected = (selectedRunIdx === -1 && i === history.length - 1) || selectedRunIdx === i
                  const dotColor = run.citationState === 'cited'
                    ? 'bg-emerald-400' : run.citationState === 'emerging'
                      ? 'bg-amber-400' : run.citationState === 'lost'
                        ? 'bg-rose-400' : 'bg-zinc-600'
                  const date = new Date(run.createdAt)
                  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  const modelChanged = Boolean(run.model && i > 0 && history[i - 1]?.model && history[i - 1]!.model !== run.model)
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`evidence-run-dot ${isSelected ? 'evidence-run-dot--selected' : ''}`}
                      onClick={() => selectHistoricalRun(i === history.length - 1 ? -1 : i)}
                      aria-label={[
                        `Run ${label}: ${run.citationState}`,
                        run.model ? `model ${run.model}` : null,
                        modelChanged ? 'model changed' : null,
                      ].filter(Boolean).join(' \u2014 ')}
                      aria-pressed={isSelected}
                    >
                      <span
                        className={`size-2 rounded-full ${dotColor} ${modelChanged ? 'ring-1 ring-amber-300/80 ring-offset-2 ring-offset-zinc-950' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="text-[10px] text-zinc-500">{label}</span>
                    </button>
                  )
                })}
              </div>
              {selectedRunIdx >= 0 && selectedRunIdx < history.length && (
                <p className="text-[11px] text-zinc-500 mt-1">
                  Viewing run from {new Date(history[selectedRunIdx].createdAt).toLocaleString()} \u2014 <span className="capitalize">{history[selectedRunIdx].citationState}</span>
                  <button type="button" className="text-zinc-400 hover:text-zinc-200 ml-2" onClick={() => selectHistoricalRun(-1)}>\u2190 Back to latest</button>
                </p>
              )}
              {!isViewingHistory && (evidence.modelTransitions?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {evidence.modelTransitions!.map((transition) => (
                    <span
                      key={`${transition.runId}:${transition.toModel ?? 'unknown'}`}
                      className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-100"
                    >
                      {`${transition.fromModel ?? 'unknown'} -> ${transition.toModel ?? 'unknown'} on ${new Date(transition.createdAt).toLocaleDateString()}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Two-column body ── */}
          <div className="evidence-modal-body">
            {loadingHistory && (
              <div className="md:col-span-2 flex items-center justify-center py-12 text-zinc-500 text-sm">
                Loading historical run data\u2026
              </div>
            )}

            {!loadingHistory && (
              <>
                {/* Left: status + AI answer */}
                <div className="evidence-modal-main">
                  {/* Position hero */}
                  <div className={`evidence-position-hero evidence-position-hero--${stateKey}`}>
                    <p className={`evidence-position-label evidence-position-label--${stateKey}`}>
                      {heroCopy.label}
                    </p>
                    <p className={`evidence-position-title evidence-position-title--${stateKey}`}>
                      {heroCopy.title}
                    </p>
                    <p className="evidence-position-meta">{heroCopy.meta}</p>
                    {providerMetaNote && (
                      <p className="mt-1 text-[11px] text-zinc-500">{providerMetaNote}</p>
                    )}
                  </div>

                  {/* AI answer */}
                  {display.answerSnippet && (
                    <div>
                      <p className="drawer-section-label">What the AI said</p>
                      <div className={`answer-snippet-block ${showFullAnswer ? 'evidence-answer-expanded' : 'evidence-answer-collapsed'}`}>
                        {renderHighlightedAnswer()}
                      </div>
                      {display.answerSnippet.length > 280 && (
                        <button
                          type="button"
                          className="mt-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                          onClick={() => setShowFullAnswer(!showFullAnswer)}
                        >
                          {showFullAnswer ? '\u2191 Collapse' : '\u2193 Show full answer'}
                        </button>
                      )}
                    </div>
                  )}

                  {!display.answerSnippet && !loadingHistory && (
                    <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/20 px-4 py-8 text-center text-zinc-600 text-sm">
                      No answer text recorded for this run
                    </div>
                  )}

                  {/* Action items — only for latest run */}
                  {!isViewingHistory && evidence.relatedTechnicalSignals.length > 0 && (
                    <div>
                      <p className="drawer-section-label">
                        {isCited ? 'Why you\'re cited' : 'What to fix'}
                      </p>
                      <div className="action-items-list">
                        {evidence.relatedTechnicalSignals.map((signal, i) => (
                          <div key={i} className="action-item">
                            <svg
                              className={`action-item-icon ${isCited ? 'text-emerald-400' : 'text-amber-400'}`}
                              viewBox="0 0 16 16" fill="none" aria-hidden="true"
                            >
                              {isCited
                                ? <path d="M3 8l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                : (
                                  <>
                                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                                    <path d="M8 5v3.5M8 10.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                  </>
                                )
                              }
                            </svg>
                            <span className="action-item-text">{signal}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Summary */}
                  {display.summary && (
                    <p className="text-xs text-zinc-600 border-t border-zinc-800/40 pt-3 mt-1">{display.summary}</p>
                  )}
                </div>

                {/* Right: leaderboard + sources */}
                <div className="evidence-modal-sidebar">
                  {/* Citation leaderboard */}
                  {display.citedDomains.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Who was cited \u2014 in order</p>
                      <div className="citation-leaderboard">
                        {display.citedDomains.map((domain, i) => {
                          const norm = domain.toLowerCase().replace(/^www\./, '')
                          const isYou = myDomains.has(norm)
                          const isCompetitor = !isYou && display.competitorDomains.some(
                            c => c.toLowerCase().replace(/^www\./, '') === norm,
                          )
                          const variant = isYou ? 'you' : isCompetitor ? 'competitor' : 'other'
                          return (
                            <div key={domain} className={`citation-leaderboard-item citation-leaderboard-item--${variant}`}>
                              <span className="citation-leaderboard-rank">#{i + 1}</span>
                              <span className="citation-leaderboard-domain">{domain}</span>
                              {isYou && <span className="citation-leaderboard-tag">You</span>}
                              {isCompetitor && <span className="citation-leaderboard-tag">Competitor</span>}
                            </div>
                          )
                        })}
                        {!isCited && (
                          <div className="citation-leaderboard-item citation-leaderboard-item--not-cited border-dashed">
                            <span className="citation-leaderboard-rank text-zinc-600">\u2014</span>
                            <span className="citation-leaderboard-domain text-zinc-600">{project.project.canonicalDomain}</span>
                            <span className="citation-leaderboard-tag text-zinc-600">Not cited</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Grounding sources */}
                  {display.groundingSources.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Grounding sources ({display.groundingSources.length})</p>
                      <ul className="grid gap-0.5">
                        {display.groundingSources.map((src, i) => (
                          <li key={i} className="truncate text-sm">
                            <a href={src.uri} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-200 transition-colors">
                              {src.title || src.uri}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Evidence URLs */}
                  {display.evidenceUrls.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Evidence URLs</p>
                      <ul className="grid gap-1">
                        {display.evidenceUrls.map((url) => (
                          <li key={url} className="truncate text-sm">
                            <a href={url} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-200 transition-colors">
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* No data state */}
                  {display.citedDomains.length === 0 && display.groundingSources.length === 0 && display.evidenceUrls.length === 0 && (
                    <div className="flex items-center justify-center h-24 text-zinc-600 text-sm">
                      No citation data {isViewingHistory ? 'for this run' : 'yet'}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
