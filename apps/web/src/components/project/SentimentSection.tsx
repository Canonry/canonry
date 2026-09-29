import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { SentimentEvidenceItem, SentimentJobSummary, SentimentSettings, SentimentSummary, SentimentSelection, SentimentBackfillPreview, SentimentBackfillSelection, SentimentOverview, SentimentOverallHeadline, SentimentHeadline, SentimentAssessmentSummary, SentimentEvidenceSelection } from '@ainyc/canonry-contracts'
import { describeError, formatPercent, RatioUnits } from '@ainyc/canonry-contracts'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { WriteButton } from '../shared/AccessControls.js'
import { formatTimestamp } from '../../lib/format-helpers.js'
import { fetchSentimentEvidence, fetchSentimentJob, fetchSentimentSettings, isEmbed, previewSentimentBackfill, submitSentimentBackfill, updateSentimentSettings } from '../../api.js'
import { sentimentQueryKey, useSentiment } from '../../queries/sentiment.js'

type QueryClass = 'branded' | 'non-brand'
type QueryClassView = QueryClass | 'all' | 'unclassified' | 'unknown'
type RunOption = { id: string; label: string }
const CLASS_LABEL: Record<QueryClass, string> = { branded: 'Branded', 'non-brand': 'Non-brand' }
export const SENTIMENT_COPY = {
  states: { disabled: 'Sentiment is off.', 'not-measured': 'No ratings yet.', processing: 'Analyzing sentiment…', canceled: 'Analysis canceled.', partial: 'Partial results.', failed: 'Analysis failed.', complete: 'Analysis complete.', unsupported: 'Sentiment unavailable.' },
  noJudgments: 'No ratings available.',
  tooFew: 'too few',
  overall: 'Overall sentiment is the share of favorable judgments across branded and non-brand queries. Each saved answer-subject assessment counts once. Factual, unmentioned, unsupported, and unclassified answers are excluded.',
  favorable: 'The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.',
} as const
function outcomeLabel(value: string) { return value.replaceAll('-', ' ').replace(/^./, character => character.toUpperCase()) }

/**
 * Fewer rated answers than this and a class headline says "too few" instead of
 * a favorable share: one or two ratings swing it from 0% to 100%. The rated
 * counts stay in Details. Query rows keep their share beside its rating count.
 */
export const SENTIMENT_MIN_RATED = 10
export function showsFavorableShare(judged: number): boolean { return judged >= SENTIMENT_MIN_RATED }
const RATED_OUTCOMES = ['favorable', 'mixed', 'unfavorable'] as const

/** Branded is the headline sentiment figure; non-brand follows it as its own population. */
const CLASS_ORDER: readonly QueryClass[] = ['branded', 'non-brand']
/** The Wilson interval in the shared percent format, or null when nothing was judged. */
function sentimentIntervalText(score: Pick<SentimentHeadline['score'], 'interval'>): string | null {
  return score.interval ? `${formatPercent(score.interval.low, RatioUnits.fraction)} to ${formatPercent(score.interval.high, RatioUnits.fraction)}` : null
}
function FavorableValue({ value, label }: { value: Pick<SentimentHeadline, 'score' | 'coverage' | 'provisional' | 'state' | 'reason'>; label: string }) {
  const hasScore = value.score.favorableRate !== null && value.coverage.judged > 0
  return <div role="group" aria-label={`${label} favorable share`}>
    {hasScore ? <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {showsFavorableShare(value.coverage.judged)
        ? <span className="font-mono text-lg text-primary">{value.score.favorableDisplay}</span>
        : <span className="text-sm font-medium text-secondary">{SENTIMENT_COPY.tooFew}</span>}
      <span className="text-sm text-secondary">· {value.coverage.judged} {value.coverage.judged === 1 ? 'rating' : 'ratings'}</span>
      {value.provisional && <span className="text-sm text-caution">Partial results</span>}
    </div> : <p className="text-sm text-secondary">{value.state === 'complete' ? SENTIMENT_COPY.noJudgments : SENTIMENT_COPY.states[value.state]}</p>}
  </div>
}

function SentimentHeadlineDetails({ value }: { value: SentimentSummary }) {
  const { coverage, score } = value
  const interval = sentimentIntervalText(score)
  // With the share hidden, the rated outcomes are the only view of the ratings.
  const tooFew = coverage.judged > 0 && !showsFavorableShare(coverage.judged)
  if (!coverage.selected && !coverage.eligibleAssessments && !value.reason) return null
  return <details className="mt-3 max-w-sm text-sm text-secondary">
    <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Details</summary>
    <dl className="mt-2 space-y-1">
      {coverage.selected > 0 && <div className="flex flex-wrap justify-between gap-x-6"><dt>Rated assessments</dt><dd>{coverage.judged} of {coverage.selected}</dd></div>}
      {tooFew && RATED_OUTCOMES.filter(outcome => coverage.counts[outcome] > 0).map(outcome => <div key={outcome} className="flex flex-wrap justify-between gap-x-6"><dt>{outcomeLabel(outcome)}</dt><dd>{coverage.counts[outcome]}</dd></div>)}
      {tooFew && <div className="flex flex-wrap justify-between gap-x-6"><dt>Favorable share</dt><dd>Shown from {SENTIMENT_MIN_RATED} ratings</dd></div>}
      {coverage.distinctSourceAnswers > 0 && <div className="flex flex-wrap justify-between gap-x-6"><dt>Source answers</dt><dd>{coverage.distinctSourceAnswers}</dd></div>}
      {coverage.unadmittedAssessments > 0 && <div className="flex flex-wrap justify-between gap-x-6"><dt>Not yet analyzed</dt><dd>{coverage.unadmittedAssessments}</dd></div>}
      {Object.entries(coverage.counts).filter(([outcome, count]) => count > 0 && !['favorable', 'mixed', 'unfavorable'].includes(outcome)).map(([outcome, count]) => <div key={outcome} className="flex flex-wrap justify-between gap-x-6"><dt>{outcomeLabel(outcome)}</dt><dd>{count}</dd></div>)}
      {interval && <div className="flex flex-wrap justify-between gap-x-6"><dt className="flex items-center gap-1">95% confidence range <InfoTooltip text={score.limitation} placement="bottom" /></dt><dd>{interval}</dd></div>}
    </dl>
    {value.reason && <p className="mt-2 max-w-prose break-words">{value.reason}</p>}
  </details>
}

/** An overview shows one measured overall score, or no sentiment metric. */
export function showsSentimentOverview(value?: SentimentOverview): value is SentimentOverview & { overall: SentimentOverallHeadline } {
  return Boolean(value?.configured && value.overall && value.overall.coverage.judged > 0 && value.overall.score.favorableRate !== null) && !isEmbed()
}

/** Portfolio values come from the existing overview response, never separate per-card requests. */
export function SentimentOverviewMetric({ value }: { value?: SentimentOverview }) {
  if (!showsSentimentOverview(value)) return null
  const headline = value.overall
  const interval = sentimentIntervalText(headline.score)
  const detail = `${SENTIMENT_COPY.overall} ${headline.coverage.judged} of ${headline.coverage.selected} judged${interval ? `, 95% interval ${interval}` : ''}. ${headline.provisional ? 'Provisional. ' : ''}${SENTIMENT_COPY.states[headline.state]}${headline.reason ? ` ${headline.reason}` : ''}`
  return <div className="project-row-stat" data-sentiment-score>
    <div className="metric-inline-block">
      <div className="flex items-center gap-1"><p className="metric-inline-label">Sentiment</p><span className="relative z-10"><InfoTooltip text={detail} placement="bottom" /></span></div>
      <p className="metric-inline-value">{headline.score.favorableDisplay}<span className="sr-only"> favorable judgments, all query classes</span></p>
      <p className="metric-inline-caption" aria-hidden="true"></p>
    </div>
  </div>
}

interface ScopeValue {
  projectName: string
  selection: SentimentSelection
  settings: ReturnType<typeof useSentiment>['settings']
  summaries: Record<QueryClass, UseQueryResult<SentimentSummary>>
  configured: boolean
  hasSourceEvidence: boolean
  resolveSource: (source: { runId: string; revision?: number } | null) => void
  openManage: (opener: HTMLButtonElement) => void
  openEvidence: (selection: SentimentEvidenceSelection, label: string, opener: HTMLButtonElement) => void
}
const SentimentContext = createContext<ScopeValue | null>(null)
export function useSentimentConfigured() { return useContext(SentimentContext)?.configured ?? false }

export function SentimentScopeProvider({ projectName, selection, runOptions = [], waitForResolvedRun = false, evidenceReady = true, hasSourceEvidence = true, children }: {
  projectName: string; selection: SentimentSelection; runOptions?: RunOption[]; waitForResolvedRun?: boolean; evidenceReady?: boolean; hasSourceEvidence?: boolean; children: ReactNode
}) {
  return <SentimentScope projectName={projectName} selection={selection} runOptions={runOptions} waitForResolvedRun={waitForResolvedRun} evidenceReady={evidenceReady} hasSourceEvidence={hasSourceEvidence}>{children}</SentimentScope>
}
function SentimentScope({ projectName, selection, runOptions, waitForResolvedRun, evidenceReady, hasSourceEvidence, children }: {
  projectName: string; selection: SentimentSelection; runOptions: RunOption[]; waitForResolvedRun: boolean; evidenceReady: boolean; hasSourceEvidence: boolean; children: ReactNode
}) {
  const selectionKey = JSON.stringify([projectName, selection])
  const [resolvedSource, setResolvedSource] = useState<{ key: string; runId: string; revision?: number } | null>(null)
  const resolveSource = useCallback((value: { runId: string; revision?: number } | null) => setResolvedSource(previous => previous?.key === selectionKey && previous?.runId === value?.runId && previous?.revision === value?.revision ? previous : value ? { ...value, key: selectionKey } : null), [selectionKey])
  const sourceReady = evidenceReady && (!waitForResolvedRun || resolvedSource?.key === selectionKey)
  const activeSelection = waitForResolvedRun && sourceReady && resolvedSource ? { ...selection, runId: resolvedSource.runId, revision: resolvedSource.revision } : selection
  const activeSelectionKey = JSON.stringify([projectName, activeSelection])
  const { settings, branded, nonBrand, jobs } = useSentiment(projectName, activeSelection, sourceReady && hasSourceEvidence)
  const [manageOpen, setManageOpen] = useState(false)
  const [evidence, setEvidence] = useState<{ selection: SentimentEvidenceSelection; label: string } | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { setManageOpen(false); setEvidence(null) }, [activeSelectionKey])
  const configured = sourceReady && Boolean(settings.data?.enabled && settings.data.installEnabled)
  const selected = selection.queryClass === 'non-brand' ? nonBrand.data : branded.data
  const effective = selected?.selection
  const resolved: SentimentSelection = { ...activeSelection, ...(effective ? { ...effective, runId: effective.runId ?? undefined, runIds: effective.runId ? undefined : effective.runIds, revision: effective.revision ?? undefined, evaluationDefinitionId: effective.evaluationDefinitionId ?? undefined } : {}) }
  const options = resolved.runId && !runOptions.some(run => run.id === resolved.runId) ? [{ id: resolved.runId, label: 'Displayed sweep' }, ...runOptions] : runOptions
  const restoreFocus = (event: Event) => { event.preventDefault(); opener.current?.focus() }
  return <SentimentContext.Provider value={{ projectName, selection: activeSelection, resolveSource, settings, summaries: { branded, 'non-brand': nonBrand }, configured, hasSourceEvidence,
    openManage: element => { opener.current = element; setManageOpen(true) },
    openEvidence: (value, label, element) => { opener.current = element; setEvidence({ selection: value, label }) },
  }}>
    {children}
    <Sheet open={manageOpen && Boolean(settings.data?.actions.configure)} onOpenChange={setManageOpen}>
      <SheetContent onCloseAutoFocus={restoreFocus} className="overflow-y-auto"><SheetHeader><SheetTitle>Manage sentiment</SheetTitle><SheetDescription>Classify saved answers and review the cost before submitting a backfill.</SheetDescription></SheetHeader>
        {settings.data?.actions.configure && <SentimentSettingsEditor key={JSON.stringify([settings.data.evaluationDefinitionId, settings.data.enabled, settings.data.enablementEpoch])} projectName={projectName} settings={settings.data} selection={resolved} runOptions={options} />}
        {jobs.data && <SentimentJobs projectName={projectName} jobs={jobs.data.jobs} />}
      </SheetContent>
    </Sheet>
    <Sheet open={evidence !== null} onOpenChange={open => { if (!open) setEvidence(null) }}>
      <SheetContent onCloseAutoFocus={restoreFocus} className="overflow-y-auto"><SheetHeader><SheetTitle>Sentiment evidence{evidence ? `: ${evidence.label}` : ''}</SheetTitle><SheetDescription>Stored judgments and exact quotations for the selected query and scope.</SheetDescription></SheetHeader>
        {evidence && <SentimentQueryEvidence key={JSON.stringify(evidence.selection)} projectName={projectName} selection={evidence.selection} />}
      </SheetContent>
    </Sheet>
  </SentimentContext.Provider>
}

/** Advanced date/run filters must resolve before the two stored class summaries are read. */
export function useSentimentResolvedSource(runId: string | null | undefined, revision: number | null | undefined) {
  const resolveSource = useContext(SentimentContext)?.resolveSource
  useEffect(() => { resolveSource?.(runId ? { runId, revision: revision ?? undefined } : null) }, [resolveSource, runId, revision])
}

/** Controls remain reachable while classification is off; API action permissions govern them. */
export function SentimentControls() {
  const scope = useContext(SentimentContext)
  if (!scope?.settings.data?.actions.configure) return null
  return <WriteButton type="button" variant="outline" size="sm" onClick={event => scope.openManage(event.currentTarget)}>{scope.settings.data.enabled ? 'Manage sentiment' : 'Enable sentiment'}</WriteButton>
}

export function SentimentHeadlines({ queryClass = 'all' }: { queryClass?: QueryClassView }) {
  const scope = useContext(SentimentContext)
  if (!scope?.configured || queryClass === 'unknown' || queryClass === 'unclassified') return null
  const classes: readonly QueryClass[] = queryClass === 'all' ? CLASS_ORDER : [queryClass]
  return <div className="sentiment-headlines mb-4 flex flex-wrap items-start gap-x-8 gap-y-3" aria-label="Favorable answer scores">
    {classes.map(value => {
      const query = scope.summaries[value]
      return <div key={value} className="min-w-0 max-w-full">
        <div className="mb-2 flex items-center gap-2"><span className="text-sm text-secondary">Favorable · {CLASS_LABEL[value]}</span><InfoTooltip text={SENTIMENT_COPY.favorable} /></div>
        {!scope.hasSourceEvidence ? <p className="text-sm text-secondary">No saved answers.</p> : query.data ? <>
          <FavorableValue value={query.data} label={CLASS_LABEL[value]} />
          <SentimentHeadlineDetails value={query.data} />
        </> : query.isError ? <p role="alert" className="text-sm text-secondary">Couldn’t load sentiment. <Button variant="ghost" onClick={() => { void query.refetch() }}>Retry</Button></p> : <p role="status" className="text-sm text-secondary">Loading sentiment…</p>}
      </div>
    })}
  </div>
}

export function SentimentQueryScore({ queryId, sourceSnapshotIds = [], queryClass, location, showLabel = false }: { queryId?: string | null; sourceSnapshotIds?: string[]; queryClass?: QueryClass | null; location?: string | null; showLabel?: boolean }) {
  const scope = useContext(SentimentContext)
  if (!scope?.configured) return null
  const parent = queryClass ? scope.summaries[queryClass] : undefined
  const summary = scope.hasSourceEvidence ? parent?.data : undefined
  // Deleted queries retain exact source membership. Never join different saved queries by text.
  const matches = summary?.queries.filter(item => item.queryClass === queryClass && (queryId ? item.queryId === queryId : sourceSnapshotIds.length > 0) && sourceSnapshotIds.every(id => item.sourceSnapshotIds.includes(id))) ?? []
  const row = matches.length === 1 ? matches[0] : undefined
  const value = location === undefined ? row : row?.locations.find(item => item.location === location)
  // With no source evidence the class summaries are never requested, so a pending query here would never settle.
  if (!row || !value) return <span className="text-sm text-secondary">{scope.hasSourceEvidence && parent?.isPending && (queryId || sourceSnapshotIds.length) ? 'Loading…' : 'Unavailable'}</span>
  const selection: SentimentSelection = { ...scope.selection, ...summary!.selection, runId: summary!.selection.runId ?? undefined, runIds: summary!.selection.runId ? undefined : summary!.selection.runIds, revision: summary!.selection.revision ?? undefined, evaluationDefinitionId: summary!.selection.evaluationDefinitionId ?? undefined, queryClass: row.queryClass, queryId: row.queryId, executionNodeKey: row.executionNodeKey ?? undefined, ...(location === undefined ? {} : { location: location ?? 'none' }) }
  return <Button type="button" variant="ghost" className="h-auto min-h-11 flex-col items-start gap-0 px-1" aria-label={`View ${CLASS_LABEL[row.queryClass]} sentiment evidence for ${row.queryText}`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); scope.openEvidence(selection, row.queryText, event.currentTarget) }}>
    {showLabel && <span className="text-sm font-normal text-secondary">Favorable</span>}<span className="font-mono text-primary">{value.score.favorableDisplay}</span><span className="text-sm font-normal text-secondary">{value.coverage.judged} judged</span>{value.provisional && <span className="text-xs font-normal text-caution">Provisional</span>}
  </Button>
}

function assessmentLabel(item: SentimentAssessmentSummary): string {
  if (item.outcome === 'subject-not-mentioned') return 'Not mentioned'
  if (item.outcome === 'running') return 'Classifying'
  if (item.outcome === 'waiting-to-retry') return 'Retrying'
  if (item.outcome) return outcomeLabel(item.outcome)
  if (item.state === 'not-measured') return 'Not classified'
  if (item.state === 'processing') return 'Classifying'
  if (item.state === 'failed') return 'Failed'
  if (item.state === 'canceled') return 'Canceled'
  return 'Unavailable'
}

/** Read exact source/subject assessments from the two shared class summaries, never per row. */
export function SentimentAnswerOutcome({ queryId, sourceSnapshotIds, queryClass, provider, model, location, showSubjects = false, showLabel = false }: {
  queryId?: string | null; sourceSnapshotIds: string[]; queryClass?: QueryClass | null
  provider: string; model?: string | null; location: string | null; showSubjects?: boolean; showLabel?: boolean
}) {
  const scope = useContext(SentimentContext)
  if (!scope?.configured) return null
  const query = queryClass ? scope.summaries[queryClass] : undefined
  const summary = scope.hasSourceEvidence ? query?.data : undefined
  const rows = summary?.queries.filter(row => row.queryClass === queryClass && (!queryId || row.queryId === queryId)
    && sourceSnapshotIds.length > 0 && sourceSnapshotIds.every(id => row.sourceSnapshotIds.includes(id))) ?? []
  const row = rows.length === 1 ? rows[0] : undefined
  const assessments = row?.assessments?.filter(item => sourceSnapshotIds.includes(item.sourceSnapshotId)
    && item.provider === provider && item.location === location && (model === undefined || item.servedModel === model)) ?? []
  return <div role="group" className="text-sm text-secondary" aria-label={`${provider || 'Saved answer'} sentiment`}>
    {showLabel && <span className="block text-sm text-secondary">Sentiment</span>}
    {!assessments.length ? <span>{scope.hasSourceEvidence && query?.isPending && sourceSnapshotIds.length ? 'Loading…' : 'Unavailable'}</span> : assessments.map(item => {
      const label = assessmentLabel(item)
      const tone = item.outcome === 'favorable' ? 'positive' : item.outcome === 'unfavorable' ? 'negative' : item.outcome === 'mixed' ? 'caution' : 'neutral'
      const content = <>{showSubjects && <span>{item.subjectLabel} · </span>}<ToneBadge tone={tone} className="max-w-full shrink-0 rounded-none border-0 bg-transparent p-0 text-sm font-normal tracking-normal [overflow-wrap:normal]">{label}</ToneBadge></>
      const selection: SentimentEvidenceSelection = { ...scope.selection, ...summary!.selection, runId: summary!.selection.runId ?? undefined, runIds: summary!.selection.runId ? undefined : summary!.selection.runIds, revision: summary!.selection.revision ?? undefined, evaluationDefinitionId: summary!.selection.evaluationDefinitionId ?? undefined, queryClass: row!.queryClass, queryId: row!.queryId, executionNodeKey: row!.executionNodeKey ?? undefined, assessmentId: item.assessmentId ?? undefined }
      return <div key={JSON.stringify([item.sourceSnapshotId, item.subjectId, item.assessmentId])} className="flex items-center gap-1">
        {item.assessmentId ? <Button type="button" variant="ghost" className="h-auto min-h-11 flex-wrap justify-start whitespace-normal px-1 text-left text-sm" aria-label={`View ${item.provider} sentiment evidence for ${item.subjectLabel}: ${label}`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); scope.openEvidence(selection, `${row!.queryText} · ${item.provider} · ${item.subjectLabel}`, event.currentTarget) }}>{content}</Button> : <span>{content}</span>}
        {item.reason && <InfoTooltip text={item.reason} />}
      </div>
    })}
  </div>
}

function SentimentEvidenceContent({ item }: { item: SentimentEvidenceItem }) {
  return <article className="space-y-4 border-b border-default py-5 text-sm text-secondary">
    <div className="flex flex-wrap items-center gap-2"><strong className="text-primary">{item.subject.displayName}</strong><ToneBadge tone="neutral">{outcomeLabel(item.outcome)}</ToneBadge><span>{CLASS_LABEL[item.context.queryClass]}</span><span>{item.context.provider}</span><span>{item.context.servedModel ?? 'Source model unavailable'}</span><span>{item.context.location ?? 'No location'}</span></div>
    {item.reason && <p>{item.reason}</p>}
    <section><h3 className="mb-2 text-heading">Conclusion evidence</h3>{item.conclusion.length ? item.conclusion.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No valid conclusion evidence is available.</p>}</section>
    <section><h3 className="mb-2 text-heading">Complaint evidence</h3>{item.complaint?.length ? item.complaint.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No complaint was identified.</p>}</section>
    <details><summary className="cursor-pointer">Original source answer</summary><p className="mt-2 whitespace-pre-wrap break-words text-primary">{item.sourceText}</p></details>
    <details><summary className="cursor-pointer">Assessment provenance</summary><dl className="mt-3 space-y-2 break-all"><dt>Query</dt><dd>{item.context.queryText}</dd><dt>Subject</dt><dd>{item.subject.displayName} ({item.subject.id})</dd><dt>Run</dt><dd>{item.runId}</dd><dt>Revision</dt><dd>{item.context.revision ?? 'Unavailable'}</dd><dt>Evaluator</dt><dd>{item.returnedModel ?? 'Unavailable'}</dd><dt>Evaluation definition</dt><dd>{item.evaluationDefinitionId}</dd><dt>Source snapshot</dt><dd>{item.sourceSnapshotId}</dd><dt>Source hash</dt><dd>{item.sourceTextHash}</dd>{item.context.usageEdges.map((edge, index) => <div key={index}><dt>Assignment</dt><dd>Target {edge.targetId}; Property {edge.propertyId ?? 'None'}; market {edge.marketId ?? 'None'}; {edge.queryClass}</dd></div>)}</dl></details>
  </article>
}
export function SentimentEvidenceDrawer({ item, onClose, onRestoreFocus }: { item: SentimentEvidenceItem | null; onClose: () => void; onRestoreFocus?: () => void }) {
  return <Sheet open={item !== null} onOpenChange={open => { if (!open) onClose() }}><SheetContent className="overflow-y-auto" onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus() } }}><SheetHeader><SheetTitle>Sentiment evidence: {item?.subject.displayName}</SheetTitle><SheetDescription>Stored answer and verbatim quotations for this assessment.</SheetDescription></SheetHeader>{item && <SentimentEvidenceContent item={item} />}</SheetContent></Sheet>
}
function SentimentQueryEvidence({ projectName, selection }: { projectName: string; selection: SentimentEvidenceSelection }) {
  const [cursor, setCursor] = useState<string | undefined>()
  const query = useQuery({ queryKey: sentimentQueryKey(projectName, 'evidence', selection, cursor), queryFn: () => fetchSentimentEvidence(projectName, selection, cursor), retry: false })
  if (query.isPending) return <p role="status" className="mt-4 text-sm text-secondary">Loading sentiment evidence…</p>
  if (query.isError) return <p role="alert" className="mt-4 text-sm text-secondary">Could not load sentiment evidence. <Button variant="outline" onClick={() => { void query.refetch() }}>Retry evidence</Button></p>
  return <>{query.data.items.length ? query.data.items.map(item => <SentimentEvidenceContent key={item.assessmentId} item={item} />) : <p className="mt-4 text-sm text-secondary">No stored sentiment evidence for this query and scope.</p>}
    <div className="mt-3 flex gap-2">{cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>First evidence page</Button>}{query.data.nextCursor && <Button variant="outline" onClick={() => setCursor(query.data.nextCursor ?? undefined)}>Next evidence page</Button>}</div>
  </>
}
/** Attempt receipts load only when a job's details are opened, one page at a time, newest first. */
function SentimentJobAttempts({ projectName, jobId }: { projectName: string; jobId: string }) {
  const [cursor, setCursor] = useState<string | undefined>()
  const query = useQuery({ queryKey: sentimentQueryKey(projectName, `job:${jobId}`, undefined, cursor), queryFn: () => fetchSentimentJob(projectName, jobId, cursor), retry: false })
  if (query.isPending) return <p role="status">Loading attempts…</p>
  if (query.isError) return <p role="alert">Could not load attempts. <Button variant="outline" onClick={() => { void query.refetch() }}>Retry attempts</Button></p>
  return <>{query.data.attempts.map(attempt => <p key={attempt.id}>{attempt.errorCode ?? 'Request complete'}; {attempt.usage.kind === 'unknown' ? 'Usage unknown' : `${attempt.usage.inputTokens ?? 'Unknown'} input tokens (${attempt.usage.kind})`}</p>)}
    <div className="mt-2 flex gap-2">{cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>Newest attempts</Button>}{query.data.nextAttemptCursor && <Button variant="outline" onClick={() => setCursor(query.data.nextAttemptCursor ?? undefined)}>Older attempts</Button>}</div>
  </>
}
function SentimentJobDetails({ projectName, job }: { projectName: string; job: SentimentJobSummary }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Job details</summary>{job.cancellationReason && <p>{job.cancellationReason}</p>}{Object.entries(job.counts).filter(([, count]) => count > 0).map(([state, count]) => <p key={state}>{outcomeLabel(state)}: {count}</p>)}<p>Attempts: {job.attemptCount}</p>{open && job.attemptCount > 0 && <SentimentJobAttempts projectName={projectName} jobId={job.id} />}</details>
}
export function SentimentJobs({ projectName, jobs }: { projectName: string; jobs: SentimentJobSummary[] }) {
  return <details className="mt-6 text-sm text-secondary"><summary className="cursor-pointer">Recent sentiment jobs</summary>{jobs.length === 0 ? <p className="mt-2">No sentiment jobs have been submitted.</p> : <div className="data-table-wrapper mt-3"><table className="data-table" aria-label="Sentiment jobs"><thead><tr><th>Submitted</th><th>State</th><th>Selected</th><th>Details</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td>{formatTimestamp(job.createdAt)}</td><td>{outcomeLabel(job.state)}</td><td>{job.selected}</td><td><SentimentJobDetails projectName={projectName} job={job} /></td></tr>)}</tbody></table></div>}</details>
}
/** Plain labels for the server's backfill skip reasons; a reason this build does not know still reads through. */
const SENTIMENT_SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  probe: 'Probe sweeps',
  'unsupported-run-kind': 'Not an answer sweep',
  'failed-run': 'Failed sweep',
  'incomplete-run': 'Incomplete sweep',
  'legacy-missing-provenance': 'Saved without its frozen query and subject record',
  'legacy-missing-language': 'Saved before the answer language was recorded',
  'excluded-branded': 'Branded answers (backfill that class separately)',
  'excluded-non-brand': 'Non-brand answers (backfill that class separately)',
}
function skipReasonLabel(reason: string): string { return SENTIMENT_SKIP_REASON_LABELS[reason] ?? outcomeLabel(reason) }
/** The view filters that would narrow a backfill: engine, model, location, query, revision and a Property, group or market. */
function viewBackfillFilters(selection: SentimentBackfillSelection): string[] {
  return [
    selection.provider && `engine ${selection.provider}`,
    selection.model && `model ${selection.model}`,
    selection.location && (selection.location === 'none' ? 'no location' : `location ${selection.location}`),
    selection.scope !== 'project' && selection.scopeKey && `${selection.scope} ${selection.scopeKey}`,
    selection.marketKey && `market ${selection.marketKey}`,
    selection.queryId && `query ${selection.queryId}`,
    selection.revision !== undefined && `revision ${selection.revision}`,
  ].filter((part): part is string => Boolean(part))
}
/** The selection a preview actually covered, as the server echoed it. */
function describeSentimentBackfillSelection(selection: SentimentBackfillSelection): string {
  const filters = viewBackfillFilters(selection)
  return [`${CLASS_LABEL[selection.queryClass]} queries`, ...(filters.length ? filters : ['whole sweep'])].join(' · ')
}
/**
 * A dashboard backfill covers the whole chosen sweep for one query class: every
 * engine, model, location, query and Property. Narrowing it to the filters on
 * screen is an explicit choice, never inherited silently from the view.
 */
function sentimentBackfillSelection(view: SentimentSelection, runId: string, queryClass: QueryClass, limitToView: boolean): SentimentBackfillSelection {
  if (limitToView) return { ...view, queryClass, queryId: undefined, runIds: undefined, runId }
  return { mode: 'auto', scope: 'project', queryClass, runId }
}
function SentimentSettingsEditor({ projectName, settings, selection, runOptions }: { projectName: string; settings: SentimentSettings; selection: SentimentSelection; runOptions: RunOption[] }) {
  const client = useQueryClient()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [runId, setRunId] = useState(selection.runId ?? '')
  const [queryClass, setQueryClass] = useState<QueryClass>(selection.queryClass)
  const [limitToView, setLimitToView] = useState(false)
  const [preview, setPreview] = useState<SentimentBackfillPreview | null>(null)
  const key = useRef<string | null>(null)
  const viewFilters = viewBackfillFilters({ ...selection, queryId: undefined })
  const refresh = () => client.invalidateQueries({ queryKey: ['sentiment', projectName] })
  const reset = () => { setPreview(null); key.current = null }
  const save = useMutation({ mutationFn: async () => {
    if (!(await fetchSentimentSettings(projectName)).actions.configure) throw new Error('Administrator permission is required to configure sentiment.')
    return updateSentimentSettings(projectName, { enabled })
  }, onSuccess: async () => { reset(); await refresh(); await client.invalidateQueries({ queryKey: ['project-overview-slim'] }) }, onError: refresh })
  const inspect = useMutation({ mutationFn: async () => {
    if (!(await fetchSentimentSettings(projectName)).actions.backfill) throw new Error('Administrator permission is required to backfill sentiment.')
    return previewSentimentBackfill(projectName, sentimentBackfillSelection(selection, runId, queryClass, limitToView && viewFilters.length > 0))
  }, onSuccess: value => { setPreview(value); key.current = crypto.randomUUID() }, onError: refresh })
  const submit = useMutation({ mutationFn: async () => {
    if (!preview?.previewToken || !key.current) throw new Error('Create and review a backfill preview first.')
    if (!(await fetchSentimentSettings(projectName)).actions.backfill) throw new Error('Administrator permission is required to backfill sentiment.')
    return submitSentimentBackfill(projectName, preview.previewToken, key.current)
  }, onSuccess: async () => { reset(); await refresh() }, onError: refresh })
  const pending = save.isPending || inspect.isPending || submit.isPending
  return <div className="mt-5 space-y-5 text-sm text-secondary">
    <p>{settings.disclosure}</p>{!settings.ready && <p>{settings.readinessReasons.join('; ') || 'An operator must configure sentiment on this installation.'}</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); save.mutate() }}><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={pending} onChange={event => { setEnabled(event.target.checked); reset() }} />Enable project sentiment</label><p>Enabling applies to future completed sweeps. Past sweeps require an explicit backfill.</p><WriteButton type="submit" disabled={pending}>{save.isPending ? 'Saving…' : 'Save sentiment settings'}</WriteButton>{save.isError && <p role="alert">{describeError(save.error)}</p>}{save.isSuccess && <p role="status">Sentiment settings saved.</p>}</form>
    {settings.actions.backfill && <section className="space-y-3"><h3>Backfill a saved sweep</h3><label className="block">Saved sweep<select className="mt-1 block w-full rounded-md border border-default bg-bg p-2 text-primary" value={runId} disabled={pending} onChange={event => { setRunId(event.target.value); reset() }}><option value="">Select a saved sweep</option>{runOptions.map(run => <option key={run.id} value={run.id}>{run.label}</option>)}</select></label><label className="block">Query class<select className="mt-1 block w-full rounded-md border border-default bg-bg p-2 text-primary" value={queryClass} disabled={pending} onChange={event => { setQueryClass(event.target.value as QueryClass); reset() }}><option value="non-brand">Non-brand</option><option value="branded">Branded</option></select></label>
      <p>The backfill covers every engine, location and query of the chosen sweep for this query class.</p>
      {viewFilters.length > 0 && <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={limitToView} disabled={pending} onChange={event => { setLimitToView(event.target.checked); reset() }} /><span>Limit to the current view<span className="block">{viewFilters.join(' · ')}</span></span></label>}
      <Button variant="outline" disabled={pending || !runId || !settings.enabled || !settings.ready} onClick={() => { reset(); inspect.mutate() }}>{inspect.isPending ? 'Preparing preview…' : 'Preview sentiment backfill'}</Button>{inspect.isError && <p role="alert">{describeError(inspect.error)}</p>}
      {preview && <div className="space-y-3"><dl className="grid grid-cols-[1fr_auto] gap-2"><dt>Selection</dt><dd className="text-right">{describeSentimentBackfillSelection(preview.selection)}</dd><dt>Eligible assessments</dt><dd>{preview.eligibleAssessments}</dd><dt>Already classified</dt><dd>{preview.alreadyClassified}</dd><dt>Estimated input tokens</dt><dd>{preview.estimatedInputTokens}</dd><dt>Estimated cost (USD)</dt><dd>{preview.estimatedCostUsd ?? 'Unavailable'}</dd></dl><InfoTooltip text={preview.estimateMethod} />
        {preview.eligibleAssessments === 0 && <p>No saved answers in this selection can be classified.</p>}
        {preview.skipped.length > 0 && <div><p>Not included:</p><ul aria-label="Skipped assessments" className="list-disc pl-5">{preview.skipped.map(item => <li key={`${item.runId}:${item.reason}`}>{skipReasonLabel(item.reason)}: {item.count}</li>)}</ul></div>}
        <WriteButton disabled={pending || !preview.previewToken || preview.eligibleAssessments === 0} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Confirm sentiment backfill'}</WriteButton></div>}
      {submit.isError && <p role="alert">{describeError(submit.error)} Retry uses the same request key.</p>}{submit.isSuccess && <p role="status">Backfill submitted. Progress is available in Recent jobs.</p>}
    </section>}
  </div>
}
