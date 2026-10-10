import { usePublishAeroView } from '../contexts/aero-view-context.js'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Ban, Clock, Info } from 'lucide-react'
import { formatPercent, MeasurementEvidenceShapes, UNATTRIBUTED_MENTION_REASON } from '@ainyc/canonry-contracts'
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
  getApiV1ProjectsByNameVisibilityReportOptions,
} from '@ainyc/canonry-api-client/react-query'

import { getEmbedConfig, heyClient, isDashboardManagedSweeps } from '../api.js'
import { MANAGED_SWEEPS_COPY } from '../components/project/ManagedSweepStatus.js'
import { effectiveEmbedProjectTabs, isEmbedProjectTabAllowed } from '../embed.js'
import { Button } from '../components/ui/button.js'
import { formatObservedInstantLabel, observedInstant } from '../components/shared/ChartPrimitives.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { StatusNote } from '../components/shared/StatusNote.js'
import { AnswerMarkdown, ANSWER_SOURCES_LABEL } from '../components/shared/AnswerMarkdown.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { excludedAnswersLabel, splitPercentSign, type CoverageSignal } from '../lib/format-helpers.js'
import { SourceLink } from '../components/shared/SourceLink.js'
import { carryVisibilitySearch, parseVisibilitySelection, patchVisibilitySelection, visibilityReportFirstPageQuery } from '../lib/measurement-view-url.js'
import { providerDisplayName } from '../lib/visibility-trend-helpers.js'
import type { VisibilitySelectionState } from '../lib/measurement-view-url.js'
import { MARKET_SCOPE_COPY } from '../components/project/VisibilityScopePicker.js'
import { useAccount } from '../contexts/account-context.js'
import { matcherLabel } from '../components/project/advanced-measurement/v2-overview-adapter.js'
import { PropertyNamesSection } from '../components/project/advanced-measurement/PropertyNamesEditor.js'
import { AddLocationQueryButton } from '../components/project/DiscoverySection.js'

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
const NO_COMPLETED_SWEEP = 'No completed sweep yet'

/** The two query types, named as the Queries tab names them. */
const CLASS_LABELS: Record<QueryClass, string> = { branded: 'Branded', 'non-brand': 'Non-brand' }

/** A type mid-sentence, for a tooltip or a button's accessible name: "branded queries". */
function classQueries(queryClass: QueryClass): string {
  return `${CLASS_LABELS[queryClass].toLocaleLowerCase()} queries`
}

interface UnavailableReason { label: string; detail?: string }

/**
 * Why a number is missing, in the reader's language. A metric with no evidence
 * renders one of these and never a percentage — "0%" is a measured result and
 * saying it here would invent one. A reason that takes a sentence keeps it as
 * `detail`, shown behind the help icon beside the label.
 */
const UNAVAILABLE_REASONS: Record<string, UnavailableReason> = {
  plan_v1: { label: 'Setup update required' },
  no_completed_run: { label: NO_COMPLETED_SWEEP },
  no_population: { label: 'No queries tracked' },
  evidence_incomplete: { label: 'Evidence incomplete' },
  identity_ambiguous: { label: 'Unclear answers', detail: UNATTRIBUTED_MENTION_REASON },
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
        <InfoTooltip text="No mention signal for this location." />
      </span>
    )
  }
  return <ToneBadge tone={row.mentioned ? 'positive' : 'neutral'}>{row.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge>
}

/** An answer whose source list was not fully captured. Shown where its source count would be. */
const SOURCES_PARTIAL = { label: 'Sources partial', detail: 'Sources were not fully captured for this answer.' } as const

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
    return <div className="py-2"><StatusNote icon={AlertTriangle} tone="caution" label="Sources not saved" detail="The sources for this answer were not fully captured, so none can be shown." /></div>
  }
  if (row.sources.length === 0) {
    return <div className="py-2"><StatusNote icon={Ban} label="No sources" detail="This answer returned no source URLs at all." /></div>
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
function AnswerText({ project, targetKey, resultId }: { project: string; targetKey: string; resultId: string }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementQuestionResultOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, resultId },
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
      <AnswerMarkdown headingLevel={4} copyable>{answer}</AnswerMarkdown>
    </div>
  )
}

function reasonOf(metric: Extract<MetricValue, { state: 'unavailable' }>): UnavailableReason {
  return UNAVAILABLE_REASONS[metric.reason] ?? { label: 'Not measured' }
}

/** A reason's label, with its sentence behind the help icon when it has one. */
function ReasonLabel({ reason }: { reason: UnavailableReason }) {
  return <>{reason.label}{reason.detail ? <InfoTooltip text={reason.detail} /> : null}</>
}

/**
 * One metric cell. The unavailable branch is deliberately not a number: it says
 * "Not measured" and carries the server's reason, so an unmeasured Property can
 * never be read as a measured zero.
 */
function MetricCell({ metric, signal, emphasis = false }: { metric: MetricValue; signal: CoverageSignal; emphasis?: boolean }) {
  if (metric.state === 'unavailable') {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={emphasis ? 'text-lg font-semibold text-secondary' : 'text-sm font-medium text-secondary'}>Not measured</span>
        <span className="text-sm text-secondary"><ReasonLabel reason={reasonOf(metric)} /></span>
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
    query: { scope: 'property', targetKey, queryClass },
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
  unmeasuredReason?: string
  queryClass: QueryClass
}) {
  const when = measuredAt === undefined
    ? null
    : measuredAt === null
      ? NO_COMPLETED_SWEEP
      : `Measured ${formatObservedInstantLabel(observedInstant(measuredAt))}`
  if (when === null && unmeasuredReason === undefined) return null
  return (
    <p className="supporting-copy">
      {/* A location never swept gets the same words from both sides: say them once. */}
      {[...new Set([when, unmeasuredReason].filter(Boolean))].join(' · ')}
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
          <h2 id="property-market" className="text-base font-semibold text-heading">Competitors by market</h2>
          <InfoTooltip text="Competitors are attached to a market rather than to a single location, because one location has nobody to be compared against. Share of voice and competitor pressure are reported for the market this location sits in." />
        </div>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/projects/$projectName" params={{ projectName: project }} search={previous => patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'project' })}>Open measurement overview</Link>
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
function CoverageHeroRow({ label, metric, signal, failed = false }: { label: string; metric: MetricValue | undefined; signal: CoverageSignal; failed?: boolean }) {
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
    const reason = reasonOf(metric)
    return (
      <div className="aeo-hero-row">
        <p className="aeo-hero-row-label">{label}</p>
        <p className="aeo-hero-row-value whitespace-nowrap text-base font-semibold text-secondary">Not measured</p>
        <div />
        <p className="aeo-hero-row-detail">{reason.label === 'Not measured' ? '' : <ReasonLabel reason={reason} />}</p>
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
}: {
  branded: PropertyRow | undefined
  nonBrand: PropertyRow | undefined
  brandedFailed?: boolean
  nonBrandFailed?: boolean
}) {
  return (
    <section aria-labelledby="property-coverage-hero">
      <h2 id="property-coverage-hero" className="sr-only">Coverage for this location</h2>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-secondary">{CLASS_LABELS['non-brand']}</p>
          <CoverageHeroRow label="Mentioned" metric={nonBrand?.mentionCoverage} signal="mentioned" failed={nonBrandFailed} />
          <CoverageHeroRow label="Cited" metric={nonBrand?.citationCoverage} signal="cited" failed={nonBrandFailed} />
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-secondary">{CLASS_LABELS.branded}</p>
          <CoverageHeroRow label="Mentioned" metric={branded?.mentionCoverage} signal="mentioned" failed={brandedFailed} />
          <CoverageHeroRow label="Cited" metric={branded?.citationCoverage} signal="cited" failed={brandedFailed} />
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
}: {
  branded: PropertyRow | undefined
  nonBrand: PropertyRow | undefined
  brandedError: boolean
  nonBrandError: boolean
  onRetry: (queryClass: QueryClass) => void
}) {
  const rows: Array<{ queryClass: QueryClass; row: PropertyRow | undefined; isError: boolean }> = [
    { queryClass: 'branded', row: branded, isError: brandedError },
    { queryClass: 'non-brand', row: nonBrand, isError: nonBrandError },
  ]
  return (
    <section aria-labelledby="property-brand-contrast">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h2 id="property-brand-contrast" className="text-base font-semibold text-heading">By type</h2>
          <InfoTooltip text="Branded queries already contain your name, so an answer engine has an easy path back to you. Non-brand queries describe the need instead, and that is the demand you have to earn. Each row is measured only over this location's queries of that type. A type with no query reads Not measured rather than 0%." />
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-default">
        <table className="evidence-table min-w-[560px]">
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
                  <span className="block font-medium text-heading">{CLASS_LABELS[queryClass]}</span>
                  {row && isError ? (
                    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span role="status"><StatusNote icon={AlertTriangle} tone="caution" label="Refresh failed" detail="The latest numbers did not load. These are the last ones read." /></span>
                      <RetryButton name={classQueries(queryClass)} onClick={() => onRetry(queryClass)} />
                    </span>
                  ) : null}
                </td>
                {row ? (
                  <>
                    <td><MetricCell metric={row.mentionCoverage} signal="mentioned" emphasis /></td>
                    <td><MetricCell metric={row.citationCoverage} signal="cited" emphasis /></td>
                  </>
                ) : isError ? (
                  <td colSpan={2}><ClassLoadFailed queryClass={queryClass} onRetry={() => onRetry(queryClass)} announce /></td>
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

function ProviderBreakdown({ row, queryClass, isError, onRetry }: { row: PropertyRow | undefined; queryClass: QueryClass; isError: boolean; onRetry: () => void }) {
  return (
    <section aria-labelledby="property-providers" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h2 id="property-providers" className="text-base font-semibold text-heading">By engine</h2>
          <InfoTooltip text="Each row is measured over the queries that engine actually answered for this location, so the rows are a split of the same population rather than parts that add up to the location total. An engine that answered nothing for this location is absent instead of shown at 0%." />
        </div>
      </div>
      {row === undefined && isError ? (
        <ClassLoadFailed queryClass={queryClass} onRetry={onRetry} />
      ) : row === undefined ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : row.providers.length === 0 ? (
        <StatusNote
          icon={Clock}
          label="Not measured"
          detail={`No answer engine has measured ${classQueries(queryClass)} for this location.${row.mentionCoverage.state === 'unavailable' ? ` ${reasonOf(row.mentionCoverage).label}.` : ''}`}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[520px]">
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
 * The full query list behind the count in the "Named instead" table's Queries
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
function NamedInstead({ project, targetKey, queryClass }: { project: string; targetKey: string; queryClass: QueryClass }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementPropertyCompetitorsOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, queryClass },
    }),
  })

  // Nothing to say yet, and a heading over a spinner is noise on a page that
  // already has four sections. The section appears when it has something.
  if (query.isPending || query.isError) return null
  const competitors = query.data?.competitors ?? []
  const basis = query.data?.basis

  return (
    <section aria-labelledby="property-named-instead" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h2 id="property-named-instead" className="text-base font-semibold text-heading">Named instead</h2>
          <InfoTooltip text="Counted from the answers that did not name this location, so a name here is one an engine recommended in its place. Occurrences count answers, not positions: an engine naming the same rival in two answers counts twice, and one naming it twice in a single answer counts once." />
        </div>
        {competitors.length > 0 ? <p className="supporting-copy">{query.data?.total ?? competitors.length} named</p> : null}
      </div>
      {competitors.length === 0 ? (
        <StatusNote icon={Ban} label="None named" detail="No rival was named in the answers this location missed." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[420px]">
              <caption className="sr-only">Names the engines gave instead of this location</caption>
              <thead>
                <tr>
                  <th>Named</th>
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
                        <InfoTooltip text={competitorQueriesTooltipText(row)} />
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
                <dd className="tabular-nums text-heading">{basis.targetMissResults} of {basis.answeredResults}</dd>
              </dl>
              <InfoTooltip text={`Answers to ${classQueries(queryClass)} that did not name this location.`} />
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function AssignedQuestions({ questions, queryClass, action, notice }: { questions: readonly string[]; queryClass: QueryClass; action?: ReactNode; notice?: ReactNode }) {
  return (
    <section aria-labelledby="property-questions" className="page-section-divider">
      <div className="section-head section-head-inline flex-wrap">
        <div>
          <h2 id="property-questions" className="text-base font-semibold text-heading">{CLASS_LABELS[queryClass]} queries</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="supporting-copy">{questions.length} tracked</p>
          {action}
        </div>
      </div>
      {notice}
      {questions.length === 0 ? (
        <StatusNote icon={Ban} label={`No ${classQueries(queryClass)}`} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[420px]">
            <caption className="sr-only">Queries tracked for this location</caption>
            <thead><tr><th>Query</th></tr></thead>
            <tbody>{questions.map(question => <tr key={question}><td className="text-secondary">{question}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PropertyUrls({ urls }: { urls: readonly string[] }) {
  return (
    <section aria-labelledby="property-urls" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h2 id="property-urls" className="text-base font-semibold text-heading">Site pages we match</h2>
          <InfoTooltip text="A cited source URL is credited to this location when it matches one of these. The most specific match wins, so a URL covered by two locations at the same specificity is flagged for review instead of being credited to either." />
        </div>
        <p className="supporting-copy">{urls.length} configured</p>
      </div>
      {urls.length === 0 ? (
        <StatusNote icon={Ban} label="No site pages" />
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[420px]">
            <caption className="sr-only">Site pages matched to this location</caption>
            <thead><tr><th>URL</th></tr></thead>
            <tbody>{urls.map(url => <tr key={url}><td className="break-all text-secondary">{url}</td></tr>)}</tbody>
          </table>
        </div>
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
  emptyHelp: 'No answer to a query tracked for another location cited this location\u2019s pages in the displayed measurement.',
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
}: {
  project: string
  targetKey: string
  queryClass: QueryClass
  runId: string | undefined
  targetLabels: ReadonlyMap<string, string>
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

  return (
    <section aria-labelledby="property-other-queries" className="page-section-divider">
      <div className="section-head section-head-inline flex-wrap">
        <div className="flex items-center gap-1">
          <h2 id="property-other-queries" className="text-base font-semibold text-heading">{OTHER_QUERIES_COPY.heading}</h2>
          <InfoTooltip text={OTHER_QUERIES_COPY.help} />
        </div>
        {query.data ? (
          <div className="flex flex-wrap items-center gap-x-3">
            <p className="supporting-copy">{total} {total === 1 ? 'answer' : 'answers'} &middot; {CLASS_LABELS[queryClass]}</p>
            <StatusNote icon={Info} label={OTHER_QUERIES_COPY.notCounted} detail={OTHER_QUERIES_COPY.notCountedHelp} />
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
      ) : rows.length === 0 ? (
        <StatusNote icon={Ban} label={OTHER_QUERIES_COPY.empty} detail={OTHER_QUERIES_COPY.emptyHelp} />
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
                                <Link
                                  to="/projects/$projectName/properties/$targetKey"
                                  params={{ projectName: project, targetKey: key }}
                                  search={carryVisibilitySearch}
                                  className="text-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                                >
                                  {targetLabels.get(key) ?? key}
                                </Link>
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
                            aria-label={open ? `Hide the answer for ${row.queryText}` : `Read the answer for ${row.queryText}`}
                            aria-controls={open ? detailId : undefined}
                            onClick={() => setExpanded(current => {
                              const next = new Set(current)
                              if (!next.delete(key)) next.add(key)
                              return next
                            })}
                          >
                            {open ? 'Hide answer' : 'Read answer'}
                          </Button>
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td id={detailId} colSpan={4} className="bg-surface-subtle px-4">
                            <AnswerText project={project} targetKey={row.assignedTargetKeys[0]!} resultId={row.observationId} />
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
  // Query type and filters arrive in AI Visibility's shared URL selection.
  const urlSearch = useSearch({ strict: false }) as Record<string, unknown>
  const selection = useMemo(() => parseVisibilitySelection(urlSearch), [urlSearch])
  const [expandedAnswers, setExpandedAnswers] = useState<ReadonlySet<string>>(new Set<string>())
  // The queries the last publish from this page's sheet touched, with where it was made.
  const [published, setPublished] = useState<{ property: string; queryClass: QueryClass; revision: number; queryIds: readonly string[] } | null>(null)
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
    void navigate({ to: '.', search: previous => patchVisibilitySelection(previous, { queryClass: next }) })
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

  // The engine COUNT is gone from this page: the engine table below states it by
  // listing one row per engine, and a card above restating it was one of the
  // three that made the facts grid repeat its own page. What survives is the
  // reason a class has no numbers at all, which nothing else says once.
  const engineUnmeasuredReason = selectedRow?.mentionCoverage.state === 'unavailable'
    ? reasonOf(selectedRow.mentionCoverage).label
    : undefined
  // Undefined while the response is unread, so a pending or failed fetch never
  // asserts this Property has never been swept.
  const measuredAt = selected === undefined ? undefined : selected.measurement.completedAt ?? null
  const needsMeasurement = selected !== undefined && (selected.measurement.state === 'not_measured' || selected.nextAction.kind === 'run_measurement')
  // After a tracking change this page blanks, but AI Visibility still shows this Property's last
  // results. Ask the report the link opens, so the link names results only when there are some.
  // The link opens the latest view, so a carried sweep, revision or end date is dropped.
  const lastResultsSearch = (previous: Record<string, unknown>) => patchVisibilitySelection(carryVisibilitySearch(previous), {
    measurementScope: 'property', measurementScopeKey: property, queryClass,
    measurementRunId: undefined, measurementRevision: undefined, measurementTo: undefined,
  })
  const lastResultsQuery = useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: project }, query: visibilityReportFirstPageQuery(parseVisibilitySelection(lastResultsSearch(urlSearch))) }),
    enabled: enabled && needsMeasurement,
    retry: false,
  })
  // The measured revision belongs to the whole sweep. A Property that had no queries of this type
  // before the change has an empty population in it, so nothing to show.
  const lastResults = lastResultsQuery.data
  const hasLastResults = lastResults !== undefined && lastResults.selection.measurement.measuredRevision !== null
    && (lastResults.populations.find(population => population.queryClass === queryClass)?.summary.queryCount ?? 0) > 0

  const evidenceInput = {
    client: heyClient,
    path: { name: project },
    query: {
      targetKey: property,
      queryClass,
      shape: MeasurementEvidenceShapes.answers,
      limit: EVIDENCE_PAGE_SIZE,
      ...(displayedRunId ? { runId: displayedRunId } : {}),
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

  const questions = useMemo(() => {
    if (!planV2) return []
    const textById = new Map(planV2.querySnapshots.map(snapshot => [snapshot.queryId, snapshot.queryText]))
    return [...new Set(planV2.assignments
      .filter(assignment => assignment.targetKey === property && assignment.queryClass === queryClass)
      .flatMap(assignment => {
        const text = textById.get(assignment.queryId)
        return text === undefined ? [] : [text]
      }))].sort((left, right) => left.localeCompare(right))
  }, [planV2, property, queryClass])

  // The server files a query that names this location as Branded, so a query
  // added from this page can land under the Query type the list is not showing.
  // Counted once the page holds the published setup, and only on the location
  // and Query type it was added from.
  const otherClass: QueryClass = queryClass === 'branded' ? 'non-brand' : 'branded'
  const addedElsewhere = useMemo(() => {
    if (!planV2 || !activePlan || !published || published.property !== property || published.queryClass !== queryClass) return 0
    if (activePlan.revision < published.revision) return 0
    return new Set(planV2.assignments
      .filter(assignment => assignment.targetKey === property && assignment.queryClass === otherClass && published.queryIds.includes(assignment.queryId))
      .map(assignment => assignment.queryId)).size
  }, [planV2, activePlan, published, property, queryClass, otherClass])

  const urls = useMemo(() => target?.urlMatchers.map(matcherLabel) ?? [], [target])
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

  const backLink = (
    <Link
      to="/projects/$projectName"
      params={{ projectName: project }}
      search={carryVisibilitySearch}
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-strong"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back to AI Visibility
    </Link>
  )

  if (!hasRouteParams) {
    return <div className="page-container"><StatusNote icon={AlertTriangle} label="Location not found" /></div>
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
                : 'A location page needs a published advanced measurement setup.'}
            />
          </span>
          <Button asChild type="button" variant="outline" className="h-11 px-4 text-sm md:h-11">
            <Link to="/projects/$projectName/portfolio" params={{ projectName: project }}>
              {canWrite ? (legacyPlan ? 'Republish setup' : 'Open measurement setup') : 'View measurement setup'}
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container space-y-8">
      <div className="page-header">
        <div className="page-header-left">
          {backLink}
          <h1 className="page-title mt-2">{target.label}</h1>
          <p className="page-subtitle">
            Location in {project}
            {filterHelp ? (
              <>
                {' · Filters not applied '}
                <InfoTooltip text={filterHelp} />
              </>
            ) : null}
          </p>
        </div>
        <div className="page-header-right">
          {selected ? (
            <ToneBadge tone={MEASUREMENT_STATES[selected.measurement.state].tone}>
              {MEASUREMENT_STATES[selected.measurement.state].label}
            </ToneBadge>
          ) : null}
          {selectedRow && selectedRow.flags > 0 ? (
            <ToneBadge tone="caution">{selectedRow.flags} {selectedRow.flags === 1 ? 'unclear link' : 'unclear links'}</ToneBadge>
          ) : null}
        </div>
      </div>

      <CoverageHero
        branded={brandedRow}
        nonBrand={nonBrandRow}
        brandedFailed={brandedUnavailable}
        nonBrandFailed={nonBrandUnavailable}
      />

      <BrandContrast
        branded={brandedRow}
        nonBrand={nonBrandRow}
        brandedError={brandedQuery.isError}
        nonBrandError={nonBrandQuery.isError}
        onRetry={retryClass}
      />

      {needsMeasurement ? (
        <section className="flex flex-wrap items-center justify-between gap-3 border-y border-default py-4" aria-label="Measurement next step">
          <StatusNote
            icon={Clock}
            label="Awaiting next sweep"
            detail={isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : canWrite
              ? `Run a measurement from the project overview to collect this location’s coverage and source evidence.${hasLastResults ? ' AI Visibility still shows the last results.' : ''}`
              : 'This location needs a new measurement before coverage and source evidence are available.'}
          />
          <Button asChild type="button" className="h-11 px-4 text-sm md:h-11">
            <Link to="/projects/$projectName" params={{ projectName: project }} search={hasLastResults ? lastResultsSearch : carryVisibilitySearch}>
              {hasLastResults ? 'See the last results' : canWrite ? 'Go to AI Visibility' : 'View AI Visibility'}
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

      <ProviderBreakdown row={selectedRow} queryClass={queryClass} isError={selectedClassUnavailable} onRetry={retrySelectedClass} />
      {/* Directly under coverage, because it is what coverage raises and cannot
          answer. The evidence table below is the receipts; this is the finding. */}
      <NamedInstead project={project} targetKey={property} queryClass={queryClass} />
      {/* The button is for writers only, so a viewer sees no dead one. This render
          is past the setup checks above: the plan is advanced and holds this
          location. Keyed, because the router keeps this page mounted from one
          location to the next. */}
      <AssignedQuestions
        questions={questions}
        queryClass={queryClass}
        action={canWrite ? (
          <AddLocationQueryButton
            key={property}
            projectName={project}
            locationKey={property}
            className="h-11 px-4 text-sm md:h-11"
            onPublished={result => {
              if (!result.committed || !result.active) return
              setPublished({ property, queryClass, revision: result.active.revision, queryIds: [...result.diff.added, ...result.diff.reused].map(row => row.queryId) })
            }}
          />
        ) : null}
        notice={addedElsewhere > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span role="status">
              <StatusNote
                icon={Info}
                label={`${addedElsewhere} added under ${CLASS_LABELS[otherClass]}`}
                detail={`${addedElsewhere === 1 ? '1 query you added is' : `${addedElsewhere} queries you added are`} listed under ${CLASS_LABELS[otherClass]} queries.`}
              />
            </span>
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 text-sm md:h-11" onClick={() => showQueryClass(otherClass)}>
              Show {classQueries(otherClass)}
            </Button>
          </div>
        ) : null}
      />
      <PropertyNamesSection
        projectName={project}
        targetKey={property}
        published={target}
        activeRevision={activePlan!.revision}
        publishedBrandNames={planV2.identities.projectBrand.names}
      />
      <PropertyUrls urls={urls} />
      <MarketLink project={project} groups={memberGroups} />

      <section aria-labelledby="property-evidence" className="page-section-divider">
        <div className="section-head section-head-inline">
          <div className="flex items-center gap-1">
            <h2 id="property-evidence" className="text-base font-semibold text-heading">Answers</h2>
            <InfoTooltip text="One row per answer an engine gave for this location's queries in the displayed measurement. Mentioned and cited are independent: an answer can name this location without linking it, or link it without naming it. Where the answer text was not stored the mention reads Not measured, never a zero. Open a row to read what the engine actually said, followed by the source URLs it returned, this location's own first." />
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
          <StatusNote icon={Clock} label="Not measured" detail={isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Run a measurement to collect the answers for this location.'} />
        ) : evidenceShapeMismatch ? (
          <span role="alert">
            <StatusNote icon={AlertTriangle} tone="caution" label="Answers unavailable" detail="This measurement was returned in an older format, so the answers cannot be shown here. The numbers above are unaffected." />
          </span>
        ) : evidenceRows.length === 0 ? (
          <StatusNote icon={Ban} label="No answers" detail="No answers matched this location in the displayed measurement." />
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
                            <h3 className="text-sm font-medium text-heading">{item.queryText}</h3>
                            <span className="mt-1 block text-xs text-muted">
                              {[providerDisplayName(item.provider), item.location].filter(Boolean).join(' · ')}
                            </span>
                            {item.historical || item.bridged ? (
                              <span className="mt-1 flex"><ToneBadge tone="caution">Historical</ToneBadge></span>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap"><span className="property-evidence-mobile-label" aria-hidden="true">Mentioned</span><MentionSignal row={item} /></td>
                          <td className="whitespace-nowrap"><span className="property-evidence-mobile-label" aria-hidden="true">Cited</span><CitationSignal row={item} /></td>
                          <td className="whitespace-nowrap tabular-nums text-secondary"><span className="property-evidence-mobile-label" aria-hidden="true">{ANSWER_SOURCES_LABEL}</span>{item.cited === null ? <StatusNote icon={AlertTriangle} tone="caution" label={SOURCES_PARTIAL.label} detail={SOURCES_PARTIAL.detail} /> : item.sources.length}</td>
                          <td className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left md:h-auto md:whitespace-nowrap"
                              aria-expanded={expanded}
                              aria-label={expanded ? `Hide the answer for ${item.queryText}` : `Read the answer for ${item.queryText}`}
                              aria-controls={expanded ? detailId : undefined}
                              onClick={() => setExpandedAnswers(current => {
                                const next = new Set(current)
                                if (!next.delete(key)) next.add(key)
                                return next
                              })}
                            >
                              {expanded ? 'Hide answer' : 'Read answer'}
                            </Button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="property-answer-detail">
                            <td id={detailId} colSpan={5} className="bg-surface-subtle px-4">
                              {/* The answer leads. The source list is the supporting
                                  detail, not the point: a reader who opened this row
                                  wants to know what was said before who was linked. */}
                              <AnswerText project={project} targetKey={property} resultId={item.observationId} />
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
        />
      ) : null}
    </div>
  )
}
