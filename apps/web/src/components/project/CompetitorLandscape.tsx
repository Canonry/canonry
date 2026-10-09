import { competitorLabelFromDomain, formatPercent, RatioUnits } from '@ainyc/canonry-contracts'
import React, { useId, useState } from 'react'
import type { CompetitorLandscapeResponse, CompetitorLandscapeRow as CompetitorLandscapeRowDto, ShareOfVoiceContext } from '@ainyc/canonry-contracts'

import { siteCitationLabel, splitPercentSign } from '../../lib/format-helpers.js'
import { mentionShareTone, METRIC_TONE_TEXT_CLASS } from '../../lib/tone-helpers.js'
import { Disclosure } from '../shared/Disclosure.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SegmentedRadioGroup } from '../shared/SegmentedRadioGroup.js'
import { Button } from '../ui/button.js'

export type CompetitorLandscapeWindow = '7d' | '30d' | '90d' | 'all'
/** Shared API types, re-exported so presentational tests use the public wire contract. */
export type CompetitorLandscapeRow = CompetitorLandscapeRowDto
export type CompetitorLandscapeData = CompetitorLandscapeResponse
type CompetitorMutation = (domain: string) => boolean | void | Promise<boolean | void>
type QueryClassFilter = CompetitorLandscapeResponse['filters']['queryClass']

const WINDOW_OPTIONS: readonly { value: CompetitorLandscapeWindow; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All' },
]

const WINDOW_PHRASE: Record<CompetitorLandscapeWindow, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  all: 'all sweeps',
}

const CLASS_WORD: Record<QueryClassFilter, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  all: 'All queries',
}

/**
 * Say which queries the numbers came from. Mention share is a ratio, so a
 * pooled basket is not just less precise, it points the wrong way: a brand wins
 * its own branded queries by definition.
 */
const CLASS_NOTE: Record<QueryClassFilter, string> = {
  'non-brand': 'Counts queries that do not name your brand.',
  branded: 'Counts queries that name your brand.',
  all: 'Counts every tracked query, so mention share is not shown.',
}

/**
 * Why mention share has no figure, as a Details fragment after "Mention
 * share: ". The CLI and reports keep the full sentences (`shareOfVoiceReason`).
 */
const MENTION_SHARE_REASON: Record<NonNullable<ShareOfVoiceContext['reason']>, string> = {
  'select-query-class': 'no query type selected',
  'answer-selection': 'answers selected by the brands they named',
  'no-competitors': 'no competitors configured',
  'insufficient-observed': 'needs 3 observed competitors, each named in 3 or more answers',
  'no-answers': 'no answer text',
  'no-mentions': 'no brands named',
  unavailable: 'competitor data unavailable',
}

const LANDSCAPE_DEFINITIONS = 'Mention share: your share of the brand mentions in these answers, each brand counted at most once per answer. Named: answers that name the brand. Cited: answers whose sources link to its site. Company names in answers are observations. Only competitor sites count toward mention share.'

/** The server's cap on ranked observed and source rows (COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT); pins are never cut. */
const RANKED_ROW_LIMIT = 100

type MetricAvailability = 'measured' | 'not-measured' | 'unavailable'

function metricAvailability(landscape: CompetitorLandscapeData | undefined): MetricAvailability {
  if (!landscape) return 'unavailable'
  // A zero count is meaningful only after the selected window contains stored
  // answer or source evidence. A completely empty window has no denominator.
  return landscape.evidence.answeredResults > 0 || landscape.evidence.sourceResults > 0
    ? 'measured'
    : 'not-measured'
}

function unavailableMetricLabel(availability: MetricAvailability): string {
  return availability === 'unavailable' ? 'Unavailable' : 'Not measured'
}

function sourceClassLabel(sourceClass: CompetitorLandscapeRow['surfaceClass']): string {
  switch (sourceClass) {
    case 'own': return 'Your domain'
    case 'direct-competitor': return 'Competitor'
    case 'ota-aggregator': return 'Aggregator'
    case 'editorial-media': return 'Editorial'
    case 'other': return 'Other'
    default: return 'Unclassified'
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/** A display name that says more than its domain, or null when it only repeats it. */
function displayName(row: Pick<CompetitorLandscapeRow, 'domain' | 'label'>): string | null {
  const label = row.label.trim()
  const generated = competitorLabelFromDomain(row.domain)
  return label && label.toLowerCase() !== row.domain.toLowerCase() && label.toLowerCase() !== generated.toLowerCase() ? label : null
}

/**
 * A brand's display name with its domain beside it, or the domain alone, plus
 * its curated aliases and the names detected from stored answers, each of
 * those labelled "auto".
 */
function BrandName({ row, aliases = [], autoAliases = [] }: {
  row: Pick<CompetitorLandscapeRow, 'domain' | 'label'>
  aliases?: readonly string[]
  autoAliases?: readonly string[]
}) {
  const name = displayName(row)
  const named = [...aliases.map(alias => ({ alias, auto: false })), ...autoAliases.map(alias => ({ alias, auto: true }))]
  const aliasNote = named.length > 0
    ? (
        <span className="av-of block">
          Also named{' '}
          {named.map(({ alias, auto }, index) => (
            <span key={`${auto ? 'auto' : 'curated'}:${alias}`}>
              {index > 0 ? ', ' : ''}{alias}
              {auto ? <span className="av-alias-auto" title="Detected automatically from this project's stored answers"> (auto)</span> : null}
            </span>
          ))}
        </span>
      )
    : null
  return name
    ? <>{name} <span className="av-of">{row.domain}</span>{aliasNote}</>
    : <>{row.domain}{aliasNote}</>
}

/** The same, as plain text for a list line: "Review site (review.example)". */
function brandText(row: Pick<CompetitorLandscapeRow, 'domain' | 'label'>): string {
  const name = displayName(row)
  return name ? `${name} (${row.domain})` : row.domain
}

/** "top 100" when the server cut the list at its cap, else the count. */
function listSize(shown: number, truncated: boolean): React.ReactNode {
  return truncated && shown >= RANKED_ROW_LIMIT ? <>top <strong>{shown}</strong></> : <strong>{shown}</strong>
}

function MutationButton({
  action,
  domain,
  mutation,
}: {
  action: 'pin' | 'unpin'
  domain: string
  mutation: CompetitorMutation
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (await mutation(domain) === false) setError(`Could not ${action} competitor. Try again.`)
    } catch {
      setError(`Could not ${action} competitor. Try again.`)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => { void run() }}>
        {action === 'pin' ? 'Pin' : 'Unpin'}{' '}
        <span className="sr-only">{domain}</span>
      </Button>
      {error ? <span role="alert" className="sr-only">{error}</span> : null}
    </>
  )
}

function SourceUrls({ urls }: { urls: readonly string[] }) {
  // A windowed historical reading. Never link a row to the project's
  // latest-only evidence table, which would make an older result look like
  // current evidence; the stored sample URLs are the row's evidence.
  return (
    <details className="inline-disclosure text-left text-xs text-secondary">
      <summary>Source URLs</summary>
      <ul className="mt-2 max-w-72 space-y-1 font-mono text-[11px] font-normal">
        {urls.map(url => <li key={url} className="break-all">{url}</li>)}
      </ul>
    </details>
  )
}

function Count({ count, of, state, toneClass }: { count: number; of: number; state: MetricAvailability; toneClass: string }) {
  if (state !== 'measured') return <span className="text-[13px] text-secondary">{unavailableMetricLabel(state)}</span>
  // One unit even in a grid's last column, which may otherwise wrap on a phone.
  return (
    <span className="whitespace-nowrap">
      <span className={`av-n-sm ${toneClass}`}>{count}</span>{' '}
      <span className="av-of">of {of}</span>
    </span>
  )
}

function Share({ percent, state, toneClass }: { percent: number | null; state: MetricAvailability; toneClass: string }) {
  if (state !== 'measured' || percent === null) {
    return <span className="text-[13px] text-secondary">{state === 'measured' ? 'Not measured' : unavailableMetricLabel(state)}</span>
  }
  const { figure, sign } = splitPercentSign(formatPercent(percent, RatioUnits.percent))
  return (
    <span className={`av-n-sm ${toneClass}`}>
      {figure}{sign ? <span className="text-faint">{sign}</span> : null}
    </span>
  )
}

/** Competitors outside the mention-share frame, with their type and a Pin action. */
function OtherCompetitors({
  rows,
  state,
  named,
  cited,
  onPin,
}: {
  rows: readonly CompetitorLandscapeRow[]
  state: MetricAvailability
  named: number
  cited: number
  onPin?: CompetitorMutation
}) {
  return (
    <div className="overflow-x-auto">
      <table className="av-grid av-grid-dense" aria-label="Other competitors seen">
        <thead>
          <tr>
            <th scope="col">Competitor</th>
            <th scope="col">Type</th>
            <th scope="col">Named</th>
            <th scope="col">Cited</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.domain}>
              <th scope="row" className="av-row-label"><BrandName row={row} /></th>
              <td className="text-[13px] text-secondary">{sourceClassLabel(row.surfaceClass)}</td>
              <td><Count count={row.mentionCount} of={named} state={state} toneClass="text-primary" /></td>
              <td><Count count={row.citationCount} of={cited} state={state} toneClass="text-primary" /></td>
              <td>
                <div className="flex min-w-max items-start gap-2">
                  {state === 'measured' && row.sampleUrls.length > 0 ? <SourceUrls urls={row.sampleUrls} /> : null}
                  {onPin ? <MutationButton action="pin" domain={row.domain} mutation={onPin} /> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ManageCompetitors({ onAddCompetitor }: { onAddCompetitor: CompetitorMutation }) {
  const inputId = useId()
  const [domain, setDomain] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function submit() {
    const next = domain.trim()
    if (!next || isSubmitting) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      if (await onAddCompetitor(next) === false) {
        setSubmitError('Could not add competitor. Try again.')
        return
      }
      setDomain('')
    } catch {
      setSubmitError('Could not add competitor. Try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <details className="inline-disclosure">
      <summary>Manage competitors</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        aria-busy={isSubmitting}
      >
        <label htmlFor={inputId} className="min-w-56 flex-1 text-sm font-medium text-heading">
          Competitor domain
          <input
            id={inputId}
            type="text"
            value={domain}
            onChange={event => setDomain(event.target.value)}
            placeholder="competitor.com"
            className="mt-1 h-10 w-full rounded-md border border-default bg-surface px-3 text-sm text-primary placeholder-mono-600 focus:outline-none focus:ring-2 focus:ring-mono-400"
          />
        </label>
        <Button type="submit" size="sm" className="min-h-10" disabled={isSubmitting || !domain.trim()}>
          {isSubmitting ? 'Adding…' : 'Add competitor'}
        </Button>
        {submitError ? <p role="alert" className="w-full text-sm text-negative">{submitError}</p> : null}
      </form>
    </details>
  )
}

/**
 * "Competitors over time": you and the competitors behind mention share, with
 * their type, Mention share, Named and Cited over the selected window. Under
 * the grid, lines that qualify the figures: why share is missing, incomplete
 * data, pending competitors and how many others were seen. Everything else (the
 * base, the brand counts, data-quality counts and the longer lists) is in
 * Details. The rows are the tracked (pinned) competitors,
 * or, with none pinned, the observed competitors the server admitted to the
 * frame; any other competitor sits in Details with its type and a Pin action.
 */
export function CompetitorLandscape({
  window,
  landscape,
  pinnedFallback = [],
  competitorAliases = {},
  competitorAutoAliases = {},
  canWrite,
  isEmbed,
  onWindowChange,
  onPin,
  onUnpin,
  onAddCompetitor,
  error,
  onRetry,
  isLoading = false,
  scopeLabel,
  advancedPortfolio = false,
}: {
  window: CompetitorLandscapeWindow
  landscape?: CompetitorLandscapeData
  /** Current pins remain visible when the exploratory-history read fails. */
  pinnedFallback?: readonly CompetitorLandscapeRow[]
  /** Tracked competitor domain to its curated answer-text aliases, shown on pinned rows. */
  competitorAliases?: Readonly<Record<string, readonly string[]>>
  /** Tracked competitor domain to its answer-derived auto names, shown labelled "auto" on pinned rows. */
  competitorAutoAliases?: Readonly<Record<string, readonly string[]>>
  canWrite: boolean
  isEmbed: boolean
  onWindowChange: (value: CompetitorLandscapeWindow) => void
  onPin?: CompetitorMutation
  onUnpin?: CompetitorMutation
  onAddCompetitor?: CompetitorMutation
  error?: string
  onRetry?: () => void
  isLoading?: boolean
  /** Names the selected Advanced Measurement market, when this is not project-wide. */
  scopeLabel?: string
  /**
   * An Advanced portfolio shows this beside per-property numbers, which credit
   * only a property's own pages. Your row's Cited is the older site-wide count
   * (any page on your domain), so it is labelled that way there.
   */
  advancedPortfolio?: boolean
}) {
  const titleId = useId()
  const canManage = canWrite && !isEmbed
  const pinned = landscape?.pinned ?? pinnedFallback
  const observed = landscape?.observed ?? []
  const otherSources = landscape?.otherSources ?? []
  const evidence = landscape?.evidence
  const metricState = metricAvailability(landscape)
  const observedBasis = landscape?.basis === 'observed'
  const frameRows = observedBasis ? observed.filter(row => row.shareOfVoice !== null) : pinned
  const otherCompetitors = observedBasis ? observed.filter(row => row.shareOfVoice === null) : observed
  const queryClass = landscape?.filters.queryClass
  const pendingDraftCompetitorCount = landscape?.marketState?.draft?.pendingCompetitorDomains.length ?? 0
  const truncated = landscape?.truncated === true

  // Named counts answers with text; Cited also counts answers that kept a
  // source list without text, the same results the server credits citations on.
  const named = evidence?.answeredResults ?? 0
  const cited = evidence ? evidence.answeredResults + evidence.missingAnswerTextResults : 0
  // Only a non-brand share is a competitive read, so only it is tone-coloured.
  const youTone = queryClass === 'non-brand' && landscape?.project.shareOfVoice != null
    ? METRIC_TONE_TEXT_CLASS[mentionShareTone(landscape.project.shareOfVoice)]
    : 'text-primary'
  const rowAction = (row: CompetitorLandscapeRow): React.ReactNode => {
    if (!canManage) return null
    if (row.pinned) return onUnpin ? <MutationButton action="unpin" domain={row.domain} mutation={onUnpin} /> : null
    return onPin ? <MutationButton action="pin" domain={row.domain} mutation={onPin} /> : null
  }
  const showActions = frameRows.some(row => rowAction(row) !== null)

  const meta = [
    scopeLabel,
    queryClass ? CLASS_WORD[queryClass] : null,
    WINDOW_PHRASE[window],
    // Which competitors the rows are, in view: the grid has no group headings.
    landscape?.basis ? (observedBasis ? 'observed competitors only' : 'tracked competitors only') : null,
  ].filter(Boolean).join(' · ')

  // Lines that qualify the grid's figures, shown without opening Details.
  const notes: { key: string; text: string; className?: string }[] = []
  if (landscape && !observedBasis && frameRows.length === 0) notes.push({ key: 'no-pins', text: 'No pinned competitors.' })
  if (landscape?.reason) notes.push({ key: 'reason', text: `Mention share: ${MENTION_SHARE_REASON[landscape.reason]}` })
  if (landscape && otherCompetitors.length > 0) {
    const count = otherCompetitors.length
    notes.push({
      key: 'others',
      text: truncated && count >= RANKED_ROW_LIMIT
        ? `${RANKED_ROW_LIMIT} or more other competitors seen`
        : `${count} other ${plural(count, 'competitor', 'competitors')} seen`,
    })
  }
  if (pendingDraftCompetitorCount > 0) {
    notes.push({
      key: 'pending',
      text: `${landscape?.scope.kind === 'all-markets' ? 'Pending publication across markets' : 'Pending publication'}: ${pendingDraftCompetitorCount} ${plural(pendingDraftCompetitorCount, 'competitor', 'competitors')}`,
    })
  }
  const incomplete = [
    evidence && evidence.missingAnswerTextResults > 0 ? 'Answer data incomplete' : null,
    evidence && evidence.incompleteSourceResults > 0 ? 'Citation data incomplete' : null,
  ].filter(Boolean)
  if (incomplete.length > 0) notes.push({ key: 'incomplete', text: incomplete.join(' · '), className: METRIC_TONE_TEXT_CLASS.caution })

  const details: React.ReactNode[] = []
  if (landscape && evidence) {
    details.push(landscape.runCount !== undefined
      ? <>Base: <strong>{landscape.runCount}</strong> {plural(landscape.runCount, 'sweep', 'sweeps')}, <strong>{evidence.answeredResults}</strong> {plural(evidence.answeredResults, 'answer', 'answers')}</>
      : <>Base: <strong>{evidence.answeredResults}</strong> {plural(evidence.answeredResults, 'answer', 'answers')}</>)
    if (!landscape.reason && metricState === 'measured' && landscape.project.shareOfVoice !== null) {
      details.push(
        <>
          Mention share: you <strong>{landscape.project.mentionCount}</strong>
          {frameRows.map(row => <React.Fragment key={row.domain}>, {row.domain} <strong>{row.mentionCount}</strong></React.Fragment>)}
          {' '}of <strong>{evidence.mentionCredits}</strong> {observedBasis ? 'brand mentions' : 'tracked-brand mentions'}
        </>,
      )
    }
    details.push(<>Answers with source links: <strong>{evidence.sourceResults}</strong></>)
    if (otherCompetitors.length === 0) details.push('Other competitors seen: none')
    if (evidence.missingAnswerTextResults > 0) {
      details.push(<>No answer text: <strong>{evidence.missingAnswerTextResults}</strong> {plural(evidence.missingAnswerTextResults, 'answer', 'answers')}, left out of mention share</>)
    }
    if (evidence.incompleteSourceResults > 0) {
      details.push(<>Incomplete source lists: <strong>{evidence.incompleteSourceResults}</strong> {plural(evidence.incompleteSourceResults, 'answer', 'answers')}, not counted as misses</>)
    }
    const excluded = evidence.excludedProbeResults + evidence.excludedNonCompletedResults
    if (excluded > 0) {
      details.push(<>Left out: <strong>{excluded}</strong> {plural(excluded, 'answer', 'answers')} from spot checks or unfinished sweeps</>)
    }
  }
  const pages = [...(landscape ? [{ name: 'You', row: landscape.project }] : []), ...frameRows.map(row => ({ name: row.domain, row }))]
    .filter(entry => entry.row.sampleUrls.length > 0)
  if (metricState === 'measured' && pages.length > 0) {
    details.push(
      <details className="av-subdetails">
        <summary>Sample pages cited</summary>
        <div className="av-subdetails-body">
          {pages.map(({ name, row }) => (
            <div key={row.domain}>
              <p>{name}</p>
              <ul className="space-y-1 font-mono text-[11px] text-muted">
                {row.sampleUrls.map(url => <li key={url} className="break-all">{url}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </details>,
    )
  }
  if (landscape && otherCompetitors.length > 0) {
    details.push(
      <details className="av-subdetails">
        <summary>Other competitors seen: {listSize(otherCompetitors.length, truncated)}</summary>
        <div className="av-subdetails-body">
          <OtherCompetitors rows={otherCompetitors} state={metricState} named={named} cited={cited} onPin={canManage ? onPin : undefined} />
        </div>
      </details>,
    )
  }
  const observedNames = landscape?.observedNames ?? []
  if (observedNames.length > 0) {
    const total = landscape?.observedNamesTotal ?? observedNames.length
    details.push(
      <details className="av-subdetails">
        <summary>
          Company names in answers: {total > observedNames.length
            ? <>top <strong>{observedNames.length}</strong> of <strong>{total}</strong></>
            : <strong>{observedNames.length}</strong>}
        </summary>
        <ul className="av-subdetails-body">
          {observedNames.map(row => <li key={row.name}>{row.name} · {row.answerCount} {plural(row.answerCount, 'answer', 'answers')}</li>)}
        </ul>
      </details>,
    )
  }
  if (otherSources.length > 0) {
    details.push(
      <details className="av-subdetails">
        <summary>Other sites cited: {listSize(otherSources.length, truncated)}</summary>
        <ul className="av-subdetails-body">
          {otherSources.map(source => (
            <li key={source.domain}>
              <span>{brandText(source)} · {sourceClassLabel(source.surfaceClass)} · {source.citationCount} {plural(source.citationCount, 'citation', 'citations')}</span>
              {source.sampleUrls.length > 0 ? (
                <ul className="mt-1 space-y-1 font-mono text-[11px] text-muted">
                  {source.sampleUrls.map(url => <li key={url} className="break-all">{url}</li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </details>,
    )
  }

  return (
    <section aria-labelledby={titleId} aria-busy={isLoading} className="overview-brief">
      <div className="av-card-head">
        {/* A sibling of the heading, so the heading's name stays the title. */}
        <div className="inline-flex items-center">
          <h2 id={titleId} className="av-card-title">Competitors over time</h2>
          <InfoTooltip text={queryClass ? `${CLASS_NOTE[queryClass]} ${LANDSCAPE_DEFINITIONS}` : LANDSCAPE_DEFINITIONS} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="av-card-meta">{meta}</p>
          <SegmentedRadioGroup label="Competitors over time window" className="flex-wrap" options={WINDOW_OPTIONS} value={window} onChange={onWindowChange} />
        </div>
      </div>

      <div className="av-card-body space-y-3">

        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">
            <span>{error}</span>
            {onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry competitors over time</Button> : null}
          </div>
        ) : null}

        {isLoading && !landscape && pinned.length === 0 ? (
          <div role="status" aria-live="polite" className="h-24 animate-pulse rounded-md bg-surface">
            <span className="sr-only">Loading competitors over time</span>
          </div>
        ) : landscape || frameRows.length > 0 ? (
          <table className="av-grid av-grid-brands" aria-label="Competitors over time">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Brand</span></th>
                <th scope="col" className="av-brand-type">Type</th>
                <th scope="col">Mention share</th>
                <th scope="col">Named</th>
                <th scope="col">Cited</th>
                {showActions ? <th scope="col" className="av-brand-actions"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {landscape ? (
                <tr>
                  {/* Named as before the cleanup: "Canonry (you)", or "You" with no name to show. */}
                  <th scope="row" className="av-row-label">
                    {landscape.project.label.trim() ? <>{landscape.project.label.trim()} <span className="av-of">(you)</span></> : 'You'}
                  </th>
                  <td className="av-brand-type text-[13px] text-secondary">Your brand</td>
                  <td><Share percent={landscape.project.shareOfVoice} state={metricState} toneClass={youTone} /></td>
                  <td><Count count={landscape.project.mentionCount} of={named} state={metricState} toneClass={youTone} /></td>
                  <td>
                    <Count count={landscape.project.citationCount} of={cited} state={metricState} toneClass={youTone} />
                    {advancedPortfolio && metricState === 'measured'
                      ? <span className="block text-[13px] text-secondary">{siteCitationLabel(landscape.project.domain, 'cited')}</span>
                      : null}
                  </td>
                  {showActions ? <td className="av-brand-actions" /> : null}
                </tr>
              ) : null}
              {frameRows.map(row => (
                <tr key={row.domain}>
                  <th scope="row" className="av-row-label"><BrandName row={row} aliases={row.pinned ? competitorAliases[row.domain] : undefined} autoAliases={row.pinned ? competitorAutoAliases[row.domain] : undefined} /></th>
                  <td className="av-brand-type text-[13px] text-secondary">{sourceClassLabel(row.surfaceClass)}</td>
                  <td><Share percent={row.shareOfVoice} state={metricState} toneClass="text-primary" /></td>
                  <td><Count count={row.mentionCount} of={named} state={metricState} toneClass="text-primary" /></td>
                  <td><Count count={row.citationCount} of={cited} state={metricState} toneClass="text-primary" /></td>
                  {showActions ? <td className="av-brand-actions">{rowAction(row)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {notes.length > 0 ? (
          <div className="space-y-1 text-[13px] text-secondary">
            {notes.map(note => <p key={note.key} className={note.className}>{note.text}</p>)}
          </div>
        ) : null}
      </div>

      <Disclosure items={details} />
      {canManage && onAddCompetitor ? (
        <div className="border-t border-subtle px-5 py-3">
          <ManageCompetitors onAddCompetitor={onAddCompetitor} />
        </div>
      ) : null}
    </section>
  )
}
