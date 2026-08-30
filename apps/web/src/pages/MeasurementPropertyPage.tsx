import { Fragment, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { MeasurementEvidenceShapes } from '@ainyc/canonry-contracts'
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

import { heyClient } from '../api.js'
import { getEmbedConfig } from '../api.js'
import { isEmbedProjectTabAllowed } from '../embed.js'
import { Button } from '../components/ui/button.js'
import { formatObservedInstantLabel, observedInstant } from '../components/shared/ChartPrimitives.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { useAccount } from '../contexts/account-context.js'
import { matcherLabel } from '../components/project/advanced-measurement/v2-overview-adapter.js'

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
type ActivePlan = NonNullable<MeasurementPlanResponse['active']>
type PlanV2 = Extract<ActivePlan['plan'], { schemaVersion: 2 }>

const EVIDENCE_PAGE_SIZE = 50

/**
 * The founder's framing of the two baskets, kept beside the technical name so a
 * reader never has to guess which one they are looking at.
 */
const CLASS_LABELS: Record<QueryClass, { headline: string; technical: string }> = {
  branded: { headline: 'When they know your name', technical: 'Branded queries' },
  'non-brand': { headline: 'When they don\'t', technical: 'Non-brand queries' },
}

/**
 * Why a number is missing, in the reader's language. A metric with no evidence
 * renders one of these and never a percentage — "0%" is a measured result and
 * saying it here would invent one.
 */
const UNAVAILABLE_REASONS: Record<string, string> = {
  plan_v1: 'Setup update required',
  no_completed_run: 'No completed measurement yet',
  no_population: 'No queries of this type are assigned',
  evidence_incomplete: 'Source evidence is incomplete',
  not_applicable: 'Not applicable for this Property',
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

const EVIDENCE_LABELS: Record<AnswerSource['classification'], { label: string; tone: 'positive' | 'caution' | 'neutral' | 'negative' }> = {
  assigned: { label: 'Matches this Property', tone: 'positive' },
  sibling: { label: 'Matches another Property', tone: 'caution' },
  ownedUnmapped: { label: 'Site URL not in a Property', tone: 'caution' },
  external: { label: 'External URL', tone: 'neutral' },
  ambiguous: { label: 'Matches multiple Properties', tone: 'caution' },
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

/**
 * The mention signal as three states, never two. A null reads "Not measured"
 * with the reason beside it — reporting it as "not mentioned" would invent a
 * measured miss out of a missing measurement.
 */
function MentionSignal({ row }: { row: AnswerRow }) {
  if (row.mentioned === null) {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <ToneBadge tone="neutral">Not measured</ToneBadge>
        <span className="text-xs text-muted">No mention signal for this Property</span>
      </span>
    )
  }
  return <ToneBadge tone={row.mentioned ? 'positive' : 'neutral'}>{row.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge>
}

/** Rendered where a source count would be, when there is no count to state. */
const EM_DASH = '\u2014'

/**
 * Citation is three states for the same reason mention is. Null means the
 * sources were never fully captured, so neither "Not cited" nor a source count
 * is a claim this run supports: both report an unseen list as an empty one.
 */
function CitationSignal({ row }: { row: AnswerRow }) {
  if (row.cited === null) {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <ToneBadge tone="neutral">Not measured</ToneBadge>
        <span className="text-xs text-muted">Sources were not fully captured</span>
      </span>
    )
  }
  return <ToneBadge tone={row.cited ? 'positive' : 'neutral'}>{row.cited ? 'Cited' : 'Not cited'}</ToneBadge>
}

function AnswerSources({ row }: { row: AnswerRow }) {
  if (row.cited === null && row.sources.length === 0) {
    return <p className="py-2 text-sm text-secondary">The sources for this answer were not fully captured, so none can be shown.</p>
  }
  if (row.sources.length === 0) {
    return <p className="py-2 text-sm text-secondary">This answer returned no source URLs at all.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="evidence-table min-w-[420px]">
        <caption className="sr-only">Source URLs for {row.queryText}</caption>
        <thead><tr><th>Match</th><th>URL</th></tr></thead>
        <tbody>
          {sourcesOwnFirst(row.sources).map(source => (
            <tr key={source.sourceUrl}>
              <td>
                <ToneBadge tone={EVIDENCE_LABELS[source.classification].tone}>
                  {EVIDENCE_LABELS[source.classification].label}
                </ToneBadge>
              </td>
              <td className="break-all text-secondary">{source.sourceUrl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
function AnswerText({ project, targetKey, row }: { project: string; targetKey: string; row: AnswerRow }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementQuestionResultOptions({
      client: heyClient,
      path: { name: project },
      query: { targetKey, resultId: row.observationId },
    }),
  })

  if (query.isPending) {
    return (
      <p className="py-2 text-sm text-secondary" role="status" aria-live="polite">Loading the answer&hellip;</p>
    )
  }
  if (query.isError) {
    return (
      <p className="py-2 text-sm text-secondary" role="alert">Could not load this answer.</p>
    )
  }
  const answer = query.data?.answer
  if (answer === null || answer === undefined || answer.trim() === '') {
    // A measured answer with no stored text is not the same as an empty answer,
    // and neither is worth dressing up as one.
    return <p className="py-2 text-sm text-secondary">This answer was measured, but its text was not stored.</p>
  }
  return (
    <div className="py-2">
      <h4 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">What {row.provider} answered</h4>
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-secondary">{answer}</p>
    </div>
  )
}

function reasonText(metric: Extract<MetricValue, { state: 'unavailable' }>): string {
  return UNAVAILABLE_REASONS[metric.reason] ?? 'Not measured'
}

/**
 * One metric cell. The unavailable branch is deliberately not a number: it says
 * "Not measured" and carries the server's reason, so an unmeasured Property can
 * never be read as a measured zero.
 */
function MetricCell({ metric, emphasis = false }: { metric: MetricValue; emphasis?: boolean }) {
  if (metric.state === 'unavailable') {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={emphasis ? 'text-lg font-semibold text-secondary' : 'text-sm font-medium text-secondary'}>Not measured</span>
        <span className="text-sm text-secondary">{reasonText(metric)}</span>
      </span>
    )
  }
  const percent = `${Math.round(metric.value * 100)}%`
  const counted = metric.numerator === undefined || metric.denominator === undefined
    ? null
    : `${metric.numerator} of ${metric.denominator}`
  return (
    <span className="inline-flex flex-col gap-0.5 tabular-nums">
      <span className={emphasis ? 'text-lg font-semibold text-heading' : 'text-sm font-medium text-primary'}>{percent}</span>
      {counted ? <span className="text-xs text-muted">{counted}</span> : null}
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
      ? 'No completed sweep yet'
      : `Measured ${formatObservedInstantLabel(observedInstant(measuredAt))}`
  if (when === null && unmeasuredReason === undefined) return null
  return (
    <p className="supporting-copy">
      {[when, unmeasuredReason].filter(Boolean).join(' · ')}
      {when !== null && unmeasuredReason === undefined
        ? ` · ${CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} only`
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
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Competitive comparison</p>
          <h2 id="property-market" className="text-base font-semibold text-heading">
            Measured at the market level
            <InfoTooltip text="Competitors are attached to a market rather than to a single Property, because one building has nobody to be compared against. Share of voice and competitor pressure are reported for the market this Property sits in." />
          </h2>
        </div>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/projects/$projectName" params={{ projectName: project }}>Open measurement overview</Link>
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
function CoverageHeroRow({ label, metric, failed = false }: { label: string; metric: MetricValue | undefined; failed?: boolean }) {
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
        <p className="aeo-hero-row-detail">{failed ? 'Could not be loaded' : 'Loading'}</p>
      </div>
    )
  }
  if (metric.state === 'unavailable') {
    // `reasonText` falls back to "Not measured" for a reason this build does not
    // know, which would print the same words twice across two columns and read
    // as a rendering fault. Drop the detail when it says nothing the value did
    // not already say.
    const reason = reasonText(metric)
    return (
      <div className="aeo-hero-row">
        <p className="aeo-hero-row-label">{label}</p>
        <p className="aeo-hero-row-value text-base font-semibold text-secondary">Not measured</p>
        <div />
        <p className="aeo-hero-row-detail">{reason === 'Not measured' ? '' : reason}</p>
      </div>
    )
  }
  const percent = Math.round(metric.value * 100)
  const counted = metric.numerator === undefined || metric.denominator === undefined
    ? null
    : `${metric.numerator} of ${metric.denominator}`
  return (
    <div className="aeo-hero-row">
      <p className="aeo-hero-row-label">{label}</p>
      <p className="aeo-hero-row-value text-heading">{percent}<span className="text-faint">%</span></p>
      <div className="aeo-hero-row-bar" aria-hidden="true">
        <div className="metric-card-bar-fill progress-fill-neutral" style={{ width: `${percent}%` }} />
      </div>
      <p className="aeo-hero-row-detail tabular-nums">{counted ?? ''}</p>
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
      <h2 id="property-coverage-hero" className="sr-only">Coverage for this Property</h2>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="eyebrow eyebrow-soft">Non-brand &middot; the demand to earn</p>
          <CoverageHeroRow label="Mentioned" metric={nonBrand?.mentionCoverage} failed={nonBrandFailed} />
          <CoverageHeroRow label="Cited" metric={nonBrand?.citationCoverage} failed={nonBrandFailed} />
        </div>
        <div className="space-y-2">
          <p className="eyebrow eyebrow-soft">Branded &middot; already named</p>
          <CoverageHeroRow label="Mentioned" metric={branded?.mentionCoverage} failed={brandedFailed} />
          <CoverageHeroRow label="Cited" metric={branded?.citationCoverage} failed={brandedFailed} />
        </div>
      </div>
    </section>
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
        <div>
          <p className="eyebrow eyebrow-soft">The gap</p>
          <h2 id="property-brand-contrast" className="text-base font-semibold text-heading">
            Named versus not named
            <InfoTooltip text="Branded queries already contain your name, so an answer engine has an easy path back to you. Non-brand queries describe the need instead, and that is the demand you have to earn. Each row is measured only over the queries assigned to this Property in that class; a class with no assigned query reads Not measured rather than 0%." />
          </h2>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-default">
        <table className="evidence-table min-w-[560px]">
          <caption className="sr-only">Mention and citation coverage for this Property, split by query class</caption>
          <thead>
            <tr>
              <th>Query type</th>
              <th>Mentioned in the answer</th>
              <th>Cited as a source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ queryClass, row, isError }) => (
              <tr key={queryClass}>
                <td>
                  <span className="block font-medium text-heading">{CLASS_LABELS[queryClass].headline}</span>
                  <span className="mt-0.5 block text-xs text-muted">{CLASS_LABELS[queryClass].technical}</span>
                  {row && isError ? (
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-sm text-caution">
                      <span role="status">Refresh failed.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-11 px-3 text-sm md:h-11"
                        onClick={() => onRetry(queryClass)}
                      >
                        Retry {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()}
                      </Button>
                    </span>
                  ) : null}
                </td>
                {row ? (
                  <>
                    <td><MetricCell metric={row.mentionCoverage} emphasis /></td>
                    <td><MetricCell metric={row.citationCoverage} emphasis /></td>
                  </>
                ) : isError ? (
                  <td colSpan={2}>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
                      <span role="alert">Could not load {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()}.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-11 px-4 text-sm md:h-11"
                        onClick={() => onRetry(queryClass)}
                      >
                        Retry {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()}
                      </Button>
                    </div>
                  </td>
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

function ProviderBreakdown({ row, queryClass, isError }: { row: PropertyRow | undefined; queryClass: QueryClass; isError: boolean }) {
  return (
    <section aria-labelledby="property-providers" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <h2 id="property-providers" className="text-base font-semibold text-heading">
            Which engines answer for this Property
            <InfoTooltip text="Each row is measured over the queries that engine actually answered for this Property, so the rows are a split of the same population rather than parts that add up to the Property total. An engine that answered nothing for this Property is absent instead of shown at 0%." />
          </h2>
        </div>
      </div>
      {row === undefined && isError ? (
        <p className="text-sm text-secondary">Details for {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} are unavailable. Retry that query type above.</p>
      ) : row === undefined ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : row.providers.length === 0 ? (
        <p className="text-sm text-secondary">
          No answer engine has measured {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} for this Property.
          {row.mentionCoverage.state === 'unavailable' ? ` ${reasonText(row.mentionCoverage)}.` : ''}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[520px]">
            <caption className="sr-only">Per-engine mention and citation coverage</caption>
            <thead><tr><th>Engine</th><th>Mentioned</th><th>Cited</th></tr></thead>
            <tbody>
              {row.providers.map(provider => (
                <tr key={provider.provider}>
                  <td className="font-medium text-heading">{provider.provider}</td>
                  <td><MetricCell metric={provider.mentionCoverage} /></td>
                  <td><MetricCell metric={provider.citationCoverage} /></td>
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
        <div>
          <h2 id="property-named-instead" className="text-base font-semibold text-heading">
            Named instead of this Property
            <InfoTooltip text="Counted from the answers that did not name this Property, so a name here is one an engine recommended in its place. Occurrences count answers, not positions: an engine naming the same rival in two answers counts twice, and one naming it twice in a single answer counts once." />
          </h2>
        </div>
        {competitors.length > 0 ? <p className="supporting-copy">{query.data?.total ?? competitors.length} named</p> : null}
      </div>
      {competitors.length === 0 ? (
        <p className="text-sm text-secondary">
          No rival was named in the answers this Property missed. Nothing to compete with here yet.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[420px]">
              <caption className="sr-only">Names the engines gave instead of this Property</caption>
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
                      {row.providers.join(', ')}
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
            <p className="supporting-copy mt-2">
              {basis.targetMissResults} of {basis.answeredResults} answers to {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} did not name this Property.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function AssignedQuestions({ questions, queryClass }: { questions: readonly string[]; queryClass: QueryClass }) {
  return (
    <section aria-labelledby="property-questions" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <h2 id="property-questions" className="text-base font-semibold text-heading">
            {CLASS_LABELS[queryClass].technical} assigned to this Property
          </h2>
        </div>
        <p className="supporting-copy">{questions.length} assigned</p>
      </div>
      {questions.length === 0 ? (
        <p className="text-sm text-secondary">
          No {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} are assigned. Add one in advanced measurement setup to measure this class.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[420px]">
            <caption className="sr-only">Queries assigned to this Property</caption>
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
        <div>
          <h2 id="property-urls" className="text-base font-semibold text-heading">
            URLs that count as this Property
            <InfoTooltip text="A cited source URL is credited to this Property when it matches one of these. The most specific matcher wins, so a URL covered by two Properties at the same specificity is recorded as an ambiguous source-to-Property match instead of being credited to either." />
          </h2>
        </div>
        <p className="supporting-copy">{urls.length} configured</p>
      </div>
      {urls.length === 0 ? (
        <p className="text-sm text-secondary">No URLs are configured for this Property.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[420px]">
            <caption className="sr-only">URL matchers configured for this Property</caption>
            <thead><tr><th>URL</th></tr></thead>
            <tbody>{urls.map(url => <tr key={url}><td className="break-all text-secondary">{url}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function MeasurementPropertyPage() {
  const { projectName, targetKey } = useParams({ strict: false }) as { projectName?: string; targetKey?: string }
  const [queryClass, setQueryClass] = useState<QueryClass>('non-brand')
  const [expandedAnswers, setExpandedAnswers] = useState<ReadonlySet<string>>(new Set<string>())
  const project = projectName ?? ''
  const property = targetKey ?? ''
  const enabled = Boolean(project) && Boolean(property)
  const { canWrite } = useAccount()

  const planQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPlanOptions({ client: heyClient, path: { name: project } }),
    enabled,
  })
  const brandedQuery = useQuery({ ...overviewOptions(project, property, 'branded'), enabled })
  const nonBrandQuery = useQuery({ ...overviewOptions(project, property, 'non-brand'), enabled })

  const brandedRow = propertyRowOf(brandedQuery.data)
  const nonBrandRow = propertyRowOf(nonBrandQuery.data)
  const selected = queryClass === 'branded' ? brandedQuery.data : nonBrandQuery.data
  const selectedRow = queryClass === 'branded' ? brandedRow : nonBrandRow
  const selectedClassError = queryClass === 'branded' ? brandedQuery.isError : nonBrandQuery.isError
  const selectedClassUnavailable = selectedClassError && selectedRow === undefined
  const displayedRunId = selected?.measurement.displayedRunId

  // The engine COUNT is gone from this page: the engine table below states it by
  // listing one row per engine, and a card above restating it was one of the
  // three that made the facts grid repeat its own page. What survives is the
  // reason a class has no numbers at all, which nothing else says once.
  const engineUnmeasuredReason = selectedRow?.mentionCoverage.state === 'unavailable'
    ? reasonText(selectedRow.mentionCoverage)
    : undefined
  // Undefined while the response is unread, so a pending or failed fetch never
  // asserts this Property has never been swept.
  const measuredAt = selected === undefined ? undefined : selected.measurement.completedAt ?? null

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

  const urls = useMemo(() => target?.urlMatchers.map(matcherLabel) ?? [], [target])
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
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-strong"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back to measurement overview
    </Link>
  )

  if (!enabled) {
    return <div className="page-container"><p className="text-sm text-muted">Missing project name or Property key in URL.</p></div>
  }

  // This page is a child route, so the project subnav's tab allowlist never saw
  // it and a direct link reached Advanced Measurement inside an embed that hides
  // the portfolio tab. Presentational, exactly like the subnav filter.
  if (!isEmbedProjectTabAllowed('portfolio', getEmbedConfig()?.projectTabs)) {
    return (
      <div className="page-container">
        <p className="text-sm text-muted">This view is not available here.</p>
      </div>
    )
  }

  if (planQuery.isPending && !planQuery.isError) {
    return (
      <div className="page-container">
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading Property</span>
          <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
        </div>
      </div>
    )
  }

  const planUnavailable = planQuery.isError && planQuery.data === undefined
  const brandedUnavailable = brandedQuery.isError && brandedQuery.data === undefined
  const nonBrandUnavailable = nonBrandQuery.isError && nonBrandQuery.data === undefined
  if (planUnavailable || (brandedUnavailable && nonBrandUnavailable)) {
    return (
      <div className="page-container space-y-3">
        {backLink}
        <p role="alert" className="text-sm text-negative">Could not load this Property.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 px-4 text-sm md:h-11"
          onClick={() => {
            void planQuery.refetch()
            void brandedQuery.refetch()
            void nonBrandQuery.refetch()
          }}
        >
          Try again
        </Button>
      </div>
    )
  }

  if (!planV2 || !target) {
    return (
      <div className="page-container space-y-3">
        {backLink}
        <p role="status" className="text-sm text-secondary">
          {planV2
            ? 'This Property is not in the published setup. It may have been renamed or removed.'
            : 'A Property page needs a published advanced measurement setup. Republish setup from the project Portfolio tab.'}
        </p>
        <Button asChild type="button" variant="outline" className="h-11 px-4 text-sm md:h-11">
          <Link to="/projects/$projectName/portfolio" params={{ projectName: project }}>
            {canWrite ? (legacyPlan ? 'Republish setup' : 'Open measurement setup') : 'View measurement setup'}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="page-container space-y-8">
      <div className="page-header">
        <div className="page-header-left">
          {backLink}
          <h1 className="page-title mt-2">{target.label}</h1>
          <p className="page-subtitle">Property in {project}</p>
        </div>
        <div className="page-header-right">
          {selected ? (
            <ToneBadge tone={MEASUREMENT_STATES[selected.measurement.state].tone}>
              {MEASUREMENT_STATES[selected.measurement.state].label}
            </ToneBadge>
          ) : null}
          {selectedRow && selectedRow.flags > 0 ? (
            <ToneBadge tone="caution">{selectedRow.flags} ambiguous {selectedRow.flags === 1 ? 'match' : 'matches'}</ToneBadge>
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
        onRetry={classToRetry => {
          void (classToRetry === 'branded' ? brandedQuery.refetch() : nonBrandQuery.refetch())
        }}
      />

      {selected && (selected.measurement.state === 'not_measured' || selected.nextAction.kind === 'run_measurement') ? (
        <section className="flex flex-wrap items-center justify-between gap-3 border-y border-default py-4" aria-label="Measurement next step">
          <p className="text-sm text-secondary">
            {canWrite
              ? 'Run a measurement from the project overview to collect this Property’s coverage and source evidence.'
              : 'This Property needs a new measurement before coverage and source evidence are available.'}
          </p>
          <Button asChild type="button" className="h-11 px-4 text-sm md:h-11">
            <Link to="/projects/$projectName" params={{ projectName: project }}>
              {canWrite ? 'Go to measurement overview' : 'View measurement overview'}
            </Link>
          </Button>
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-4 border-y border-default py-4">
        <div className="space-y-1">
          <label htmlFor="property-query-class" className="block text-sm font-medium text-heading">Query type</label>
          <select
            id="property-query-class"
            value={queryClass}
            onChange={event => setQueryClass(event.target.value === 'branded' ? 'branded' : 'non-brand')}
            className="h-11 rounded-md border border-default bg-surface px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-mono-400"
          >
            <option value="non-brand">{CLASS_LABELS['non-brand'].technical}</option>
            <option value="branded">{CLASS_LABELS.branded.technical}</option>
          </select>
        </div>
        <PropertyProvenance
          measuredAt={measuredAt}
          unmeasuredReason={engineUnmeasuredReason}
          queryClass={queryClass}
        />
      </div>

      <ProviderBreakdown row={selectedRow} queryClass={queryClass} isError={selectedClassUnavailable} />
      {/* Directly under coverage, because it is what coverage raises and cannot
          answer. The evidence table below is the receipts; this is the finding. */}
      <NamedInstead project={project} targetKey={property} queryClass={queryClass} />
      <AssignedQuestions questions={questions} queryClass={queryClass} />
      <PropertyUrls urls={urls} />
      <MarketLink project={project} groups={memberGroups} />

      <section aria-labelledby="property-evidence" className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <h2 id="property-evidence" className="text-base font-semibold text-heading">
              Answers the engines gave
              <InfoTooltip text="One row per answer an engine gave for the queries assigned to this Property in the displayed measurement. Mentioned and cited are independent: an answer can name this Property without linking it, or link it without naming it. Answers that did neither are listed first, because those are what a gap is made of. Where the answer text was not stored the mention reads Not measured, never a zero. Open a row to read what the engine actually said, followed by the source URLs it returned, this Property's own first. The answer is where a miss becomes actionable: a query this Property was not named in may still have named a sibling building." />
            </h2>
          </div>
          {evidenceRows.length > 0 ? <p className="supporting-copy">{evidenceRows.length} of {evidenceTotal}</p> : null}
        </div>
        {selectedClassUnavailable ? (
          <p className="text-sm text-secondary">Evidence for {CLASS_LABELS[queryClass].technical.toLocaleLowerCase()} is unavailable. Retry that query type above.</p>
        ) : evidenceQuery.isPending && evidenceRows.length === 0 ? (
          <p className="text-sm text-secondary">Loading evidence…</p>
        ) : evidenceQuery.isError && evidenceRows.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
            <span role="alert">Evidence could not be loaded.</span>
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 text-sm md:h-11" onClick={() => { void evidenceQuery.refetch() }}>Retry evidence</Button>
          </div>
        ) : evidenceState === 'not_measured' ? (
          // Not measured is not "no evidence". Saying "none" here would report
          // an absent measurement as a measured result.
          <p className="text-sm text-secondary">Not measured yet. Run a measurement to collect the answers for this Property.</p>
        ) : evidenceShapeMismatch ? (
          <p role="alert" className="text-sm text-caution">
            This measurement was returned in an older format, so the answers cannot be shown here.
            The numbers above are unaffected.
          </p>
        ) : evidenceRows.length === 0 ? (
          <p className="text-sm text-secondary">No answers matched this Property in the displayed measurement.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border border-default">
              <table className="evidence-table min-w-[720px]">
                <caption className="sr-only">Answers measured for this Property</caption>
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Mentioned in the answer</th>
                    <th>Cited as a source</th>
                    <th>Sources</th>
                    <th><span className="sr-only">Sources detail</span></th>
                  </tr>
                </thead>
                <tbody>
                  {evidenceRows.map(item => {
                    const key = answerKey(item)
                    const expanded = expandedAnswers.has(key)
                    return (
                      <Fragment key={key}>
                        <tr>
                          <td className="text-secondary">
                            <span className="block">{item.queryText}</span>
                            <span className="mt-1 block text-xs text-muted">
                              {[item.provider, item.location].filter(Boolean).join(' · ')}
                            </span>
                            {item.historical || item.bridged ? (
                              <span className="mt-1 flex"><ToneBadge tone="caution">Historical</ToneBadge></span>
                            ) : null}
                          </td>
                          <td><MentionSignal row={item} /></td>
                          <td><CitationSignal row={item} /></td>
                          <td className="tabular-nums text-secondary">{item.cited === null ? EM_DASH : item.sources.length}</td>
                          <td className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-expanded={expanded}
                              onClick={() => setExpandedAnswers(current => {
                                const next = new Set(current)
                                if (!next.delete(key)) next.add(key)
                                return next
                              })}
                            >
                              {expanded ? `Hide the answer for ${item.queryText}` : `Read the answer for ${item.queryText}`}
                            </Button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr>
                            <td colSpan={5} className="bg-surface-subtle px-4">
                              {/* The answer leads. The source list is the supporting
                                  detail, not the point: a reader who opened this row
                                  wants to know what was said before who was linked. */}
                              <AnswerText project={project} targetKey={property} row={item} />
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
                {evidenceQuery.isFetchNextPageError ? <span role="alert">Could not load more evidence.</span> : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-4 text-sm md:h-11"
                  disabled={evidenceQuery.isFetchingNextPage}
                  onClick={() => { void evidenceQuery.fetchNextPage() }}
                >
                  {evidenceQuery.isFetchingNextPage
                    ? 'Loading…'
                    : evidenceQuery.isFetchNextPageError
                      ? 'Retry more evidence'
                      : `Show ${EVIDENCE_PAGE_SIZE} more`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
