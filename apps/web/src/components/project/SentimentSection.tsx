import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import type { SentimentEvidenceItem, SentimentJobSummary, SentimentOutcome, SentimentSettings, SentimentSummary, SentimentSelection, SentimentBackfillPreview, SentimentBackfillSelection, SentimentOverview, SentimentHeadline, SentimentAssessmentSummary, SentimentEvidenceSelection } from '@ainyc/canonry-contracts'
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
/**
 * Fewer ratings than this and a class line's Favorable column shows the empty
 * value instead of a favorable share, and the portfolio figure reads "too few":
 * one or two ratings swing the share from 0% to 100%. The Rated column still
 * shows its share of answers rated, and the rated outcome counts stay in
 * Details. Query rows keep their share beside its rating count.
 */
export const SENTIMENT_MIN_RATED = 10
export function showsFavorableShare(judged: number): boolean { return judged >= SENTIMENT_MIN_RATED }
export const SENTIMENT_COPY = {
  states: { disabled: 'Sentiment is off.', 'not-measured': 'No ratings yet.', processing: 'Analyzing sentiment…', canceled: 'Analysis canceled.', partial: 'Partial results.', failed: 'Analysis failed.', complete: 'Analysis complete.', unsupported: 'Sentiment unavailable.' },
  noJudgments: 'No ratings available.',
  tooFew: 'too few',
  /** Why a Favorable column is empty: its tooltip, its screen-reader text and the Details row. */
  minRated: `Shown from ${SENTIMENT_MIN_RATED} ratings`,
  partial: 'Partial results',
  columns: { favorable: 'Favorable', rated: 'With opinion' },
  /** The section's visible title and the line under it. */
  title: 'Sentiment',
  subtitle: 'How AI answers describe you in queries that name you',
  /** The Rated column header's tooltip. */
  rated: 'Share of answers that give an opinion (favorable, mixed or unfavorable) about who they name',
  /** Why a Rated column is empty: no eligible answers. Its tooltip and its screen-reader text. */
  noAnswers: 'No answers yet',
  /** Why a Rated column is empty when the server sends no answer counts (one older than the Rated fields): no claim about answers. */
  ratedUnavailable: 'Unavailable',
  /** Details row labels: Rated counts answers; the unadmitted count is of assessments (one per answer and subject). */
  details: {
    ratedAnswers: 'Answers with an opinion',
    unadmitted: 'Checks not yet analyzed',
    checksCaption: 'Not counted in the favorable share:',
    interval: 'Likely range (95%)',
  },
  nonBrand: {
    label: 'Non-brand queries',
    none: 'No unfavorable or mixed answers in non-brand queries.',
    noneSoFar: 'No unfavorable or mixed answers in non-brand queries so far.',
    notRated: 'Non-brand answers are not rated yet.',
    view: 'View answers',
    evidence: 'Non-brand queries, unfavorable and mixed',
    rowNone: 'No unfavorable or mixed answers',
    rowLabel: 'Unfavorable or mixed',
    help: 'A non-brand answer almost always names you to recommend you, so its favorable share is near 100% and says little. Sentiment is measured on branded queries; unfavorable or mixed answers to non-brand queries are listed here when they happen.',
  },
  /** Branded Details: the server's most criticized Properties in this view. */
  properties: { title: 'Most criticized properties', evidence: 'unfavorable and mixed', viewAll: 'View all unfavorable and mixed answers', allEvidence: 'Branded queries, unfavorable and mixed' },
  overall: 'Favorable share of ratings in answers to branded queries. Each saved answer-subject assessment counts once. Answers with no opinion, or where it is unclear who they name, are left out.',
  favorable: 'The favorable share of favorable, mixed and unfavorable ratings in answers to branded queries. Each rating covers one subject named in an answer; answers with no opinion are left out.',
} as const
/** The app's empty value for a metric with no figure, as the Property and query-group tables write it. */
const EM_DASH = '\u2014'
/** Plain names for the outcomes a reader meets in Details and evidence; anything else falls back to its code. */
const OUTCOME_LABEL: Record<string, string> = {
  factual: 'Named, no opinion',
  'subject-not-mentioned': 'Not named in the answer',
  'wrong-subject': 'Named someone else',
  'ambiguous-subject': 'Unclear which one was meant',
  'ambiguous-judgment': 'Opinion unclear',
  'subject-not-applicable': 'Not applicable',
  'unsupported-language': 'Not in English',
  'missing-source-text': 'No answer text',
  'input-too-large': 'Answer too long to rate',
  'invalid-conclusion-evidence': 'Rating set aside',
  pending: 'Waiting to be rated',
  running: 'Being rated',
  'waiting-to-retry': 'Retrying',
}
function outcomeLabel(value: string) { return OUTCOME_LABEL[value] ?? value.replaceAll('-', ' ').replace(/^./, character => character.toUpperCase()) }
const RATED_OUTCOMES = ['favorable', 'mixed', 'unfavorable'] as const
/** An outcome's badge tone: favorable positive, mixed caution, unfavorable negative, anything else neutral. */
function outcomeTone(outcome: string | null | undefined) { return outcome === 'favorable' ? 'positive' : outcome === 'unfavorable' ? 'negative' : outcome === 'mixed' ? 'caution' : 'neutral' }

/** Branded is the only sentiment figure; non-brand shows only its unfavorable and mixed answers. */
const CRITICISM_OUTCOMES: SentimentOutcome[] = ['mixed', 'unfavorable']
/** The Wilson interval in the shared percent format, or null when nothing was judged. */
function sentimentIntervalText(score: Pick<SentimentHeadline['score'], 'interval'>): string | null {
  return score.interval ? `${formatPercent(score.interval.low, RatioUnits.fraction)} to ${formatPercent(score.interval.high, RatioUnits.fraction)}` : null
}
/** The fill each rated outcome draws with: blue favorable, amber mixed, red unfavorable (blue and red stay apart for red-green color blindness). */
const OUTCOME_FILL: Record<typeof RATED_OUTCOMES[number], string> = { favorable: 'progress-fill-info', mixed: 'progress-fill-caution', unfavorable: 'progress-fill-negative' }
function ratingCount(judged: number) { return `${judged} ${judged === 1 ? 'rating' : 'ratings'}` }
function hasRatings(value: Pick<SentimentHeadline, 'score' | 'coverage'>) { return value.score.favorableRate !== null && value.coverage.judged > 0 }
/**
 * Whether a read is final: complete, not provisional, nothing left unadmitted. Only a final
 * read with no unfavorable or mixed answers establishes that there were none; an unrated,
 * pending, failed, canceled or partial read says its own state instead.
 */
function isFinal(value: Pick<SentimentHeadline, 'state' | 'provisional' | 'coverage'>) { return value.state === 'complete' && !value.provisional && value.coverage.unadmittedAssessments === 0 }
/** A read's state in words; a non-final complete read (which the server does not send) reads as partial. */
function stateText(value: Pick<SentimentHeadline, 'state'>) { return value.state === 'complete' ? SENTIMENT_COPY.partial : SENTIMENT_COPY.states[value.state] }
/** A bar splits into outcome segments only where the favorable share shows too. */
function drawsSegments(value: Pick<SentimentHeadline, 'score' | 'coverage'> | undefined) { return value ? hasRatings(value) && showsFavorableShare(value.coverage.judged) : false }

/**
 * A class's rated outcomes as one stacked bar. Each segment grows by its own
 * count from the API, so the bar is the counts and computes nothing. Below
 * {@link SENTIMENT_MIN_RATED} ratings it is a plain track beside an empty
 * Favorable column: segments would draw the share that column hides (one
 * favorable rating fills the bar). Its counts stay in its label and in
 * Details. With no ratings it is an empty track and the note under it says why.
 */
function SentimentBar({ value, label }: { value: Pick<SentimentHeadline, 'score' | 'coverage'>; label: string }) {
  const { counts, judged } = value.coverage
  if (!hasRatings(value)) return <div className="sentiment-bar sentiment-bar-track" data-sentiment-bar="empty" aria-hidden="true" />
  const outcomes = RATED_OUTCOMES.map(outcome => `${counts[outcome]} ${outcome}`).join(', ')
  if (!drawsSegments(value)) return <div role="img" aria-label={`${label}: ${outcomes}, ${ratingCount(judged)}, favorable share ${SENTIMENT_COPY.minRated.toLowerCase()}`} className="sentiment-bar sentiment-bar-track" data-sentiment-bar="too-few" />
  return <div role="img" aria-label={`${label}: ${outcomes}, ${value.score.favorableDisplay} favorable of ${ratingCount(judged)}`} className="sentiment-bar" data-sentiment-bar="rated">
    {RATED_OUTCOMES.filter(outcome => counts[outcome] > 0).map(outcome => <span key={outcome} data-outcome={outcome} className={`sentiment-bar-segment ${OUTCOME_FILL[outcome]}`} style={{ flexGrow: counts[outcome] }} title={`${outcomeLabel(outcome)}: ${counts[outcome]} of ${ratingCount(judged)}`} />)}
  </div>
}

/** A Property's rated outcomes as a thin stacked bar, its counts in its label; drawn at any count, since it shows counts, not a share. */
function PropertyOutcomeBar({ value, label }: { value: Pick<SentimentHeadline, 'coverage'>; label: string }) {
  const { counts, judged } = value.coverage
  return <div role="img" aria-label={`${label}: ${RATED_OUTCOMES.map(outcome => `${counts[outcome]} ${outcome}`).join(', ')}, ${ratingCount(judged)}`} className="sentiment-property-bar">
    {RATED_OUTCOMES.filter(outcome => counts[outcome] > 0).map(outcome => <span key={outcome} data-outcome={outcome} className={`sentiment-bar-segment ${OUTCOME_FILL[outcome]}`} style={{ flexGrow: counts[outcome] }} />)}
  </div>
}

/**
 * The server's most criticized Properties (`criticizedProperties`, ranked by
 * counts in the API), as their breakdown rows, in the server's order. Nothing
 * is ranked or cut here.
 */
export function mostCriticizedProperties(summary: Pick<SentimentSummary, 'breakdowns' | 'criticizedProperties'>): SentimentSummary['breakdowns'] {
  const rows = new Map(summary.breakdowns.filter(row => row.dimension === 'property').map(row => [row.key, row]))
  return (summary.criticizedProperties?.keys ?? []).flatMap(key => rows.get(key) ?? [])
}

/**
 * The Favorable column: the server's favorable share, or from no ratings up to
 * {@link SENTIMENT_MIN_RATED} the app's empty value, which says why in its
 * tooltip and to a screen reader. Only ever the share, never a count or a word.
 */
function FavorableCell({ value, label }: { value: Pick<SentimentHeadline, 'score' | 'coverage'>; label: string }) {
  return <div role="group" aria-label={`${label} favorable share`} className="sentiment-class-favorable">
    {drawsSegments(value)
      ? <span className="sentiment-class-share">{value.score.favorableDisplay}</span>
      : <><span aria-hidden="true" className="sentiment-class-empty" title={SENTIMENT_COPY.minRated}>{EM_DASH}</span><span className="sr-only">{SENTIMENT_COPY.minRated}</span></>}
  </div>
}

type RatedCoverage = Pick<SentimentHeadline['coverage'], 'ratedAnswers' | 'eligibleAnswers' | 'ratedAnswerRate'>
/** "16 of 20 answers rated": the server's rated and eligible answer counts. */
function ratedAnswersText({ ratedAnswers = 0, eligibleAnswers = 0 }: RatedCoverage) { return `${ratedAnswers} of ${eligibleAnswers} ${eligibleAnswers === 1 ? 'answer' : 'answers'} rated` }
/**
 * The Rated column's figure: the server's share of a class's answers that got a
 * rating (favorable, mixed or unfavorable), `coverage.ratedAnswerRate`, in the
 * shared percent format, and the counts behind it ("16 of 20 answers rated").
 * The server counts every eligible answer, admitted or not, and an answer
 * assessed for several subjects once; nothing here divides. With no eligible
 * answers it is the app's empty value with "No answers yet"; from a server too
 * old to send the counts it is the empty value with "Unavailable", which makes
 * no claim about answers. `empty` marks every empty value.
 */
export function sentimentRatedShare(coverage: RatedCoverage): { display: string; detail: string; empty: boolean } {
  const { eligibleAnswers } = coverage
  if (eligibleAnswers === undefined) return { display: EM_DASH, detail: SENTIMENT_COPY.ratedUnavailable, empty: true }
  if (eligibleAnswers <= 0) return { display: EM_DASH, detail: SENTIMENT_COPY.noAnswers, empty: true }
  // A null share with eligible answers means the server withholds it: sentiment is off.
  if (coverage.ratedAnswerRate === null || coverage.ratedAnswerRate === undefined) return { display: EM_DASH, detail: SENTIMENT_COPY.states.disabled, empty: true }
  return { display: formatPercent(coverage.ratedAnswerRate, RatioUnits.fraction), detail: ratedAnswersText(coverage), empty: false }
}

/**
 * The Rated column: only the share of answers rated, or the muted empty value
 * with no eligible answers or no answer counts from the server. The count
 * behind it is its tooltip and its screen-reader text, and Details lists it as
 * "Rated answers".
 */
function RatedCell({ coverage, label }: { coverage: RatedCoverage; label: string }) {
  const { display, detail, empty } = sentimentRatedShare(coverage)
  return <div role="group" aria-label={`${label} share rated`} className="sentiment-class-ratings">
    <span aria-hidden="true" className={empty ? 'sentiment-class-empty' : undefined} title={detail}>{display}</span><span className="sr-only">{empty ? detail : `${display}, ${detail}`}</span>
  </div>
}

/**
 * A short note under the bar, only when a class has one: its state while it
 * has no ratings ("No ratings yet."), or "Partial results" beside rated ones.
 */
function SentimentClassNote({ value }: { value: Pick<SentimentHeadline, 'score' | 'coverage' | 'provisional' | 'state'> }) {
  if (hasRatings(value)) {
    return value.provisional ? <p className="sentiment-class-note text-caution">{SENTIMENT_COPY.partial}</p> : null
  }
  return <p className="sentiment-class-note">{value.state === 'complete' ? SENTIMENT_COPY.noJudgments : SENTIMENT_COPY.states[value.state]}</p>
}

/** Whether a class has anything for its Details to show. */
function hasHeadlineDetails(value: SentimentSummary) { return Boolean(value.coverage.selected || value.coverage.eligibleAssessments || value.reason) }

/**
 * A class's Details: a chevron button in the last column of its line, named
 * "<class> details", and a floating panel of facts anchored under it, over the
 * content below rather than pushing it down. A non-modal popover, not a menu:
 * the button carries aria-expanded and aria-controls, and the panel is a group
 * named by its class heading that follows the button in tab order. Outside
 * click, Escape (focus returns to the button) and focus moving elsewhere close
 * it, as the project "More" menu does. {@link SentimentHeadlines} keeps one
 * panel open at a time.
 */
function SentimentHeadlineDetails({ value, queryClass, open, setOpenClass }: { value: SentimentSummary; queryClass: QueryClass; open: boolean; setOpenClass: Dispatch<SetStateAction<QueryClass | null>> }) {
  const scope = useContext(SentimentContext)
  const panelId = useId()
  const titleId = useId()
  const propertiesId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpenClass(current => current === queryClass ? null : current), [setOpenClass, queryClass])
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(triggerRef.current?.contains(target) || panelRef.current?.contains(target))
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) close() }
    const onFocusIn = (event: FocusEvent) => { if (!inside(event.target)) close() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])
  const { coverage, score } = value
  const interval = sentimentIntervalText(score)
  // With the share hidden, the rated outcomes are the only view of the ratings.
  const tooFew = coverage.judged > 0 && !showsFavorableShare(coverage.judged)
  const criticized = queryClass === 'branded' ? mostCriticizedProperties(value) : []
  if (!hasHeadlineDetails(value)) return null
  return <>
    <button ref={triggerRef} type="button" className="sentiment-class-details-toggle" aria-label={`${CLASS_LABEL[queryClass]} details`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpenClass(current => current === queryClass ? null : queryClass)}><ChevronDown className="sentiment-class-details-chevron" aria-hidden="true" /></button>
    <div ref={panelRef} id={panelId} role="group" aria-labelledby={titleId} className="sentiment-class-details" hidden={!open}>
      <p id={titleId} className="sentiment-class-details-title">{CLASS_LABEL[queryClass]}</p>
      <dl className="sentiment-details-list">
        {(coverage.eligibleAnswers ?? 0) > 0 && <div><dt>{SENTIMENT_COPY.details.ratedAnswers}</dt><dd>{coverage.ratedAnswers ?? 0} of {coverage.eligibleAnswers}</dd></div>}
        {tooFew && RATED_OUTCOMES.filter(outcome => coverage.counts[outcome] > 0).map(outcome => <div key={outcome}><dt>{outcomeLabel(outcome)}</dt><dd>{coverage.counts[outcome]}</dd></div>)}
        {tooFew && <div><dt>Favorable share</dt><dd>{SENTIMENT_COPY.minRated}</dd></div>}
        {interval && <div><dt>{SENTIMENT_COPY.details.interval} <InfoTooltip text={score.limitation} placement="bottom" /></dt><dd>{interval}</dd></div>}
      </dl>
      {scope && criticized.length > 0 && <div className="sentiment-details-properties" role="group" aria-labelledby={propertiesId}>
        <p id={propertiesId} className="sentiment-details-subtitle">{SENTIMENT_COPY.properties.title}{value.criticizedProperties && value.criticizedProperties.total > criticized.length ? <span className="sentiment-details-subtitle-count"> · {criticized.length} of {value.criticizedProperties.total}</span> : null}</p>
        <ul>{criticized.map(row => <li key={row.key} className="sentiment-property">
          <button type="button" className="sentiment-property-name" aria-label={`View ${SENTIMENT_COPY.properties.evidence} answers for ${row.label}`} onClick={() => {
            if (!triggerRef.current) return
            // A market view holds its market in scope/scopeKey; narrowing to the Property keeps it as marketKey, or the sheet would read every market.
            const source = requestSelection(scope, value)
            scope.openEvidence({ ...source, queryClass, scope: 'property', scopeKey: row.key, marketKey: source.scope === 'market' ? source.scopeKey : source.marketKey, outcome: CRITICISM_OUTCOMES }, `${row.label}, ${SENTIMENT_COPY.properties.evidence}`, triggerRef.current)
          }}>{row.label}</button>
          <span className="sentiment-property-count">{row.coverage.counts.favorable} of {row.coverage.judged} favorable</span>
          <PropertyOutcomeBar value={row} label={row.label} />
        </li>)}</ul>
        <button type="button" className="sentiment-property-name sentiment-details-view-all" onClick={() => { if (triggerRef.current) scope.openEvidence({ ...requestSelection(scope, value), queryClass, outcome: CRITICISM_OUTCOMES }, SENTIMENT_COPY.properties.allEvidence, triggerRef.current) }}>{SENTIMENT_COPY.properties.viewAll}</button>
      </div>}
      {(coverage.unadmittedAssessments > 0 || Object.entries(coverage.counts).some(([outcome, count]) => count > 0 && !RATED_OUTCOMES.includes(outcome as typeof RATED_OUTCOMES[number]))) && <p className="sentiment-details-caption">{SENTIMENT_COPY.details.checksCaption}</p>}
      <dl className="sentiment-details-list">
        {coverage.unadmittedAssessments > 0 && <div><dt>{SENTIMENT_COPY.details.unadmitted}</dt><dd>{coverage.unadmittedAssessments}</dd></div>}
        {Object.entries(coverage.counts).filter(([outcome, count]) => count > 0 && !['favorable', 'mixed', 'unfavorable'].includes(outcome)).map(([outcome, count]) => <div key={outcome}><dt>{outcomeLabel(outcome)}</dt><dd>{count}</dd></div>)}
      </dl>
      {value.reason && <p className="sentiment-class-details-reason">{value.reason}</p>}
    </div>
  </>
}

/** An overview shows the measured branded score, or no sentiment metric: non-brand answers name you only to recommend you. */
export function showsSentimentOverview(value?: SentimentOverview): value is SentimentOverview {
  return Boolean(value?.configured && value.branded.coverage.judged > 0 && value.branded.score.favorableRate !== null) && !isEmbed()
}

/**
 * Portfolio values come from the existing overview response, never separate
 * per-card requests. Below {@link SENTIMENT_MIN_RATED} ratings the figure
 * reads "too few", as the Tone card does; the counts stay in the ⓘ.
 */
export function SentimentOverviewMetric({ value }: { value?: SentimentOverview }) {
  if (!showsSentimentOverview(value)) return null
  const headline = value.branded
  const judged = headline.coverage.judged
  const interval = sentimentIntervalText(headline.score)
  const detail = `${SENTIMENT_COPY.overall} ${judged} of ${headline.coverage.selected} judged${interval ? `, 95% interval ${interval}` : ''}. ${headline.provisional ? 'Provisional. ' : ''}${SENTIMENT_COPY.states[headline.state]}${headline.reason ? ` ${headline.reason}` : ''}`
  return <div className="project-row-stat" data-sentiment-score>
    <div className="metric-inline-block">
      <div className="flex items-center gap-1"><p className="metric-inline-label">Sentiment</p><span className="relative z-10"><InfoTooltip text={detail} placement="bottom" /></span></div>
      {showsFavorableShare(judged)
        ? <p className="metric-inline-value">{headline.score.favorableDisplay}<span className="sr-only"> favorable judgments, branded queries</span></p>
        : <p className="metric-inline-value text-secondary">{SENTIMENT_COPY.tooFew}<span className="sr-only"> ratings for a favorable share, {judged} of {SENTIMENT_MIN_RATED} needed, branded queries</span></p>}
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
/** A summary's resolved selection as a request, as the query rows build theirs: one run or a run set, never both. */
function requestSelection(scope: ScopeValue, summary: Pick<SentimentSummary, 'selection'>): SentimentSelection {
  const { selection } = summary
  return { ...scope.selection, ...selection, runId: selection.runId ?? undefined, runIds: selection.runId ? undefined : selection.runIds, revision: selection.revision ?? undefined, evaluationDefinitionId: selection.evaluationDefinitionId ?? undefined }
}
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

/**
 * The query classes a headline view shows a line for, or null when the block is
 * absent. Sentiment is a branded figure, so every class view shows the branded
 * line; a non-brand or all-queries view adds non-brand's unfavorable and mixed answers under it.
 */
function headlineClasses(scope: ScopeValue | null, queryClass: QueryClassView): readonly QueryClass[] | null {
  if (!scope?.configured || queryClass === 'unknown' || queryClass === 'unclassified') return null
  return ['branded']
}

/**
 * Names the bar segment colors. Shown only once a bar in view draws segments,
 * so never for classes that are all below {@link SENTIMENT_MIN_RATED} ratings.
 */
export function SentimentLegend({ queryClass = 'all' }: { queryClass?: QueryClassView }) {
  const scope = useContext(SentimentContext)
  const classes = headlineClasses(scope, queryClass)
  if (!scope?.hasSourceEvidence || !classes?.some(value => drawsSegments(scope.summaries[value].data))) return null
  return <ul className="sentiment-legend" aria-hidden="true">
    {RATED_OUTCOMES.map(outcome => <li key={outcome}><span className={`sentiment-legend-swatch ${OUTCOME_FILL[outcome]}`} />{outcomeLabel(outcome)}</li>)}
  </ul>
}

/**
 * Non-brand sentiment as exceptions only. A general answer names you only to
 * recommend you, so its favorable share says nothing; the server's unfavorable
 * and mixed counts do. The line appears when either is above zero and opens
 * those answers. A non-brand view also says when none were, once non-brand is rated.
 */
function NonBrandCriticism({ queryClass }: { queryClass: QueryClassView }) {
  const scope = useContext(SentimentContext)
  if (!scope?.hasSourceEvidence) return null
  const query = scope.summaries['non-brand']
  const summary = query.data
  const nonBrandView = queryClass === 'non-brand'
  // The all-queries view lists exceptions only; the non-brand view also says how its answers stand.
  if (!summary) {
    if (!nonBrandView) return null
    return query.isError
      ? <p role="alert" className="sentiment-nonbrand-note">Couldn’t load non-brand sentiment. <Button variant="ghost" onClick={() => { void query.refetch() }}>Retry</Button></p>
      : <p role="status" className="sentiment-nonbrand-note">Loading non-brand sentiment…</p>
  }
  const counts = summary.coverage.counts
  if (counts.unfavorable === 0 && counts.mixed === 0) {
    if (!nonBrandView) return null
    // "None" only from a final read. Ratings so far are "none so far"; with none, the class's own state
    // (a terminal partial is "Partial results.", never "Analyzing").
    if (isFinal(summary)) return <p className="sentiment-nonbrand-note">{SENTIMENT_COPY.nonBrand.none}</p>
    if (hasRatings(summary)) return <p className="sentiment-nonbrand-note">{SENTIMENT_COPY.nonBrand.noneSoFar}</p>
    return <p className="sentiment-nonbrand-note">{summary.state === 'not-measured' ? SENTIMENT_COPY.nonBrand.notRated : `${SENTIMENT_COPY.nonBrand.label}: ${stateText(summary)}`}</p>
  }
  return <div className="sentiment-nonbrand" role="group" aria-label={SENTIMENT_COPY.nonBrand.label}>
    <div className="sentiment-nonbrand-line">
      <span className="sentiment-nonbrand-label">{SENTIMENT_COPY.nonBrand.label}<InfoTooltip text={SENTIMENT_COPY.nonBrand.help} /></span>
      <span className="sentiment-nonbrand-counts">
        {CRITICISM_OUTCOMES.slice().reverse().filter(outcome => counts[outcome] > 0).map(outcome => <span key={outcome}><span aria-hidden="true" className={`sentiment-legend-swatch ${OUTCOME_FILL[outcome as typeof RATED_OUTCOMES[number]]}`} />{counts[outcome]} {outcome}</span>)}
        {!isFinal(summary) && <span className="text-caution">{SENTIMENT_COPY.partial}</span>}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={event => scope.openEvidence({ ...requestSelection(scope, summary), queryClass: 'non-brand', outcome: CRITICISM_OUTCOMES }, SENTIMENT_COPY.nonBrand.evidence, event.currentTarget)}>{SENTIMENT_COPY.nonBrand.view}</Button>
    </div>
  </div>
}

/**
 * The Sentiment block: a title row (with Manage sentiment when `manage`), the
 * legend under it (unless `legend={false}`), a small header naming the figure
 * columns, then the Branded line in every class view: the label and ⓘ, a
 * stacked bar of the rated outcomes that takes all the remaining space, then
 * Favorable (the share), With opinion (the share of answers rated) and the
 * Details chevron, each in a fixed column. A note under the bar carries a state
 * or partial results. All-queries and non-brand views add the non-brand line
 * ({@link NonBrandCriticism}): its unfavorable and mixed answers, never a share.
 */
export function SentimentHeadlines({ queryClass = 'all', legend = true, manage = false }: { queryClass?: QueryClassView; legend?: boolean; manage?: boolean }) {
  const scope = useContext(SentimentContext)
  const classes = headlineClasses(scope, queryClass)
  // Whether the Branded line's Details panel is open.
  const [openClass, setOpenClass] = useState<QueryClass | null>(null)
  if (!scope) return null
  // No line to show (sentiment off, its source not resolved yet, or an unclassified view): an
  // administrator still gets the switch under the section's title, and "off" only when the settings say so.
  if (!classes) {
    const settings = scope.settings.data
    if (!manage || !settings?.actions.configure) return null
    return <div className="sentiment-headlines-title"><div><h3 className="sentiment-headlines-heading">{SENTIMENT_COPY.title}</h3>{!(settings.enabled && settings.installEnabled) && <p className="sentiment-headlines-subtitle">{SENTIMENT_COPY.states.disabled}</p>}</div><SentimentControls /></div>
  }
  // The header names columns only a loaded class fills. Each figure also names itself to a screen reader.
  const columns = scope.hasSourceEvidence && classes.some(value => scope.summaries[value].data)
  return <div className="sentiment-headlines" role="group" aria-label="Favorable answer scores">
    <div className="sentiment-headlines-title"><div><h3 className="sentiment-headlines-heading">{SENTIMENT_COPY.title}</h3><p className="sentiment-headlines-subtitle">{SENTIMENT_COPY.subtitle}</p></div>{manage && <SentimentControls />}</div>
    {legend && <SentimentLegend queryClass={queryClass} />}
    {columns && <div className="sentiment-headlines-columns" aria-hidden="true"><span className="sentiment-headlines-favorable">{SENTIMENT_COPY.columns.favorable}</span><span className="sentiment-headlines-ratings" title={SENTIMENT_COPY.rated}>{SENTIMENT_COPY.columns.rated}</span></div>}
    {classes.map(value => {
      const query = scope.summaries[value]
      return <div key={value} className="sentiment-class" data-query-class={value}>
        <div className="sentiment-class-label"><span>{CLASS_LABEL[value]}</span><InfoTooltip text={SENTIMENT_COPY.favorable} /></div>
        {!scope.hasSourceEvidence ? <p className="sentiment-class-status">No saved answers.</p> : query.data ? <>
          <SentimentBar value={query.data} label={CLASS_LABEL[value]} />
          <FavorableCell value={query.data} label={CLASS_LABEL[value]} />
          <RatedCell coverage={query.data.coverage} label={CLASS_LABEL[value]} />
          <SentimentClassNote value={query.data} />
          <SentimentHeadlineDetails value={query.data} queryClass={value} open={openClass === value} setOpenClass={setOpenClass} />
        </> : query.isError ? <p role="alert" className="sentiment-class-status">Couldn’t load sentiment. <Button variant="ghost" onClick={() => { void query.refetch() }}>Retry</Button></p> : <p role="status" className="sentiment-class-status">Loading sentiment…</p>}
      </div>
    })}
    {queryClass !== 'branded' && <NonBrandCriticism queryClass={queryClass} />}
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
  // A non-brand row shows only its unfavorable and mixed answers, as the Sentiment block does: its favorable share runs near 100%.
  if (row.queryClass === 'non-brand') {
    if (value.state === 'unsupported') return <span className="text-sm text-secondary">Unavailable</span>
    const { unfavorable, mixed } = value.coverage.counts
    if (unfavorable === 0 && mixed === 0) {
      const label = showLabel && <span className="block text-sm font-normal text-secondary">{SENTIMENT_COPY.nonBrand.rowLabel}</span>
      // Only a final read establishes "none"; an unrated, pending, failed, canceled or partial row says its state.
      if (!isFinal(value)) return <span className="text-sm text-secondary">{label}<span>{stateText(value)}</span></span>
      return <span className="text-sm text-muted">{label}<span aria-hidden="true" title={SENTIMENT_COPY.nonBrand.rowNone}>{EM_DASH}</span><span className="sr-only">{SENTIMENT_COPY.nonBrand.rowNone}</span></span>
    }
    return <Button type="button" variant="ghost" className="h-auto min-h-11 flex-col items-start gap-0 px-1" aria-label={`View unfavorable and mixed answers for ${row.queryText}`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); scope.openEvidence({ ...selection, outcome: CRITICISM_OUTCOMES }, `${row.queryText}, unfavorable and mixed`, event.currentTarget) }}>
      {showLabel && <span className="text-sm font-normal text-secondary">{SENTIMENT_COPY.nonBrand.rowLabel}</span>}{unfavorable > 0 && <span className="text-sm text-negative">{unfavorable} unfavorable</span>}{mixed > 0 && <span className="text-sm text-caution">{mixed} mixed</span>}{value.provisional && <span className="text-xs font-normal text-caution">Provisional</span>}
    </Button>
  }
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
      const tone = outcomeTone(item.outcome)
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
    <div className="flex flex-wrap items-center gap-2"><strong className="text-primary">{item.subject.displayName}</strong><ToneBadge tone={outcomeTone(item.outcome)}>{outcomeLabel(item.outcome)}</ToneBadge><span>{CLASS_LABEL[item.context.queryClass]}</span><span>{item.context.provider}</span><span>{item.context.servedModel ?? 'Source model unavailable'}</span><span>{item.context.location ?? 'No location'}</span></div>
    {item.reason && <p>{item.reason}</p>}
    <section><h3 className="mb-2 text-heading">Conclusion evidence</h3>{item.conclusion.length ? item.conclusion.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No valid conclusion evidence is available.</p>}</section>
    <section><h3 className="mb-2 text-heading">Complaint evidence</h3>{item.complaint?.length ? item.complaint.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No complaint was identified.</p>}</section>
    <details><summary className="cursor-pointer">Original source answer</summary><p className="mt-2 whitespace-pre-wrap break-words text-primary">{item.sourceText}</p></details>
    <details><summary className="cursor-pointer">Assessment provenance</summary><dl className="mt-3 space-y-2 break-all"><dt>Query</dt><dd>{item.context.queryText}</dd><dt>Subject</dt><dd>{item.subject.displayName} ({item.subject.id})</dd><dt>Run</dt><dd>{item.runId}</dd><dt>Revision</dt><dd>{item.context.revision ?? 'Unavailable'}</dd><dt>Evaluator</dt><dd>{item.returnedModel ?? 'Unavailable'}</dd><dt>Evaluation definition</dt><dd>{item.evaluationDefinitionId}</dd><dt>Source snapshot</dt><dd>{item.sourceSnapshotId}</dd><dt>Source hash</dt><dd>{item.sourceTextHash}</dd>{item.context.usageEdges.map((edge, index) => <div key={index}><dt>Assignment</dt><dd>Target {edge.targetId}; Property {edge.propertyId ?? 'None'}; market {edge.marketId ?? 'None'}; {edge.queryClass}</dd></div>)}</dl></details>
  </article>
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
