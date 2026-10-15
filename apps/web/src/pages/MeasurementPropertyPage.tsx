import { usePublishAeroView } from '../contexts/aero-view-context.js'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock, Info, type LucideIcon } from 'lucide-react'
import { formatPercent, MeasurementEvidenceShapes } from '@ainyc/canonry-contracts'
import type {
  MeasurementOverviewResponse,
  MeasurementPlanResponse,
  MeasurementPropertyEvidenceResponse,
} from '@ainyc/canonry-api-client'
import {
  getApiV1ProjectsByNameMeasurementOverviewOptions,
  getApiV1ProjectsByNameMeasurementPlanOptions,
  getApiV1ProjectsByNameMeasurementPropertyCompetitorsOptions,
  getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteOptions,
  getApiV1ProjectsByNameMeasurementQuestionResultOptions,
} from '@ainyc/canonry-api-client/react-query'

import { getEmbedConfig, heyClient, isDashboardManagedSweeps } from '../api.js'
import { MANAGED_SWEEPS_COPY } from '../components/project/ManagedSweepStatus.js'
import { effectiveEmbedProjectTabs, isEmbedProjectTabAllowed } from '../embed.js'
import { Button } from '../components/ui/button.js'
import { BackLink, useInAppBack } from '../components/shared/BackLink.js'
import { formatObservedInstantLabel, formatObservedInstantMonthDay, observedInstant } from '../components/shared/ChartPrimitives.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { StatusNote } from '../components/shared/StatusNote.js'
import { AnswerMarkdown, ANSWER_SOURCES_LABEL } from '../components/shared/AnswerMarkdown.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { excludedAnswersLabel, splitPercentSign, type CoverageSignal } from '../lib/format-helpers.js'
import { SourceLink } from '../components/shared/SourceLink.js'
import { carryVisibilitySearch, parseVisibilitySelection, patchVisibilitySelection } from '../lib/measurement-view-url.js'
import { providerDisplayName } from '../lib/visibility-trend-helpers.js'
import type { VisibilitySelectionState } from '../lib/measurement-view-url.js'
import { MARKET_SCOPE_COPY } from '../components/project/VisibilityScopePicker.js'
import { VISIBILITY_TOOLBAR_COPY } from '../components/project/VisibilityTrendSection.js'
import { useAccount } from '../contexts/account-context.js'
import { AddLocationQueryButton } from '../components/project/DiscoverySection.js'
import { LocationSidePanel } from '../components/project/location/LocationSidePanel.js'
import { LocationPlaces, LocationTrackedSection } from '../components/project/location/LocationTrackedSection.js'

type QueryClass = 'branded' | 'non-brand'
type MetricValue = MeasurementOverviewResponse['metrics']['mentionCoverage']
type PropertyRow = MeasurementOverviewResponse['properties']['items'][number]
/**
 * This page reads the ANSWER shape: one row per measured answer, with the cited
 * URLs nested inside it. The per-URL shape can only describe a citation, so an
 * answer that mentioned this Property without linking it — or did neither —
 * produced no row at all, and the panel could corroborate a win while staying
 * silent about every gap.
 */
type AnswerPage = NonNullable<MeasurementPropertyEvidenceResponse['answers']>
type AnswerRow = AnswerPage['items'][number]
type AnswerSource = AnswerRow['sources'][number]
type OtherQueryPage = NonNullable<MeasurementPropertyEvidenceResponse['otherQueries']>
type OtherQueryRow = OtherQueryPage['items'][number]
type ActivePlan = NonNullable<MeasurementPlanResponse['active']>
type PlanV2 = Extract<ActivePlan['plan'], { schemaVersion: 2 }>

const EVIDENCE_PAGE_SIZE = 50
/** The way back over the page's name: a small link, a full-size target where a finger is the pointer. */
const BACK_LINK = 'rounded-sm text-xs text-muted hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11'
const NO_COMPLETED_SWEEP = 'No completed sweep yet'
/**
 * Sent on every results read of this page. Until the published setup has a
 * completed sweep of its own, the server answers with the last one, read under
 * the setup it ran with, and says so in `measurement.awaitingSweep`. Without
 * it every number here blanks on each tracking change.
 */
const LAST_SWEEP = { fallback: 'last-sweep' } as const

/** The two query types, named as the Queries tab names them. */
const CLASS_LABELS: Record<QueryClass, string> = { branded: 'Branded', 'non-brand': 'Non-brand' }

/** A type mid-sentence, for a tooltip or a button's accessible name: "branded queries". */
function classQueries(queryClass: QueryClass): string {
  return `${CLASS_LABELS[queryClass].toLocaleLowerCase()} queries`
}

interface UnavailableReason { label: string; detail?: string; icon?: LucideIcon }

/**
 * Why a number is missing, in the reader's language. A metric with no evidence
 * renders one of these and never a percentage — "0%" is a measured result and
 * saying it here would invent one. A reason that takes a sentence keeps it as
 * `detail`, which the label opens (`ReasonLabel`). The sentence is this page's
 * own: the shared one still says property.
 */
const UNAVAILABLE_REASONS: Record<string, UnavailableReason> = {
  plan_v1: { label: 'Setup update required' },
  no_completed_run: { label: NO_COMPLETED_SWEEP },
  no_population: { label: 'No queries tracked' },
  evidence_incomplete: { label: 'Evidence incomplete' },
  identity_ambiguous: { label: 'Unclear answers', detail: 'No answer could be tied to one location.' },
  not_applicable: { label: 'Not applicable' },
}

/** Measurement state in the operator's language, never the wire token. */
const MEASUREMENT_STATES: Record<
  MeasurementOverviewResponse['measurement']['state'],
  { label: string; tone: 'positive' | 'caution' | 'neutral' | 'negative' }
> = {
  complete: { label: 'Measured', tone: 'positive' },
  partial: { label: 'Partly measured', tone: 'caution' },
  running: { label: 'Measuring now', tone: 'neutral' },
  queued: { label: 'Measurement queued', tone: 'neutral' },
  failed: { label: 'Measurement failed', tone: 'negative' },
  not_measured: { label: 'Not measured', tone: 'neutral' },
}

export const EVIDENCE_LABELS: Record<AnswerSource['classification'], { label: string; tone: 'positive' | 'caution' | 'neutral' | 'negative' }> = {
  assigned: { label: 'This location', tone: 'positive' },
  sibling: { label: 'Another location', tone: 'caution' },
  ownedUnmapped: { label: 'Unmatched site page', tone: 'caution' },
  external: { label: 'External URL', tone: 'neutral' },
  ambiguous: { label: 'Several locations', tone: 'caution' },
  invalid: { label: 'Invalid URL', tone: 'negative' },
}

/**
 * Why the mention could not be read. The wire carries no reason field because
 * the rule behind it is single: no stored answer text, no mention to read. All
 * that varies is which run lost the text.
 */
/** This Property's own citation is the one the reader is checking, so it leads. */
function sourcesOwnFirst(sources: readonly AnswerSource[]): AnswerSource[] {
  return [...sources].sort((left, right) => (
    Number(right.classification === 'assigned') - Number(left.classification === 'assigned')
  ))
}

function answerKey(row: AnswerRow): string {
  return `${row.expectedSlotId}:${row.usageEdgeId}`
}

/** The one action beside a failed read. `name` says what it reloads, for a reader who hears only the button. */
function RetryButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="outline" className="h-11 px-4 text-sm md:h-11" aria-label={`Retry ${name}`} onClick={onClick}>
      Retry
    </Button>
  )
}

/**
 * The mention signal as three states, never two. A null reads "Not measured"
 * with the reason beside it — reporting it as "not mentioned" would invent a
 * measured miss out of a missing measurement.
 */
function MentionSignal({ row }: { row: AnswerRow }) {
  if (row.mentioned === null) {
    return (
      <span className="inline-flex items-center whitespace-nowrap">
        <ToneBadge tone="neutral">Not measured</ToneBadge>
        <InfoTooltip placement="bottom" text="No mention signal for this location." />
      </span>
    )
  }
  return <ToneBadge tone={row.mentioned ? 'positive' : 'neutral'}>{row.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge>
}

/** An answer whose source list was not fully captured. Shown where its source count would be. */
const SOURCES_PARTIAL = { label: 'Sources partial', detail: 'Sources were not fully captured for this answer.' } as const
/** The same gap with nothing captured at all, so the row and its opened detail say one thing. */
const SOURCES_NOT_SAVED = { label: 'Sources not saved', detail: 'The sources for this answer were not fully captured, so none can be shown.' } as const

/** Why an answer with an unread citation has no source count: some sources were captured, or none. */
function sourcesGap(row: AnswerRow) {
  return row.sources.length === 0 ? SOURCES_NOT_SAVED : SOURCES_PARTIAL
}

/**
 * Citation is three states for the same reason mention is. Null means the
 * sources were never fully captured, so neither "Not cited" nor a source count
 * is a claim this run supports: both report an unseen list as an empty one.
 * The Sources cell beside it says why, in place of a count.
 */
function CitationSignal({ row }: { row: AnswerRow }) {
  if (row.cited === null) return <ToneBadge tone="neutral">Not measured</ToneBadge>
  return <ToneBadge tone={row.cited ? 'positive' : 'neutral'}>{row.cited ? 'Cited' : 'Not cited'}</ToneBadge>
}

function AnswerSources({ row }: { row: AnswerRow }) {
  if (row.cited === null && row.sources.length === 0) {
    return <div className="py-2"><StatusNote icon={AlertTriangle} tone="caution" label={SOURCES_NOT_SAVED.label} detail={SOURCES_NOT_SAVED.detail} /></div>
  }
  if (row.sources.length === 0) {
    return <div className="py-2"><StatusNote icon={Info} label="No sources" detail="This answer returned no source URLs at all." /></div>
  }
  return (
    <details className="mt-2" data-answer-sources>
      <summary className="min-h-11 cursor-pointer py-3 text-sm text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">{ANSWER_SOURCES_LABEL} ({row.sources.length})</summary>
      <div className="overflow-x-auto">
      <table className="evidence-table min-w-[420px]">
        <caption className="sr-only">Source URLs for {row.queryText}</caption>
        <thead><tr><th>Match</th><th>URL</th></tr></thead>
        <tbody>
          {sourcesOwnFirst(row.sources).map(source => (
            <tr key={source.sourceUrl}>
              <td className="whitespace-nowrap">
                <ToneBadge tone={EVIDENCE_LABELS[source.classification].tone}>
                  {EVIDENCE_LABELS[source.classification].label}
                </ToneBadge>
              </td>
              <td><SourceLink url={source.sourceUrl} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </details>
  )
}

/**
 * The answer itself, fetched when a row is opened.
 *
 * The row above it can only ever say whether this Property was named. It cannot
 * say what the engine actually recommended, and that is the thing an operator
 * opens the row to find out: a "not mentioned" row on a local-market query can
 * turn out to be an answer recommending two other properties from the brand.
 * None of that is visible in a signal badge or a source count.
 *
 * Fetched per row rather than with the list because an answer runs to several
 * thousand characters and most rows are never opened. `observationId` is the
 * `resultId` this read takes — both are the stored snapshot id — so no new
 * plumbing is needed to line them up.
 */
/** `headingLevel` is the level of the answer's own top headings: one below the heading the answer is read under. */
function AnswerText({ project, targetKey, resultId, headingLevel }: { project: string; targetKey: string; resultId: string; headingLevel: 4 | 5 }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementQuestionResultOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, resultId, ...LAST_SWEEP },
    }),
  })

  if (query.isPending) {
    return (
      <p className="py-2 text-sm text-secondary" role="status" aria-live="polite">Loading the answer&hellip;</p>
    )
  }
  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-2">
        <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Load failed" detail="This answer did not load." /></span>
        <RetryButton name="answer" onClick={() => { void query.refetch() }} />
      </div>
    )
  }
  const answer = query.data?.answer
  if (answer === null || answer === undefined || answer.trim() === '') {
    // A measured answer with no stored text is not the same as an empty answer,
    // and neither is worth dressing up as one.
    return <div className="py-2"><StatusNote icon={AlertTriangle} tone="caution" label="Text not saved" detail="This answer was measured, but its text was not stored." /></div>
  }
  return (
    <div className="py-2">
      <AnswerMarkdown headingLevel={headingLevel} copyable>{answer}</AnswerMarkdown>
    </div>
  )
}

/**
 * `notInLastSweep` is the reason for a type that has queries now and had none
 * in the sweep on screen (`MeasurementPropertyPage` builds it). It takes the
 * place of "No queries tracked", which is no longer true of that type.
 */
function reasonOf(metric: Extract<MetricValue, { state: 'unavailable' }>, notInLastSweep?: UnavailableReason): UnavailableReason {
  if (notInLastSweep && metric.reason === 'no_population') return notInLastSweep
  return UNAVAILABLE_REASONS[metric.reason] ?? { label: 'Not measured' }
}

/** A type the sweep on screen asked nothing of for this location: neither rate exists, for the one reason. */
function notAsked(row: PropertyRow | undefined): boolean {
  return [row?.mentionCoverage, row?.citationCoverage].every(metric => metric?.state === 'unavailable' && metric.reason === 'no_population')
}

/** A reason's label. One with a sentence behind it is a note, so the sentence is a full-size tap away on a phone. */
function ReasonLabel({ reason }: { reason: UnavailableReason }) {
  return reason.detail ? <StatusNote icon={reason.icon ?? Info} label={reason.label} detail={reason.detail} /> : <>{reason.label}</>
}

/** A section with no rows for a type the last sweep did not ask: still "Not measured", with why beside it. */
function NotInLastSweep({ reason }: { reason: UnavailableReason }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
      <span className="font-medium">Not measured</span>
      <ReasonLabel reason={reason} />
    </div>
  )
}

/**
 * One metric cell. The unavailable branch is deliberately not a number: it says
 * "Not measured" and carries the server's reason, so an unmeasured Property can
 * never be read as a measured zero.
 */
function MetricCell({ metric, signal, emphasis = false, notInLastSweep }: { metric: MetricValue; signal: CoverageSignal; emphasis?: boolean; notInLastSweep?: UnavailableReason }) {
  if (metric.state === 'unavailable') {
    return (
      <span className="inline-flex flex-col gap-0.5">
        {/* On a phone the two figure columns share what the type's name leaves, so the words are a size smaller there and stay on a line. */}
        <span className={emphasis ? 'whitespace-nowrap text-lg font-semibold text-secondary max-md:text-base' : 'text-sm font-medium text-secondary'}>Not measured</span>
        <span className="text-sm text-secondary"><ReasonLabel reason={reasonOf(metric, notInLastSweep)} /></span>
      </span>
    )
  }
  const percent = formatPercent(metric.value)
  const counted = metric.numerator === undefined || metric.denominator === undefined
    ? null
    : `${metric.numerator} of ${metric.denominator}`
  // Answers the server left out of both sides of this rate, named for its own
  // signal: not tied to one property under Mentioned, sources that could not be
  // checked under Cited. The count already excludes them; the caution icon
  // beside it (beside the rate, when there is no count) keeps them a hover,
  // focus or tap away.
  const excluded = excludedAnswersLabel(metric, signal)
  const note = excluded ? <InfoTooltip variant="caution" text={excluded} /> : null
  return (
    <span className="inline-flex flex-col gap-0.5 whitespace-nowrap tabular-nums">
      <span className={emphasis ? 'text-lg font-semibold text-heading' : 'text-sm font-medium text-primary'}>{percent}{counted ? null : note}</span>
      {counted ? <span className="text-xs text-muted">{counted}{note}</span> : null}
    </span>
  )
}

function overviewOptions(projectName: string, targetKey: string, queryClass: QueryClass) {
  return getApiV1ProjectsByNameMeasurementOverviewOptions({
    client: heyClient,
    path: { name: projectName },
    query: { scope: 'property', targetKey, queryClass, ...LAST_SWEEP },
  })
}

function propertyRowOf(overview: MeasurementOverviewResponse | undefined): PropertyRow | undefined {
  return overview?.properties.items.at(0)
}

/**
 * Where these numbers came from — one line, not a card grid.
 *
 * This was four metric cards, and three of them restated a count the section
 * directly below already carried: "Questions assigned 2" sat above a table
 * headed "2 assigned", "Owned URLs 2" above "2 configured", "Answer engines 2"
 * above a two-row engine table. Four cards in a three-column grid also left the
 * fourth stranded on its own row. Cutting the repetition fixes the ragged grid
 * for free and leaves the one fact nothing else on the page states: WHEN.
 *
 * The unmeasured reason rides here rather than in the hero because the hero
 * says "Not measured" per metric; this says it once, for the whole page.
 */
function PropertyProvenance({
  measuredAt,
  unmeasuredReason,
  queryClass,
}: {
  /**
   * Three states, and collapsing any two of them invents a measurement. A run
   * that has not been read yet is not a site that has never been swept, and
   * neither is a class the run did not cover. `undefined` is "not read",
   * `null` is "read, and there has genuinely never been a completed sweep".
   */
  measuredAt: string | null | undefined
  /**
   * The reason the server gave for the class being unmeasured. Absent when the
   * response has not been read at all, in which case the line says nothing
   * rather than guessing which of the two it is.
   */
  unmeasuredReason?: UnavailableReason
  queryClass: QueryClass
}) {
  const when = measuredAt === undefined
    ? null
    : measuredAt === null
      ? NO_COMPLETED_SWEEP
      : `Measured ${formatObservedInstantLabel(observedInstant(measuredAt))}`
  if (when === null && unmeasuredReason === undefined) return null
  // A location never swept gets the same words from both sides: say them once.
  const reason = unmeasuredReason?.label === when ? undefined : unmeasuredReason
  return (
    <p className="supporting-copy">
      {when}
      {when !== null && reason ? ' · ' : ''}
      {reason ? <ReasonLabel reason={reason} /> : null}
      {when !== null && unmeasuredReason === undefined
        ? ` · ${CLASS_LABELS[queryClass]} only`
        : ''}
    </p>
  )
}

/**
 * Competitors belong to a market, not to a building: a single Property has
 * nobody to be compared against. Rather than render an empty competitor card,
 * which would read as missing data, name the market(s) where the comparison
 * actually exists and point at the overview that reports them.
 *
 * The market names are TEXT, not controls. There is no market-scoped route: the
 * overview picks its group from local state (`AdvancedMeasurementOverview`), so
 * every per-market button would have carried the reader to the same unscoped
 * URL and silently dropped the market they chose. One link with one destination
 * is honest; N buttons offering a choice the app cannot act on is not. Making
 * the market selectable from a URL is a routing change, not a label change.
 */
function MarketLink({
  project,
  groups,
}: {
  project: string
  groups: readonly { stableKey: string; label: string; competitors: readonly unknown[] }[]
}) {
  if (groups.length === 0) return null
  return (
    <section aria-labelledby="property-market" className="page-section-divider">
      <div className="section-head section-head-inline flex-wrap">
        <div className="flex items-center gap-1">
          <h3 id="property-market" className="text-base font-semibold text-heading">Competitors by market</h3>
          <InfoTooltip placement="bottom" text="Competitors are set per market, not per location. Their numbers are for this location's markets." />
        </div>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/projects/$projectName" params={{ projectName: project }} search={previous => patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'project' })}>View in AI Visibility</Link>
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {groups.map(group => (
          <li key={group.stableKey} className="rounded-md border border-default px-3 py-1.5 text-sm text-strong">
            {group.label}
            <span className="ml-2 text-xs text-muted">
              {group.competitors.length} {group.competitors.length === 1 ? 'competitor' : 'competitors'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The four coverage numbers as a scannable hero, in the same visual language as
 * the project overview's AEO hero (`aeo-hero-row`), so a Property reads like a
 * smaller version of the project rather than a different kind of page.
 *
 * Non-brand leads because it is the demand a Property has to earn; branded
 * follows as the control. That ordering is the argument the page exists to make.
 *
 * Bars are deliberately `progress-fill-neutral`. `MetricValue` carries no tone,
 * and a coverage rate has no product-defined "good" threshold: 20% non-brand may
 * be strong in a dense market and weak in a thin one. Coloring the bar would be
 * a verdict the API never issued and a value derived in the UI, which the parity
 * rule forbids. The bar encodes magnitude; the reader supplies the judgment.
 *
 * An unavailable metric renders NO bar rather than a zero-width one. An empty
 * track beside "Not measured" reads as a measured zero, which is the one thing
 * this surface must never say.
 */
function CoverageHeroRow({ label, metric, signal, failed = false, notInLastSweep, saidAbove = false }: {
  label: string
  metric: MetricValue | undefined
  signal: CoverageSignal
  failed?: boolean
  notInLastSweep?: UnavailableReason
  /** The row above gave `notInLastSweep` for the same type. It is a note with a tab stop: once per type is enough. */
  saidAbove?: boolean
}) {
  if (metric === undefined) {
    // A class whose fetch failed also has no metric, and reporting that as
    // "Loading" is a spinner that never resolves: the retry lives in
    // `BrandContrast` below, so the reader is waiting on something that already
    // stopped. `failed` separates the two so the lead element of the page and
    // the alert beneath it stop disagreeing about the same class.
    return (
      <div className="aeo-hero-row">
        <p className="aeo-hero-row-label">{label}</p>
        <p className="aeo-hero-row-value text-base font-semibold text-secondary">{failed ? 'Unavailable' : '…'}</p>
        {failed ? <div /> : <div className="aeo-hero-row-bar" aria-hidden="true" />}
        <p className="aeo-hero-row-detail">{failed ? 'Load failed' : 'Loading'}</p>
      </div>
    )
  }
  if (metric.state === 'unavailable') {
    // `reasonOf` falls back to "Not measured" for a reason this build does not
    // know, which would print the same words twice across two columns and read
    // as a rendering fault. Drop the detail when it says nothing the value did
    // not already say.
    const reason = reasonOf(metric, notInLastSweep)
    return (
      <div className="aeo-hero-row">
        <p className="aeo-hero-row-label">{label}</p>
        <p className="aeo-hero-row-value whitespace-nowrap text-base font-semibold text-secondary">Not measured</p>
        <div />
        <p className="aeo-hero-row-detail">{reason.label === 'Not measured' || (saidAbove && reason === notInLastSweep) ? '' : <ReasonLabel reason={reason} />}</p>
      </div>
    )
  }
  // The hero sets the percent sign apart from the figure, as the Simple overview
  // hero does; both halves are the shared format's own output.
  const { figure, sign } = splitPercentSign(formatPercent(metric.value))
  const counted = metric.numerator === undefined || metric.denominator === undefined
    ? null
    : `${metric.numerator} of ${metric.denominator}`
  const excluded = excludedAnswersLabel(metric, signal)
  return (
    <div className="aeo-hero-row">
      <p className="aeo-hero-row-label">{label}</p>
      <p className="aeo-hero-row-value text-heading">{figure}{sign ? <span className="text-faint">{sign}</span> : null}</p>
      <div className="aeo-hero-row-bar" aria-hidden="true">
        <div className="metric-card-bar-fill progress-fill-neutral" style={{ width: `${metric.value * 100}%` }} />
      </div>
      <p className="aeo-hero-row-detail tabular-nums">
        {counted ?? ''}
        {excluded ? <InfoTooltip variant="caution" text={excluded} /> : null}
      </p>
    </div>
  )
}

function CoverageHero({
  branded,
  nonBrand,
  brandedFailed = false,
  nonBrandFailed = false,
  notInLastSweep,
}: {
  branded: PropertyRow | undefined
  nonBrand: PropertyRow | undefined
  brandedFailed?: boolean
  nonBrandFailed?: boolean
  notInLastSweep: (queryClass: QueryClass) => UnavailableReason | undefined
}) {
  return (
    <section aria-labelledby="property-coverage-hero">
      <h2 id="property-coverage-hero" className="sr-only">Coverage for this location</h2>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-secondary">{CLASS_LABELS['non-brand']}</p>
          <CoverageHeroRow label="Mentioned" metric={nonBrand?.mentionCoverage} signal="mentioned" failed={nonBrandFailed} notInLastSweep={notInLastSweep('non-brand')} />
          <CoverageHeroRow label="Cited" metric={nonBrand?.citationCoverage} signal="cited" failed={nonBrandFailed} notInLastSweep={notInLastSweep('non-brand')} saidAbove={notAsked(nonBrand)} />
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-secondary">{CLASS_LABELS.branded}</p>
          <CoverageHeroRow label="Mentioned" metric={branded?.mentionCoverage} signal="mentioned" failed={brandedFailed} notInLastSweep={notInLastSweep('branded')} />
          <CoverageHeroRow label="Cited" metric={branded?.citationCoverage} signal="cited" failed={brandedFailed} notInLastSweep={notInLastSweep('branded')} saidAbove={notAsked(branded)} />
        </div>
      </div>
    </section>
  )
}

/**
 * A type whose numbers did not load, with the retry for that read. The type
 * table announces it; the sections below that read the same numbers repeat it
 * quietly, so one failure is one alert.
 */
function ClassLoadFailed({ queryClass, onRetry, announce = false }: { queryClass: QueryClass; onRetry: () => void; announce?: boolean }) {
  const note = <StatusNote icon={AlertTriangle} tone="negative" label="Load failed" detail={`${CLASS_LABELS[queryClass]} queries did not load.`} />
  return (
    <div className="flex flex-wrap items-center gap-3">
      {announce ? <span role="alert">{note}</span> : note}
      <RetryButton name={classQueries(queryClass)} onClick={onRetry} />
    </div>
  )
}

/**
 * The comparison the product is an argument about: the same Property, measured
 * against the queries that name it and the queries that do not.
 */
function BrandContrast({
  branded,
  nonBrand,
  brandedError,
  nonBrandError,
  onRetry,
  notInLastSweep,
}: {
  branded: PropertyRow | undefined
  nonBrand: PropertyRow | undefined
  brandedError: boolean
  nonBrandError: boolean
  onRetry: (queryClass: QueryClass) => void
  notInLastSweep: (queryClass: QueryClass) => UnavailableReason | undefined
}) {
  const rows: Array<{ queryClass: QueryClass; row: PropertyRow | undefined; isError: boolean }> = [
    { queryClass: 'branded', row: branded, isError: brandedError },
    { queryClass: 'non-brand', row: nonBrand, isError: nonBrandError },
  ]
  return (
    <section aria-labelledby="property-brand-contrast">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h3 id="property-brand-contrast" className="text-base font-semibold text-heading">By type</h3>
          <InfoTooltip placement="bottom" text="Each row counts only this location's queries of that type. A type with no query reads Not measured, not 0%." />
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-default">
        <table className="evidence-table max-md:[&_td]:px-2 max-md:[&_th]:px-2 md:min-w-[560px]">
          <caption className="sr-only">Mention and citation coverage for this location, by query type</caption>
          <thead>
            <tr>
              <th>Type</th>
              <th>Mentioned</th>
              <th>Cited</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ queryClass, row, isError }) => (
              <tr key={queryClass}>
                <td>
                  <span className="block whitespace-nowrap font-medium text-heading">{CLASS_LABELS[queryClass]}</span>
                  {row && isError ? (
                    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span role="status"><StatusNote icon={AlertTriangle} tone="caution" label="Refresh failed" detail="The latest numbers did not load. These are the last ones read." /></span>
                      <RetryButton name={classQueries(queryClass)} onClick={() => onRetry(queryClass)} />
                    </span>
                  ) : isError ? (
                    // Under the type's name: on a phone the two figure columns start past the edge of the table's frame.
                    <div className="mt-2"><ClassLoadFailed queryClass={queryClass} onRetry={() => onRetry(queryClass)} announce /></div>
                  ) : null}
                </td>
                {row && notAsked(row) && notInLastSweep(queryClass) ? (
                  // One reason for both figures, said once across their two columns.
                  <td colSpan={2}><MetricCell metric={row.mentionCoverage} signal="mentioned" emphasis notInLastSweep={notInLastSweep(queryClass)} /></td>
                ) : row ? (
                  <>
                    <td><MetricCell metric={row.mentionCoverage} signal="mentioned" emphasis notInLastSweep={notInLastSweep(queryClass)} /></td>
                    <td><MetricCell metric={row.citationCoverage} signal="cited" emphasis notInLastSweep={notInLastSweep(queryClass)} /></td>
                  </>
                ) : isError ? (
                  <td colSpan={2}><span className="text-sm text-secondary">Unavailable</span></td>
                ) : (
                  <>
                    <td><span className="text-sm text-secondary">Loading…</span></td>
                    <td><span className="text-sm text-secondary">Loading…</span></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ProviderBreakdown({ row, queryClass, isError, onRetry, notInLastSweep }: { row: PropertyRow | undefined; queryClass: QueryClass; isError: boolean; onRetry: () => void; notInLastSweep: UnavailableReason | undefined }) {
  return (
    <section aria-labelledby="property-providers" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h3 id="property-providers" className="text-base font-semibold text-heading">By engine</h3>
          <InfoTooltip placement="bottom" text="Each row covers the queries that engine answered for this location. Rows do not add up to the location total. An engine with no answer is not listed." />
        </div>
      </div>
      {row === undefined && isError ? (
        <ClassLoadFailed queryClass={queryClass} onRetry={onRetry} />
      ) : row === undefined ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : row.providers.length === 0 && notInLastSweep ? (
        <NotInLastSweep reason={notInLastSweep} />
      ) : row.providers.length === 0 ? (
        <StatusNote
          icon={Clock}
          label="Not measured"
          detail={`No answer engine has measured ${classQueries(queryClass)} for this location.${row.mentionCoverage.state === 'unavailable' ? ` ${reasonOf(row.mentionCoverage).detail ?? `${reasonOf(row.mentionCoverage).label}.`}` : ''}`}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table max-md:[&_td]:px-2 max-md:[&_th]:px-2 md:min-w-[520px]">
            <caption className="sr-only">Per-engine mention and citation coverage</caption>
            <thead><tr><th>Engine</th><th>Mentioned</th><th>Cited</th></tr></thead>
            <tbody>
              {row.providers.map(provider => (
                <tr key={provider.provider}>
                  <td className="font-medium text-heading">{providerDisplayName(provider.provider)}</td>
                  <td><MetricCell metric={provider.mentionCoverage} signal="mentioned" /></td>
                  <td><MetricCell metric={provider.citationCoverage} signal="cited" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * The full query list behind the count in the "Mentioned instead" table's Queries
 * cell. Kept behind an `InfoTooltip` rather than inline: this page is already
 * scoped to one Property and one query class, so the same one or two queries
 * repeat down nearly every row — the joined text is the widest column in the
 * table and carries almost no information once you have read it twice. The
 * count is the signal that survives (one rival named across more queries than
 * another); the text itself stays reachable here, not deleted.
 */
function competitorQueriesTooltipText(row: {
  questions: readonly string[]
  questionsTruncated: boolean
  questionTotal: number
}): string {
  const shown = row.questions.join(' · ')
  return row.questionsTruncated ? `${shown} +${row.questionTotal - row.questions.length} more` : shown
}

/**
 * Who the engines named when they did not name this Property.
 *
 * This is the answer to the question the coverage numbers raise and cannot
 * settle: a Property at 0% tells you there is a gap, not what is in it. The
 * evidence table below can only show that an answer happened; this says who won
 * it. On a real Property, four answers that never mentioned it named nine
 * different rival buildings, five of which had their own sites cited.
 *
 * Server-ranked and Property-scoped. Doing this in the browser would mean
 * counting names across answers here, which the parity rule forbids and which
 * would also lose the `basis` — the count of answers this Property actually
 * missed, without which the occurrence numbers have no denominator.
 */
function NamedInstead({ project, targetKey, queryClass, notInLastSweep }: { project: string; targetKey: string; queryClass: QueryClass; notInLastSweep: UnavailableReason | undefined }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementPropertyCompetitorsOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, queryClass, ...LAST_SWEEP },
    }),
  })

  // Nothing to say yet, and a heading over a spinner is noise on a page that
  // already has four sections. The section appears when it has something.
  if (query.isPending) return null
  const failed = query.isError && query.data === undefined
  const competitors = query.data?.competitors ?? []
  const basis = query.data?.basis

  return (
    <section aria-labelledby="property-named-instead" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h3 id="property-named-instead" className="text-base font-semibold text-heading">Mentioned instead</h3>
          <InfoTooltip placement="bottom" text="Names from the answers that did not mention this location. A name counts once per answer." />
        </div>
        {competitors.length > 0 ? <p className="supporting-copy">{query.data?.total ?? competitors.length} names</p> : null}
      </div>
      {failed ? (
        <div className="flex flex-wrap items-center gap-3">
          <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Load failed" detail="The names given instead did not load." /></span>
          <RetryButton name="mentioned instead" onClick={() => { void query.refetch() }} />
        </div>
      ) : basis?.state === 'unavailable' && basis.reason === 'no_population' && notInLastSweep ? (
        <NotInLastSweep reason={notInLastSweep} />
      ) : basis?.state === 'unavailable' ? (
        // No answer was read for this type. "None mentioned" would report that as a sweep in which no other name was mentioned.
        <StatusNote
          icon={Clock}
          label="Not measured"
          detail={`No answers to ${classQueries(queryClass)} have been measured for this location. ${reasonOf(basis).detail ?? `${reasonOf(basis).label}.`}`}
        />
      ) : competitors.length === 0 ? (
        <StatusNote icon={Info} label="None mentioned" detail="No other name was mentioned in the answers this location missed." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-default">
            <table className="evidence-table max-md:[&_td]:px-2 max-md:[&_th]:px-2 md:min-w-[420px]">
              <caption className="sr-only">Names mentioned instead of this location</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Answers</th>
                  <th>Engines</th>
                  <th>Queries</th>
                </tr>
              </thead>
              <tbody>
                {competitors.map(row => (
                  <tr key={row.name}>
                    <td className="text-strong">{row.name}</td>
                    <td className="tabular-nums text-secondary">{row.occurrences}</td>
                    <td className="text-secondary">
                      {row.providers.map(providerDisplayName).join(', ')}
                      {row.providersTruncated ? ` +${row.providerTotal - row.providers.length}` : ''}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        <span className="tabular-nums text-secondary">{row.questionTotal}</span>
                        <InfoTooltip placement="bottom" text={competitorQueriesTooltipText(row)} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {basis?.state === 'available' ? (
            <div className="mt-2 flex items-center text-sm">
              <dl className="flex gap-2">
                <dt className="text-secondary">Missed answers</dt>
                {/* The type travels with the figure, as it does on the count under Cited on other queries. */}
                <dd className="tabular-nums text-heading">{basis.targetMissResults} of {basis.answeredResults} <span className="text-secondary">&middot; {CLASS_LABELS[queryClass]}</span></dd>
              </dl>
              <InfoTooltip placement="bottom" text={`Answers to ${classQueries(queryClass)} that did not mention this location.`} />
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

export const OTHER_QUERIES_COPY = {
  heading: 'Cited on other queries',
  help: 'Answers to queries tracked for other locations that still cited one of this location\u2019s own pages.',
  notCounted: 'Not in rates',
  notCountedHelp: 'This location was not measured on those queries, so these answers are not in its Mentioned or Cited rates.',
  empty: 'None',
  emptyHelp: 'No answer to a query tracked for another location cited this location\u2019s pages in this sweep.',
  loadError: 'Load failed',
  loadErrorHelp: 'Citations from other queries did not load.',
  partlySaved: SOURCES_PARTIAL.label,
} as const

/**
 * Citations of this Property's own pages from answers to queries it is not
 * assigned, read from `shape=other-queries` for the displayed run and class.
 *
 * Kept out of every number above by construction: the rates read only this
 * Property's own assignments. The answer itself is read through the Property
 * the query IS assigned to, since an answer belongs to the queries that asked it.
 */
function CitedOnOtherQueries({
  project,
  targetKey,
  queryClass,
  runId,
  targetLabels,
  notInLastSweep,
}: {
  project: string
  targetKey: string
  queryClass: QueryClass
  runId: string | undefined
  targetLabels: ReadonlyMap<string, string>
  /** Set when the sweep on screen did not hold this location. Its pages were then never looked for, so no row is not "None". */
  notInLastSweep: UnavailableReason | undefined
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>())
  const input = {
    client: heyClient,
    path: { name: project },
    query: {
      targetKey,
      queryClass,
      shape: MeasurementEvidenceShapes['other-queries'],
      limit: EVIDENCE_PAGE_SIZE,
      ...(runId ? { runId } : {}),
      ...LAST_SWEEP,
    },
  } as const
  const query = useInfiniteQuery({
    ...getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteOptions(input),
    initialPageParam: input,
    getNextPageParam: (lastPage: MeasurementPropertyEvidenceResponse) => (
      lastPage.otherQueries?.nextCursor
        ? { path: input.path, query: { ...input.query, cursor: lastPage.otherQueries.nextCursor } }
        : undefined
    ),
  })
  const pages = query.data?.pages ?? []
  // A measurement that has not happened has no other-query citations to list,
  // and the answers section already says so.
  if (pages[0]?.measurement.state === 'not_measured') return null
  const rows = pages.flatMap(page => page.otherQueries?.items ?? [])
  const total = pages[0]?.otherQueries?.totalEstimate ?? rows.length
  const rowKey = (row: OtherQueryRow) => `${row.expectedSlotId}:${row.queryClass}`
  const unchecked = rows.length === 0 ? notInLastSweep : undefined

  return (
    <section aria-labelledby="property-other-queries" className="page-section-divider">
      <div className="section-head section-head-inline flex-wrap">
        <div className="flex items-center gap-1">
          <h3 id="property-other-queries" className="text-base font-semibold text-heading">{OTHER_QUERIES_COPY.heading}</h3>
          <InfoTooltip placement="bottom" text={OTHER_QUERIES_COPY.help} />
        </div>
        {query.data && !unchecked ? (
          <div className="flex flex-wrap items-center gap-x-3">
            <p className="supporting-copy">{total} {total === 1 ? 'answer' : 'answers'} &middot; {CLASS_LABELS[queryClass]}</p>
            {/* With no row there is nothing for the note to qualify. */}
            {rows.length > 0 ? <StatusNote icon={Info} label={OTHER_QUERIES_COPY.notCounted} detail={OTHER_QUERIES_COPY.notCountedHelp} /> : null}
          </div>
        ) : null}
      </div>
      {query.isPending ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : query.isError && rows.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={OTHER_QUERIES_COPY.loadError} detail={OTHER_QUERIES_COPY.loadErrorHelp} /></span>
          <RetryButton name="other queries" onClick={() => { void query.refetch() }} />
        </div>
      ) : unchecked ? (
        <NotInLastSweep reason={unchecked} />
      ) : rows.length === 0 ? (
        <StatusNote icon={Info} label={OTHER_QUERIES_COPY.empty} detail={OTHER_QUERIES_COPY.emptyHelp} />
      ) : (
        <>
          {/* Positioned, so the screen-reader-only header cell is clipped with the table instead of widening the page. */}
          <div className="relative overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[640px]">
              <caption className="sr-only">Answers to other locations&rsquo; queries that cited this location&rsquo;s pages</caption>
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Location</th>
                  <th>Pages cited</th>
                  <th><span className="sr-only">Answer</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const key = rowKey(row)
                  const open = expanded.has(key)
                  const detailId = `property-other-query-${encodeURIComponent(key)}`
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td className="text-secondary">
                          <span className="block text-sm font-medium text-heading">{row.queryText}</span>
                          <span className="mt-1 block text-xs text-muted">{[providerDisplayName(row.provider), row.location].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td>
                          <ul className="space-y-1">
                            {row.assignedTargetKeys.map(key => (
                              <li key={key}>
                                {targetLabels.has(key) ? (
                                  <Link
                                    to="/projects/$projectName/properties/$targetKey"
                                    params={{ projectName: project, targetKey: key }}
                                    search={carryVisibilitySearch}
                                    className="text-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                                  >
                                    {targetLabels.get(key)}
                                  </Link>
                                ) : (
                                  // The last sweep can name a location the published setup has dropped. It has no page to open, and its key is no name.
                                  <span className="text-sm text-secondary">Removed location</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td>
                          <ul className="space-y-1">
                            {row.sources.map(source => <li key={source.sourceUrl} className="min-w-0"><SourceLink url={source.sourceUrl} /></li>)}
                          </ul>
                          {row.sourcesTruncated ? <span className="mt-1 block text-xs text-muted">{row.sourceCount} pages in total</span> : null}
                          {row.evidenceComplete ? null : <span className="mt-1 block"><StatusNote icon={AlertTriangle} tone="caution" label={OTHER_QUERIES_COPY.partlySaved} detail={SOURCES_PARTIAL.detail} /></span>}
                        </td>
                        <td className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left md:h-auto md:whitespace-nowrap"
                            aria-expanded={open}
                            aria-label={open ? `Hide the answer for ${row.queryText}` : `View the answer for ${row.queryText}`}
                            aria-controls={open ? detailId : undefined}
                            onClick={() => setExpanded(current => {
                              const next = new Set(current)
                              if (!next.delete(key)) next.add(key)
                              return next
                            })}
                          >
                            {open ? 'Hide answer' : 'View answer'}
                          </Button>
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td id={detailId} colSpan={4} className="bg-surface-subtle px-4">
                            <AnswerText project={project} targetKey={row.assignedTargetKeys[0]!} resultId={row.observationId} headingLevel={4} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {query.hasNextPage ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
              <span>Showing {rows.length} of {total}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-11 px-4 text-sm md:h-11"
                disabled={query.isFetchingNextPage}
                onClick={() => { void query.fetchNextPage() }}
              >
                {query.isFetchingNextPage ? 'Loading…' : `Show ${EVIDENCE_PAGE_SIZE} more`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * The AI Visibility filters this page cannot apply: its reads take no market,
 * engine, model, location, date range, or saved sweep. Null when none is carried.
 */
function carriedFilterHelp(selection: VisibilitySelectionState, marketLabel: string | undefined): string | null {
  const filters = [
    selection.marketKey ? marketLabel ?? 'the selected market' : null,
    selection.provider ? `the ${providerDisplayName(selection.provider)} answer engine` : null,
    selection.model ? `the ${selection.model} model` : null,
    selection.location ? `search location ${selection.location}` : null,
    selection.from || selection.to ? 'a date range' : null,
    selection.measurementRunId ? 'a saved sweep' : null,
  ].filter((filter): filter is string => filter !== null)
  if (filters.length === 0) return null
  return `AI Visibility is filtered to ${filters.join(', ')}. This page shows the latest measurement for ${MARKET_SCOPE_COPY.allMarkets.toLocaleLowerCase()} and answer engines.`
}

export function MeasurementPropertyPage() {
  const { projectName, targetKey } = useParams({ strict: false }) as { projectName?: string; targetKey?: string }
  const navigate = useNavigate()
  const canGoBack = useInAppBack()
  // Query type and filters arrive in AI Visibility's shared URL selection.
  const urlSearch = useSearch({ strict: false }) as Record<string, unknown>
  const selection = useMemo(() => parseVisibilitySelection(urlSearch), [urlSearch])
  const [expandedAnswers, setExpandedAnswers] = useState<ReadonlySet<string>>(new Set<string>())
  const project = projectName ?? ''
  const property = targetKey ?? ''
  const hasRouteParams = Boolean(project) && Boolean(property)
  // Property detail is Advanced portfolio content, so the `portfolio` token
  // governs it, read through the same effective allowlist as the project subnav.
  // That allowlist never admits `portfolio`, so no embed renders this page or
  // fires its reads. ProjectPage agrees: embedded, it skips the plan read and
  // renders no Property links. Presentational only; the API key scope governs data.
  const embedAllowsProperty = useMemo(() => isEmbedProjectTabAllowed('portfolio', effectiveEmbedProjectTabs(getEmbedConfig())), [])
  const enabled = hasRouteParams && embedAllowsProperty
  const { canWrite } = useAccount()

  const planQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPlanOptions({ client: heyClient, path: { name: project } }),
    enabled,
  })
  // Mirror the report's clean-URL normalization. This page has only branded and
  // non-brand, so an unset or unclassified URL opens on the first class this
  // Property is assigned and records it, keeping both surfaces on one class.
  const activePlanForClass = planQuery.data?.active?.plan
  const assignedPlan = activePlanForClass?.schemaVersion === 2 ? activePlanForClass as PlanV2 : null
  const urlQueryClass = selection.queryClass === 'branded' || selection.queryClass === 'non-brand' ? selection.queryClass : null
  const isAssigned = (candidate: QueryClass) => assignedPlan?.assignments.some(assignment => assignment.targetKey === property && assignment.queryClass === candidate) ?? false
  const queryClass: QueryClass = urlQueryClass ?? (!isAssigned('non-brand') && isAssigned('branded') ? 'branded' : 'non-brand')
  useEffect(() => {
    if (!assignedPlan || urlQueryClass) return
    void navigate({ to: '.', replace: true, search: previous => patchVisibilitySelection(previous, { queryClass }) })
  }, [assignedPlan, urlQueryClass, queryClass, navigate])
  const showQueryClass = (next: QueryClass) => {
    // Replaces the entry, so one press of Back leaves the page whatever types were looked at.
    void navigate({ to: '.', replace: true, search: previous => patchVisibilitySelection(previous, { queryClass: next }) })
  }
  const brandedQuery = useQuery({ ...overviewOptions(project, property, 'branded'), enabled })
  const nonBrandQuery = useQuery({ ...overviewOptions(project, property, 'non-brand'), enabled })

  const brandedRow = propertyRowOf(brandedQuery.data)
  const nonBrandRow = propertyRowOf(nonBrandQuery.data)
  const selected = queryClass === 'branded' ? brandedQuery.data : nonBrandQuery.data
  const selectedRow = queryClass === 'branded' ? brandedRow : nonBrandRow
  const selectedClassError = queryClass === 'branded' ? brandedQuery.isError : nonBrandQuery.isError
  const selectedClassUnavailable = selectedClassError && selectedRow === undefined
  const displayedRunId = selected?.measurement.displayedRunId
  usePublishAeroView(project, { view: 'property', selection: { mode: 'advanced', scope: 'property', scopeKey: property, queryClass, limit: 10, ...(displayedRunId ? { runId: displayedRunId } : {}) } })

  // After a tracking change the reads answer with the last sweep, which ran with the setup before the
  // change: every figure below is that sweep's, and the header says so once. A location no sweep has
  // measured has no measured setup, and reads "Not measured" as before. Both types' reads say which
  // sweep it is, so the note and the reason below stand while either has loaded.
  const sweep = (selected ?? brandedQuery.data ?? nonBrandQuery.data)?.measurement
  const showsLastSweep = sweep?.awaitingSweep === true && typeof sweep.measuredRevision === 'number'
  const sweptOn = sweep?.completedAt ? formatObservedInstantMonthDay(observedInstant(sweep.completedAt)) : null
  // A type with queries for this location now and none in that sweep has no number yet. "No queries
  // tracked" would be false of it, so its reason names the sweep. Each type is judged on its own.
  const notInLastSweep = (candidate: QueryClass): UnavailableReason | undefined => showsLastSweep && isAssigned(candidate)
    ? { icon: Clock, label: 'Not in last sweep', detail: `No queries of this type were asked for this location in the ${sweptOn ?? 'last'} sweep. First numbers after the next sweep.` }
    : undefined
  const selectedNotInLastSweep = notInLastSweep(queryClass)
  // Set when the selected type's own numbers are missing for that reason. By engine and Answers read
  // it: an empty engine list and an empty page of answers carry no reason of their own.
  const selectedTypeGap = selectedRow?.mentionCoverage.state === 'unavailable' && selectedRow.mentionCoverage.reason === 'no_population'
    ? selectedNotInLastSweep
    : undefined
  // Set when that sweep has no number of either type for a location the setup now asks queries: it did
  // not hold the location. The sweep's own state would then read "Measured" over a page of "Not
  // measured", and an empty list under Cited on other queries would read as a sweep that found none.
  // It takes both types' reads to say so: a type still being read, or one whose read failed, may hold numbers.
  const mayBeOutOfLastSweep = showsLastSweep
    && [brandedRow, nonBrandRow].every(row => row === undefined || notAsked(row))
    && (isAssigned('branded') || isAssigned('non-brand'))
  const bothTypesRead = brandedRow !== undefined && nonBrandRow !== undefined
  const locationNotInLastSweep: UnavailableReason | undefined = mayBeOutOfLastSweep && bothTypesRead
    ? { icon: Clock, label: 'Not in last sweep', detail: `This location was not in the ${sweptOn ?? 'last'} sweep. First numbers after the next sweep.` }
    : undefined
  // The state is the sweep's, or "Not measured" for a location it did not hold. Until both types are
  // read that is not known, and the header shows no state it may have to take back.
  const headerState = !selected || (mayBeOutOfLastSweep && !bothTypesRead)
    ? null
    : MEASUREMENT_STATES[locationNotInLastSweep ? 'not_measured' : selected.measurement.state]

  // The engine COUNT is gone from this page: the engine table below states it by
  // listing one row per engine, and a card above restating it was one of the
  // three that made the facts grid repeat its own page. What survives is the
  // reason a class has no numbers at all, which nothing else says once.
  const engineUnmeasuredReason = selectedRow?.mentionCoverage.state === 'unavailable'
    ? reasonOf(selectedRow.mentionCoverage, selectedNotInLastSweep)
    : undefined
  // Undefined while the response is unread, so a pending or failed fetch never
  // asserts this Property has never been swept. A type that sweep did not ask
  // was not measured on its day either: its reason stands alone, with the day in its help.
  const measuredAt = selected === undefined || selectedTypeGap ? undefined : selected.measurement.completedAt ?? null
  // Only a location no sweep has measured. One measured before a tracking change keeps its numbers.
  const needsMeasurement = selected?.measurement.state === 'not_measured'
  // While an overview is being read the header may still claim the page's one "Tracking changed" note,
  // so the tracked section holds its own back: the note never moves from one to the other.
  const overviewsLoading = brandedQuery.isFetching || nonBrandQuery.isFetching

  const evidenceInput = {
    client: heyClient,
    path: { name: project },
    query: {
      targetKey: property,
      queryClass,
      shape: MeasurementEvidenceShapes.answers,
      limit: EVIDENCE_PAGE_SIZE,
      ...(displayedRunId ? { runId: displayedRunId } : {}),
      ...LAST_SWEEP,
    },
  } as const
  const evidenceQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteOptions(evidenceInput),
    enabled: enabled && selected !== undefined,
    initialPageParam: evidenceInput,
    getNextPageParam: (lastPage: MeasurementPropertyEvidenceResponse) => (
      lastPage.answers?.nextCursor
        ? { path: evidenceInput.path, query: { ...evidenceInput.query, cursor: lastPage.answers.nextCursor } }
        : undefined
    ),
  })

  const activePlan = planQuery.data?.active ?? null
  const planV2 = activePlan?.plan.schemaVersion === 2 ? activePlan.plan as PlanV2 : null
  const legacyPlan = activePlan !== null && planV2 === null
  const target = planV2?.targets.find(candidate => candidate.stableKey === property) ?? null
  const filterHelp = carriedFilterHelp(selection, planV2?.reportingScopes?.find(scope => scope.stableKey === selection.marketKey)?.label)

  const targetLabels = useMemo(
    () => new Map((planV2?.targets ?? []).map(candidate => [candidate.stableKey, candidate.label])),
    [planV2],
  )
  // Every market this Property belongs to. Membership is a plain lookup rather
  // than a field on the target: a Property can sit in several markets, and the
  // plan stores the relation on the group.
  const memberGroups = useMemo(
    () => planV2?.groups.filter(group => group.targetKeys.includes(property)) ?? [],
    [planV2, property],
  )
  const evidenceRows = useMemo(
    () => {
      // A page that carries no `answers` key is a response in the source shape,
      // not a Property with no answers. Collapsing it to [] reported an older
      // server's data as a measured absence.
      const pages = evidenceQuery.data?.pages ?? []
      const loaded = pages.flatMap(page => page.answers?.items ?? [])
      // Array sort is stable, so answers of equal rank keep the server's
      // (slot, edge) order and a re-render can never shuffle the panel.
      // Server order, deliberately. Ranking losses first client-side ranked only
      // the rows FETCHED so far, so a loss on page two arrived via "Show more"
      // and jumped above rows the operator was already reading. Ranking the whole
      // result set belongs on the server, which this change does not do.
      return loaded
    },
    [evidenceQuery.data],
  )
  const evidenceTotal = evidenceQuery.data?.pages[0]?.answers?.totalEstimate ?? evidenceRows.length
  // A response with no `answers` key came back in the source shape. That is a
  // server that predates this view, not a Property with nothing to show.
  const evidenceShapeMismatch = (evidenceQuery.data?.pages ?? []).length > 0
    && (evidenceQuery.data?.pages ?? []).every(page => page.answers === undefined)
  const evidenceState = evidenceQuery.data?.pages[0]?.measurement.state

  // "Back" with in-app history: to Queries, Settings or AI Visibility, whichever the reader came from. A direct
  // open has nowhere to go back to, so it links to AI Visibility by name.
  const backLink = (
    <BackLink
      canGoBack={canGoBack}
      className={BACK_LINK}
      iconClassName="size-3.5"
      fallback={link => (
        <Link to="/projects/$projectName" params={{ projectName: project }} search={carryVisibilitySearch} className={link.className}>
          {link.icon}
          AI Visibility
        </Link>
      )}
    />
  )

  if (!hasRouteParams) {
    return (
      <div className="page-container space-y-3">
        {project ? backLink : null}
        <StatusNote icon={AlertTriangle} label="Location not found" />
      </div>
    )
  }

  // A child route the subnav never renders, so a direct link is the only way in.
  if (!embedAllowsProperty) {
    return (
      <div className="page-container space-y-3">
        {backLink}
        <p className="text-sm text-muted">This view is not available here.</p>
      </div>
    )
  }

  if (planQuery.isPending && !planQuery.isError) {
    return (
      <div className="page-container">
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading location</span>
          <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
        </div>
      </div>
    )
  }

  const retryClass = (classToRetry: QueryClass) => {
    void (classToRetry === 'branded' ? brandedQuery.refetch() : nonBrandQuery.refetch())
  }
  const retrySelectedClass = () => retryClass(queryClass)

  const planUnavailable = planQuery.isError && planQuery.data === undefined
  const brandedUnavailable = brandedQuery.isError && brandedQuery.data === undefined
  const nonBrandUnavailable = nonBrandQuery.isError && nonBrandQuery.data === undefined
  if (planUnavailable || (brandedUnavailable && nonBrandUnavailable)) {
    return (
      <div className="page-container space-y-3">
        {backLink}
        <div className="flex flex-wrap items-center gap-3">
          <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Could not load" detail="This location did not load." /></span>
          <RetryButton
            name="location"
            onClick={() => {
              void planQuery.refetch()
              void brandedQuery.refetch()
              void nonBrandQuery.refetch()
            }}
          />
        </div>
      </div>
    )
  }

  const setupLink = (label: string) => (
    <Button asChild type="button" variant="outline" className="h-11 px-4 text-sm md:h-11">
      <Link to="/projects/$projectName/portfolio" params={{ projectName: project }}>{label}</Link>
    </Button>
  )

  if (!planV2 || !target) {
    return (
      <div className="page-container space-y-3">
        {backLink}
        <div className="flex flex-wrap items-center gap-3">
          <span role="status">
            <StatusNote
              icon={AlertTriangle}
              tone="caution"
              label={planV2 ? 'Location not found' : 'Setup not published'}
              detail={planV2
                ? 'This location is not in the published setup. It may have been renamed or removed.'
                : 'A location page needs a published setup.'}
            />
          </span>
          {setupLink(canWrite ? (legacyPlan ? 'Republish setup' : 'Open Bulk setup') : 'View Bulk setup')}
        </div>
      </div>
    )
  }

  return (
    <div className="page-container space-y-8">
      {/* From sm the name takes the room the badges and the button leave. In a frame too narrow for both they go under it. */}
      <div className="page-header @container sm:flex-wrap">
        <div className="page-header-left sm:flex-1 sm:basis-80">
          {backLink}
          {/* The badge is a sibling of the heading, so the page is named by the location alone. Both are inline:
              a name that wraps keeps the badge on its last line, raised to the middle of the name's capitals. */}
          <div className="mt-2">
            <h1 className="page-title inline">{target.label}</h1>
            <ToneBadge tone="neutral" className="relative -top-0.5 ml-2.5 align-middle">Location</ToneBadge>
          </div>
          {/* The header's width from sm, not the name's column: the line runs on under the badges and the button, which end above it. */}
          <div className="page-subtitle flex min-h-5 flex-wrap items-center gap-x-4 gap-y-0.5 sm:w-[100cqw]">
            <LocationPlaces projectName={project} targetKey={property} />
            {filterHelp ? (
              <span className="inline-flex items-center">
                Filters not applied
                <InfoTooltip placement="bottom" text={filterHelp} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="page-header-right flex-wrap">
          {/* The statuses wrap as one group, so on a phone the button after them always starts a row of its own. */}
          {headerState || showsLastSweep ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {headerState ? <ToneBadge tone={headerState.tone}>{headerState.label}</ToneBadge> : null}
              {/* The page's one "Tracking changed" note, as AI Visibility and Queries word it: the label, with which
                  sweep is on screen and when new numbers arrive in its help. A managed dashboard dates no change. */}
              {showsLastSweep ? (
                <span role="status">
                  <StatusNote
                    icon={Clock}
                    tone="caution"
                    label={VISIBILITY_TOOLBAR_COPY.trackingChangedLabel(sweep.trackingChangedAt && !isDashboardManagedSweeps() ? formatObservedInstantMonthDay(observedInstant(sweep.trackingChangedAt)) : null)}
                    detail={`${VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(sweptOn, null)} Queries removed since ${sweptOn ?? 'the last sweep'} still count in the rates on this page. Queries added since do not.`}
                  />
                </span>
              ) : null}
              {selectedRow && selectedRow.flags > 0 ? (
                <span className="inline-flex items-center whitespace-nowrap">
                  <ToneBadge tone="caution">{selectedRow.flags} {selectedRow.flags === 1 ? 'unclear link' : 'unclear links'}</ToneBadge>
                  <InfoTooltip variant="caution" text="Cited links that match more than one location. They are marked Several locations under Answers." />
                </span>
              ) : null}
            </div>
          ) : null}
          {/* The page's one primary action, for writers only, so a viewer sees no dead button. This render is past
              the setup checks above: the plan is advanced and holds this location. Keyed, because the router keeps
              this page mounted from one location to the next. */}
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-2 max-sm:basis-full">
              <AddLocationQueryButton key={property} projectName={project} locationKey={property} variant="default" className="pointer-coarse:min-h-11 max-md:min-h-11" />
            </div>
          ) : null}
        </div>
      </div>

      <CoverageHero
        branded={brandedRow}
        nonBrand={nonBrandRow}
        brandedFailed={brandedUnavailable}
        nonBrandFailed={nonBrandUnavailable}
        notInLastSweep={notInLastSweep}
      />

      {/* What the location is tracked for, with what it is matched by beside it from a 68rem frame. The side panel
          sits beside this section only: a narrower column would fold the answers table below into its phone layout. */}
      <div className="@container">
        <div className="grid gap-x-6 gap-y-8 @[68rem]:grid-cols-[minmax(0,1fr)_20rem]">
          {/* A managed dashboard dates no tracking change, here as on AI Visibility and Queries. The section says it
              only when the header does not and no overview is still being read: the page has one such note. */}
          <LocationTrackedSection key={property} projectName={project} targetKey={property} canWrite={canWrite} trackingChangedAt={showsLastSweep || overviewsLoading ? null : isDashboardManagedSweeps() ? undefined : activePlan!.createdAt} />
          <div className="min-w-0 @[68rem]:border-l @[68rem]:border-default @[68rem]:pl-6">
            <LocationSidePanel
              projectName={project}
              target={target}
              activeRevision={activePlan!.revision}
              publishedBrandNames={planV2.identities.projectBrand.names}
              setupAction={canWrite ? setupLink('Open Bulk setup') : undefined}
            />
          </div>
        </div>
      </div>

      {/* Every section from here to the end of the page is under this heading. */}
      <div className="space-y-4 border-t border-default pt-6">
        <h2 className="text-lg font-semibold text-heading">Results</h2>
        <BrandContrast
          branded={brandedRow}
          nonBrand={nonBrandRow}
          brandedError={brandedQuery.isError}
          nonBrandError={nonBrandQuery.isError}
          onRetry={retryClass}
          notInLastSweep={notInLastSweep}
        />
      </div>

      {needsMeasurement ? (
        <section className="flex flex-wrap items-center justify-between gap-3 border-y border-default py-4" aria-label="Measurement next step">
          <StatusNote
            icon={Clock}
            label="Awaiting next sweep"
            detail={isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : canWrite
              ? 'Run a sweep from AI Visibility to collect this location’s coverage and source evidence.'
              : 'This location needs a new measurement before coverage and source evidence are available.'}
          />
          {/* Outlined: the header's Add button is the page's one filled action. */}
          <Button asChild type="button" variant="outline" className="h-11 px-4 text-sm md:h-11">
            <Link to="/projects/$projectName" params={{ projectName: project }} search={carryVisibilitySearch}>
              {canWrite ? 'Go to AI Visibility' : 'View AI Visibility'}
            </Link>
          </Button>
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-4 border-y border-default py-4">
        <div className="space-y-1">
          <label htmlFor="property-query-class" className="block text-sm font-medium text-heading">Type</label>
          {/* Named in full for a screen reader, as the same control is on AI Visibility. */}
          <select
            id="property-query-class"
            aria-label="Query type"
            value={queryClass}
            onChange={event => showQueryClass(event.target.value === 'branded' ? 'branded' : 'non-brand')}
            className="h-11 rounded-md border border-default bg-surface px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-mono-400"
          >
            <option value="non-brand">{CLASS_LABELS['non-brand']}</option>
            <option value="branded">{CLASS_LABELS.branded}</option>
          </select>
        </div>
        <PropertyProvenance
          measuredAt={measuredAt}
          unmeasuredReason={engineUnmeasuredReason}
          queryClass={queryClass}
        />
      </div>

      <ProviderBreakdown row={selectedRow} queryClass={queryClass} isError={selectedClassUnavailable} onRetry={retrySelectedClass} notInLastSweep={selectedTypeGap} />
      {/* Directly under coverage, because it is what coverage raises and cannot
          answer. The evidence table below is the receipts; this is the finding. */}
      <NamedInstead project={project} targetKey={property} queryClass={queryClass} notInLastSweep={selectedNotInLastSweep} />
      <MarketLink project={project} groups={memberGroups} />

      <section aria-labelledby="property-evidence" className="page-section-divider">
        <div className="section-head section-head-inline">
          <div className="flex items-center gap-1">
            <h3 id="property-evidence" className="text-base font-semibold text-heading">Answers</h3>
            <InfoTooltip placement="bottom" text="One row per answer to this location's queries in this sweep. Mentioned and cited are separate. No saved answer text reads Not measured. Open a row for the answer and its sources." />
          </div>
          {evidenceRows.length > 0 ? <p className="supporting-copy">{evidenceRows.length} of {evidenceTotal}</p> : null}
        </div>
        {selectedClassUnavailable ? (
          <ClassLoadFailed queryClass={queryClass} onRetry={retrySelectedClass} />
        ) : evidenceQuery.isPending && evidenceRows.length === 0 ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : evidenceQuery.isError && evidenceRows.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Load failed" detail="The answers did not load." /></span>
            <RetryButton name="answers" onClick={() => { void evidenceQuery.refetch() }} />
          </div>
        ) : evidenceState === 'not_measured' ? (
          // Not measured is not "no evidence". Saying "none" here would report
          // an absent measurement as a measured result.
          <StatusNote
            icon={Clock}
            label="Not measured"
            detail={isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : canWrite
              ? 'Run a measurement to collect the answers for this location.'
              : 'This location needs a new measurement before its answers are available.'}
          />
        ) : evidenceShapeMismatch ? (
          <div className="flex flex-wrap items-center gap-3">
            <span role="alert">
              <StatusNote icon={AlertTriangle} tone="caution" label="Answers unavailable" detail="This measurement was returned in an older format, so the answers cannot be shown here. The numbers above are unaffected." />
            </span>
            <RetryButton name="answers" onClick={() => { void evidenceQuery.refetch() }} />
          </div>
        ) : evidenceRows.length === 0 && selectedTypeGap ? (
          <NotInLastSweep reason={selectedTypeGap} />
        ) : evidenceRows.length === 0 ? (
          <StatusNote icon={Info} label="No answers" detail="No answers matched this location in this sweep." />
        ) : (
          <>
            <div className="property-answer-table-container overflow-x-auto rounded-md border border-default">
              <table className="evidence-table property-evidence-table">
                <caption className="sr-only">Answers measured for this location</caption>
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Mentioned</th>
                    <th>Cited</th>
                    <th>Sources</th>
                    <th><span className="sr-only">Sources detail</span></th>
                  </tr>
                </thead>
                <tbody>
                  {evidenceRows.map(item => {
                    const key = answerKey(item)
                    const expanded = expandedAnswers.has(key)
                    const detailId = `property-answer-${encodeURIComponent(key)}`
                    return (
                      <Fragment key={key}>
                        <tr className="property-answer-summary">
                          <td className="text-secondary">
                            <h4 className="text-sm font-medium text-heading">{item.queryText}</h4>
                            <span className="mt-1 block text-xs text-muted">
                              {[providerDisplayName(item.provider), item.location].filter(Boolean).join(' · ')}
                            </span>
                            {item.historical || item.bridged ? (
                              <span className="mt-1 flex"><ToneBadge tone="caution">Historical</ToneBadge></span>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap"><span className="property-evidence-mobile-label" aria-hidden="true">Mentioned</span><MentionSignal row={item} /></td>
                          <td className="whitespace-nowrap"><span className="property-evidence-mobile-label" aria-hidden="true">Cited</span><CitationSignal row={item} /></td>
                          <td className="whitespace-nowrap tabular-nums text-secondary"><span className="property-evidence-mobile-label" aria-hidden="true">{ANSWER_SOURCES_LABEL}</span>{item.cited === null ? <StatusNote icon={AlertTriangle} tone="caution" label={sourcesGap(item).label} detail={sourcesGap(item).detail} /> : item.sources.length}</td>
                          <td className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left md:h-auto md:whitespace-nowrap"
                              aria-expanded={expanded}
                              aria-label={expanded ? `Hide the answer for ${item.queryText}` : `View the answer for ${item.queryText}`}
                              aria-controls={expanded ? detailId : undefined}
                              onClick={() => setExpandedAnswers(current => {
                                const next = new Set(current)
                                if (!next.delete(key)) next.add(key)
                                return next
                              })}
                            >
                              {expanded ? 'Hide answer' : 'View answer'}
                            </Button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="property-answer-detail">
                            <td id={detailId} colSpan={5} className="bg-surface-subtle px-4">
                              {/* The answer leads. The source list is the supporting
                                  detail, not the point: a reader who opened this row
                                  wants to know what was said before who was linked. */}
                              <AnswerText project={project} targetKey={property} resultId={item.observationId} headingLevel={5} />
                              <AnswerSources row={item} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {evidenceQuery.hasNextPage ? (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
                <span>Showing {evidenceRows.length} of {evidenceTotal}</span>
                {evidenceQuery.isFetchNextPageError ? <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Load failed" /></span> : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-4 text-sm md:h-11"
                  disabled={evidenceQuery.isFetchingNextPage}
                  aria-label={evidenceQuery.isFetchNextPageError && !evidenceQuery.isFetchingNextPage ? 'Retry more answers' : undefined}
                  onClick={() => { void evidenceQuery.fetchNextPage() }}
                >
                  {evidenceQuery.isFetchingNextPage
                    ? 'Loading…'
                    : evidenceQuery.isFetchNextPageError
                      ? 'Retry'
                      : `Show ${EVIDENCE_PAGE_SIZE} more`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {selected ? (
        <CitedOnOtherQueries
          project={project}
          targetKey={property}
          queryClass={queryClass}
          runId={displayedRunId}
          targetLabels={targetLabels}
          notInLastSweep={locationNotInLastSweep}
        />
      ) : null}
    </div>
  )
}
