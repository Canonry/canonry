/**
 * Shared copy, section order, and small display formatters for the two report
 * renderers.
 *
 * `packages/api-routes/src/report-renderer.ts` (the downloadable HTML report)
 * and `apps/web/src/pages/ReportPage.tsx` (the in-app SPA report) render the
 * same `ProjectReportDto`. The SECTION copy they share lives here, moved
 * verbatim, so the surfaces cannot drift: eyebrows, titles, intros, empty
 * states, card, chart and table titles, table headers, tile labels, notes, and
 * the sentences built from report data. Two sibling modules hold the rest:
 * `report-visibility.ts` (the visibility summary) and `share-of-voice.ts`. The
 * HTML output is pinned byte for byte by
 * `packages/api-routes/test/report-renderer-bytes.test.ts`, and the SPA is held
 * to the same section outline, for both audiences, by
 * `apps/web/test/report-page.test.tsx`.
 *
 * Some copy breaks a current web rule (an em dash, a raw enum badge, a
 * three-sentence intro). It stays word for word here until both renderers
 * change it together.
 *
 * Agency section copy is grouped by the build slice that renders it. A slice
 * that needs a string that is missing adds it inside its own marked region.
 */
import { z } from 'zod'
import { actionConfidenceLabel, contentActionLabel, type ContentTargetRowDto } from './content.js'
import { formatAverageDelta, formatDate, formatDateRange, formatNumber, formatPercent, formatPointDelta, formatSignedPercent, formatSignedPointDelta, type DeltaTone } from './formatting.js'
import { RatioUnits } from './ratio-unit.js'
import { dedupeReportActions, dedupeReportOpportunities } from './report-dedup.js'
import {
  reportActionAudienceSchema,
  reportAudienceSchema,
  reportConfidenceLabel,
  reportHorizonLabel,
  type AiSourceCategoryBucket,
  type GaTrafficSection,
  type IndexingHealthSection,
  type MentionLandscape,
  type ProjectReportDto,
  type ReportActionConfidence,
  type ReportActionHorizon,
  type ReportActionPlanItem,
  type ReportAudience,
  type ReportMetaLocation,
  type ReportProviderMovement,
  type ReportRateDelta,
  type ReportTone,
} from './report.js'
import { SourceCategories } from './source-categories.js'
import { MIN_TREND_POINTS } from './trend-stability.js'
import { visibilityReportResolvedModeSchema } from './visibility-report.js'

const CLIENT_AUDIENCE = reportAudienceSchema.enum.client
const BOTH_AUDIENCES = reportActionAudienceSchema.enum.both
const ADVANCED_MODE = visibilityReportResolvedModeSchema.enum.advanced

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

// ─── Section ids and order ────────────────────────────────────────────────

/**
 * Every section either renderer can show. `share-of-voice` is a slot, not a
 * section: the HTML report writes its notes between sections without an id.
 */
export const reportSectionIdSchema = z.enum([
  'client-summary',
  'executive-summary',
  'share-of-voice',
  'whats-changed',
  'client-action-plan',
  'agency-action-plan',
  'agency-diagnostics',
  'citation-scorecard',
  'competitor-landscape',
  'ai-source-origin',
  'gsc',
  'ga',
  'social-referrals',
  'ai-referrals',
  'server-activity',
  'indexing-health',
  'citations-trend',
  'insights',
  'content-opportunities',
  'content-gaps',
  'recommended-next-steps',
  'client-evidence-summary',
])
export type ReportSectionId = z.infer<typeof reportSectionIdSchema>
export const ReportSectionIds = reportSectionIdSchema.enum

/**
 * The sections one audience's report shows, in order, for this report.
 *
 * Encodes the HTML renderer's assembly and the conditions inside its section
 * functions: an Advanced selection drops the legacy project-wide sections, any
 * visibility selection drops what's changed, the client view hides server
 * activity until a source is connected (the agency view keeps the connect
 * prompt), and content opportunities and gaps appear only when there are some.
 */
export function reportSectionOrder(report: ProjectReportDto, audience: ReportAudience): ReportSectionId[] {
  const visibility = report.visibility
  const advanced = visibility?.selection.mode === ADVANCED_MODE
  const slots: Array<ReportSectionId | null> = audience === CLIENT_AUDIENCE
    ? [
        ReportSectionIds['client-summary'],
        advanced ? null : ReportSectionIds['share-of-voice'],
        visibility ? null : ReportSectionIds['whats-changed'],
        report.serverActivity ? ReportSectionIds['server-activity'] : null,
        ReportSectionIds['client-action-plan'],
        ReportSectionIds['client-evidence-summary'],
      ]
    : [
        visibility ? ReportSectionIds['client-summary'] : ReportSectionIds['executive-summary'],
        advanced ? null : ReportSectionIds['share-of-voice'],
        visibility ? null : ReportSectionIds['whats-changed'],
        ReportSectionIds['agency-action-plan'],
        advanced ? null : ReportSectionIds['agency-diagnostics'],
        advanced ? null : ReportSectionIds['citation-scorecard'],
        advanced ? null : ReportSectionIds['competitor-landscape'],
        ReportSectionIds['ai-source-origin'],
        ReportSectionIds.gsc,
        ReportSectionIds.ga,
        ReportSectionIds['social-referrals'],
        ReportSectionIds['ai-referrals'],
        ReportSectionIds['server-activity'],
        ReportSectionIds['indexing-health'],
        advanced ? null : ReportSectionIds['citations-trend'],
        ReportSectionIds.insights,
        dedupeReportOpportunities(report).length > 0 ? ReportSectionIds['content-opportunities'] : null,
        report.contentGaps.length > 0 ? ReportSectionIds['content-gaps'] : null,
        ReportSectionIds['recommended-next-steps'],
      ]
  return slots.filter((slot): slot is ReportSectionId => slot !== null)
}

// ─── Shared helpers ───────────────────────────────────────────────────────

const PROVIDER_DISPLAY_NAMES: Readonly<Partial<Record<string, string>>> = {
  gemini: 'Gemini',
  openai: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  local: 'Local model',
  'cdp:chatgpt': 'ChatGPT (browser)',
}

/** The engine name a client reads. The agency view shows the raw provider id. */
export function reportProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function reportClientHorizonLabel(horizon: ReportActionHorizon): string {
  switch (horizon) {
    case 'immediate': return 'Do now'
    case 'short-term': return 'This month'
    case 'medium-term': return 'Next quarter'
  }
}

export function reportClientConfidenceLabel(confidence: ReportActionConfidence): string {
  switch (confidence) {
    case 'high': return 'Strong evidence'
    case 'medium': return 'Some evidence'
    case 'low': return 'Worth trying'
  }
}

/** `michigan (Detroit, Michigan, US)`, or the bare label when no place parts are set. Empty for no location. */
export function reportLocationDisplay(location: ReportMetaLocation | null): string {
  if (!location) return ''
  const place = [location.city, location.region, location.country].filter(Boolean).join(', ')
  return place ? `${location.label} (${place})` : location.label
}

export const REPORT_HEADER_COPY = {
  eyebrow: 'AI Visibility Report',
  market: 'Market',
  noMarket: 'No market set',
  generated: 'Generated',
} as const

/** The header's market fragment: `Market: michigan (Detroit, Michigan, US)` or `No market set`. */
export function reportHeaderMarketLabel(location: ReportMetaLocation | null): string {
  return location ? `${REPORT_HEADER_COPY.market}: ${reportLocationDisplay(location)}` : REPORT_HEADER_COPY.noMarket
}

export function reportHeaderPeriodLabel(periodDays: number): string {
  return `Last ${periodDays} days`
}

/** `a, b, c, +2 more`. */
export function reportCompactList(items: readonly string[], limit = 3): string {
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  return `${visible.join(', ')}${more > 0 ? `, +${more} more` : ''}`
}

/** `a, b, c, d, e…` */
export function reportTruncatedList(items: readonly string[], limit: number): string {
  return `${items.slice(0, limit).join(', ')}${items.length > limit ? '…' : ''}`
}

/**
 * The chip that stands in for the proof items a card did not show: `+2 more`.
 *
 * Both renderers draw that chip, and neither outline golden records chip text,
 * so an inline copy on each side could be reworded on one surface and stay
 * unnoticed on the other.
 */
export function reportMoreChipLabel(count: number): string {
  return `+${count} more`
}

/** The chip beside a row that fired more than once: `× 3`. */
export function reportInstanceCountLabel(count: number): string {
  return `× ${count}`
}

/** Accessible name of a bar chart: `<title> bar chart`. */
export function reportBarChartLabel(title: string): string {
  return `${title} bar chart`
}

/** Accessible name of a line chart: `<title> line chart`. */
export function reportLineChartLabel(title: string): string {
  return `${title} line chart`
}

export function reportDeltaArrow(direction: ReportRateDelta['direction']): string {
  if (direction === 'up') return '↑'
  if (direction === 'down') return '↓'
  return '→'
}

export function reportDirectionTone(direction: ReportRateDelta['direction']): DeltaTone {
  if (direction === 'up') return 'positive'
  if (direction === 'down') return 'negative'
  return 'neutral'
}

/**
 * The magnitude of a report rate's change, in percentage points: `15.0`,
 * `<0.1`, or `0`. The report's rates are 0..100 on the wire, so the change is
 * already in points.
 */
function reportPointChangeMagnitude(deltaPoints: number): string {
  return formatPointDelta(deltaPoints, RatioUnits.percent).magnitude
}

/** A report rate's change, signed, in percentage points: `+15.0 pts`, `-3.5 pts`, `0 pts`. */
function reportPointChange(deltaPoints: number): string {
  return formatSignedPointDelta(deltaPoints, RatioUnits.percent)
}

/** A what's-changed tile value: `65.0%` for a rate, the raw average for a count. */
export function reportRateDeltaValue(delta: Pick<ReportRateDelta, 'current'>, unit: '%' | 'count'): string {
  return unit === '%' ? formatPercent(delta.current, RatioUnits.percent) : String(delta.current)
}

/** A what's-changed tile subtitle: `+15.0 pts vs 50.0%` for a rate, the shared smart-% copy for a count. */
export function reportRateDeltaCopy(delta: Pick<ReportRateDelta, 'deltaAbs' | 'prior' | 'deltaPct'>, unit: '%' | 'count'): string {
  return unit === '%'
    ? `${reportPointChange(delta.deltaAbs)} vs ${formatPercent(delta.prior, RatioUnits.percent)}`
    : formatAverageDelta(delta)
}

/** A provider movement's change cell: `+15.0 pts ↑`. */
export function reportMovementChangeCopy(movement: Pick<ReportProviderMovement, 'deltaAbs' | 'direction'>): string {
  return `${reportPointChange(movement.deltaAbs)} ${reportDeltaArrow(movement.direction)}`
}

/** `vs prior 14 days`: the window a traffic or server-activity delta compares against. */
export function reportPriorWindowLabel(days: number): string {
  return `vs prior ${days} days`
}

export interface ReportClientTrendCopy {
  text: string
  tone: DeltaTone
  arrow: string
}

/**
 * The client hero's trend line. When the delta averages several checks it says
 * so, so a reader does not take a rolling average for a single-check snapshot.
 */
export function reportClientTrendCopy(delta: ReportRateDelta | null): ReportClientTrendCopy | null {
  if (!delta) return null
  const checks = delta.window ?? 1
  const prior = formatPercent(delta.prior, RatioUnits.percent)
  const compare = checks >= 2 ? `vs prior ${checks} checks (avg ${prior})` : `since last check (was ${prior})`
  const arrow = reportDeltaArrow(delta.direction)
  if (delta.direction === 'up') return { text: `Up ${reportPointChangeMagnitude(delta.deltaAbs)} points ${compare}`, tone: 'positive', arrow }
  if (delta.direction === 'down') return { text: `Down ${reportPointChangeMagnitude(delta.deltaAbs)} points ${compare}`, tone: 'negative', arrow }
  return { text: `Holding steady ${compare}`, tone: 'neutral', arrow }
}

// ─── Shared section copy: client view, what's changed, action plans ───────

const SHARED_SECTION_COPY = {
  'client-summary': {
    heroEyebrow: 'Overview',
    heroEmpty: 'No AI check has been run yet. Run a check to see how AI tools answer customer queries about your business.',
    tiles: {
      mentioned: 'AI mentions your name',
      cited: 'AI links to your website',
      providers: 'AI tools tested',
    },
    noData: 'No data yet',
    explainer: {
      lead: 'Mentions and links are different.',
      mention: { article: 'A', term: 'mention', definition: 'is when AI says your name out loud in its answer.' },
      link: { article: 'A', term: 'link', definition: 'is when AI lists your website as a source it used.' },
      closing: "AI can do either, both, or neither — that's why we track both.",
    },
    queriesHeading: 'Customer queries we tested',
    providerBarsHeading: 'How often each AI tool mentions you',
    providerBarsSubtitle: 'Higher is better. Each bar shows the share of customer queries where the AI named you in the answer.',
  },
  'whats-changed': {
    client: {
      eyebrow: 'Since last check',
      title: "What's different since last check",
      empty: 'No comparison yet — trends will appear after a few more checks.',
      tiles: {
        mentionRate: 'AI mentions your name',
        citationRate: 'AI links to your website',
        mentionedQueryCount: 'Queries AI mentioned you in',
        gscClicks: 'Visitors from Google',
        aiReferrals: 'Visitors from AI tools',
      },
      gscCountLabel: 'visits',
      aiReferralsCountLabel: 'visits',
      movementsHeading: 'How each AI tool changed',
      movementHeaders: ['AI tool', 'Was', 'Now', 'Change'],
      winsHeading: 'What got better',
      winsEmpty: 'No new wins this period.',
      regressionsHeading: 'What got worse',
      regressionsEmpty: 'Nothing got worse this period.',
      insightHeaders: ['What changed', 'Customer query', 'AI tool'],
    },
    agency: {
      eyebrow: 'Section 2',
      title: "What's Changed",
      empty: 'Trends will appear after a few more checks.',
      tiles: {
        citationRate: 'Citation rate',
        mentionRate: 'Mention rate',
        citedQueryCount: 'Cited queries',
        gscClicks: 'GSC clicks',
        aiReferrals: 'AI referral sessions',
      },
      gscCountLabel: 'clicks',
      aiReferralsCountLabel: 'sessions',
      movementsHeading: 'AI engine movements',
      movementHeaders: ['Engine', 'Prior', 'Current', 'Change'],
      winsHeading: 'Wins',
      winsEmpty: 'No new gains in the latest check.',
      regressionsHeading: 'Regressions',
      regressionsEmpty: 'No new regressions in the latest check.',
      insightHeaders: ['Severity', 'Title', 'Query', 'Provider'],
    },
    rateTileEmpty: 'No prior data',
    trafficTileEmpty: 'Not enough trend data',
  },
  'client-action-plan': {
    eyebrow: 'Action plan',
    title: 'What to do next',
    intro: 'Approve these in order. They are sorted by what will move the needle fastest.',
    empty: 'No recommendations yet — run an AI check to populate this.',
    rankTitle: 'Priority — 1 will move the needle fastest',
    detailsSummary: 'See the data behind this',
    whyLabel: 'Why this matters',
    evidenceLabel: 'What we saw',
    successLabel: 'What success looks like:',
  },
  'agency-action-plan': {
    eyebrow: 'Agency actions',
    title: 'Agency Action Plan',
    intro: 'The highest-leverage work, sorted by urgency and evidence strength.',
    empty: 'No prioritized actions yet.',
    rankTitle: 'Impact rank — 1 is the highest-leverage action',
    detailsSummary: 'Evidence details',
    whyLabel: 'Why',
    evidenceLabel: 'Evidence',
    successLabel: 'Win condition:',
  },
  'client-evidence-summary': {
    eyebrow: 'What we based this on',
    title: 'The signals behind this plan',
    intro: 'The data behind the recommendations above. Switch to Agency for the full breakdowns.',
    empty: 'No supporting evidence yet — this fills in after the first AI check.',
    sources: {
      heading: 'Where AI gets its answers',
      subtitle: 'The websites AI tools cited most often when answering customer queries about your industry.',
      competitorTag: '(competitor)',
    },
    indexing: {
      heading: 'Pages Google can find on your site',
      subtitle: 'Google indexing your site increases the chances of it appearing in AI search (especially Gemini).',
    },
    search: {
      heading: 'What people search Google for',
      subtitleLead: 'You appeared in',
      subtitleMiddle: 'Google searches and got',
      subtitleTail: 'this period.',
    },
    opportunities: {
      heading: 'Topics where you could improve',
      subtitle: 'Customer queries where better content on your site would help AI cite you.',
      cededTag: 'Ceded surface',
    },
  },
} as const

/** The client hero sentence, or the pre-first-check fallback. */
export function reportClientHeroSentence(totalQueries: number, mentionedQueries: number | null): string {
  if (!(totalQueries > 0)) return SHARED_SECTION_COPY['client-summary'].heroEmpty
  return `When customers asked AI ${totalQueries} ${pluralize(totalQueries, 'query', 'queries')} about your industry, AI mentioned you in ${mentionedQueries} of ${totalQueries === 1 ? 'them' : 'those queries'}.`
}

export function reportClientMentionedSubtitle(mentionedQueries: number | null, totalQueries: number): string {
  return totalQueries > 0
    ? `Says your name in ${mentionedQueries} of ${totalQueries} ${pluralize(totalQueries, 'query', 'queries')}`
    : SHARED_SECTION_COPY['client-summary'].noData
}

export function reportClientCitedSubtitle(citedQueries: number | null, totalQueries: number): string {
  return totalQueries > 0
    ? `Cites your site as a source in ${citedQueries} of ${totalQueries} ${pluralize(totalQueries, 'query', 'queries')}`
    : SHARED_SECTION_COPY['client-summary'].noData
}

/** The engines tested, by display name, or the query count when no engine has run. */
export function reportClientProvidersSubtitle(providers: readonly string[], queryCount: number): string {
  return providers.length > 0
    ? providers.map(provider => reportProviderDisplayName(provider)).join(', ')
    : `${formatNumber(queryCount)} ${pluralize(queryCount, 'query', 'queries')} tested`
}

export function reportClientQueriesSubtitle(queryCount: number): string {
  return `These are the ${queryCount} ${pluralize(queryCount, 'query we asked', 'queries we asked')} every AI tool. The numbers above measure how often you came up.`
}

/**
 * The actions one audience's plan shows: the client shortlist, or the agency
 * priorities (falling back to the plan items meant for the agency), with
 * market-modified duplicates collapsed.
 */
export function reportAudienceActions(report: ProjectReportDto, audience: ReportAudience): ReportActionPlanItem[] {
  const actions = audience === CLIENT_AUDIENCE
    ? report.clientSummary.actionItems
    : report.agencyDiagnostics.priorities.length > 0
      ? report.agencyDiagnostics.priorities
      : report.actionPlan.filter(action => action.audience === BOTH_AUDIENCES || action.audience === audience)
  return dedupeReportActions(report, actions)
}

export function reportActionHorizonBadge(audience: ReportAudience, horizon: ReportActionHorizon): string {
  return audience === CLIENT_AUDIENCE ? reportClientHorizonLabel(horizon) : reportHorizonLabel(horizon)
}

export function reportActionConfidenceBadge(audience: ReportAudience, confidence: ReportActionConfidence): string {
  return audience === CLIENT_AUDIENCE ? reportClientConfidenceLabel(confidence) : `${reportConfidenceLabel(confidence)} confidence`
}

/** `4×`: how many times AI cited a source. */
export function reportClientSourceCount(count: number): string {
  return `${formatNumber(count)}×`
}

export function reportClientIndexedPages(indexed: number, total: number): string {
  return `${formatNumber(indexed)} of ${formatNumber(total)} pages indexed`
}

/** The words after the not-indexed count: `pages are not indexed yet.` */
export function reportClientNotIndexedTail(notIndexed: number): string {
  return `${pluralize(notIndexed, 'page is', 'pages are')} not indexed yet.`
}

export function reportClientClicksNoun(clicks: number): string {
  return pluralize(clicks, 'click')
}

export function reportClientSearchCount(impressions: number): string {
  return `${formatNumber(impressions)} ${pluralize(impressions, 'search', 'searches')}`
}

/** Tone for the client's indexed share: 90% and up positive, 70% and up caution, otherwise negative. */
export function reportClientIndexingTone(indexedPct: number): ReportTone {
  if (indexedPct >= 90) return 'positive'
  if (indexedPct >= 70) return 'caution'
  return 'negative'
}

// ── report slice S1: agency overview ──
const AGENCY_OVERVIEW_COPY = {
  'executive-summary': {
    eyebrow: 'Section 1',
    title: 'Executive Summary',
    intro: 'Citation = source list. Mention = answer text. They are independent signals.',
    heroKicker: 'Latest AI visibility check',
    emptyTitle: 'No AI citation data yet',
    emptySubtitle: 'Run a check to populate the first citation and mention baseline.',
    noQueries: 'no queries',
    proofTiles: {
      citationTrend: 'Citation trend',
      mentionCoverage: 'Mention coverage',
      prioritizedActions: 'Prioritized actions',
    },
    prioritizedActionsCopy: 'Sorted for agency follow-up.',
    tiles: {
      citationRate: 'Citation rate',
      mentionRate: 'Mention rate',
      queriesTracked: 'Queries tracked',
      gscClicks: 'GSC clicks',
      gaSessions: 'GA sessions',
    },
    trendLabels: { up: '↑ Up', down: '↓ Down', flat: '→ Flat', unknown: '—' },
    marketScope: {
      heading: 'Market Scope',
      currentLabel: 'Current check',
      currentCopy: 'All findings below are scoped to this run.',
      notIncludedLabel: 'Not included',
      providerLabel: 'Provider context',
      noOtherMarkets: 'None',
      noProviders: '—',
      singleMarketCopy: 'Single-market report; findings can be read as the current market view.',
      noMarketCopy: 'No geographic hint was attached to this check; read findings as default-market or national results.',
      noProviderMetadataCopy: 'No provider-level location metadata is available for this report.',
      warningTitle: 'Location handling needs review',
      warningDetail: 'used weak or indirect market handling. Treat provider-level differences cautiously.',
    },
  },
  'agency-diagnostics': {
    eyebrow: 'Agency diagnostics',
    title: 'Technical Diagnostics',
    intro: 'Fast-read operator flags behind the action plan.',
    empty: 'No agency diagnostics available yet.',
    /** Legacy diagnostics with this title are hidden: the market scope card covers them. */
    hiddenTitle: 'Location caveat',
  },
  'recommended-next-steps': {
    eyebrow: 'Section 16',
    title: 'Recommended Next Steps',
    intro: 'Action items bucketed by timing.',
    empty: 'No outstanding actions.',
  },
} as const

export interface ReportExecutiveHeadline {
  /** `↑ Up`, `↓ Down`, `→ Flat`, or `—` before a comparison exists. */
  trendLabel: string
  trendTone: DeltaTone
  title: string
  subtitle: string
  /** `3/5 queries cited`, or `no queries`. */
  citedFragment: string
  /** `2/5 queries mentioned`, or `no queries`. */
  mentionedFragment: string
  /** Deduplicated agency priorities, or the whole action plan when there are none. */
  prioritizedActionCount: number
  /** `2 providers`. */
  providerCountLabel: string
  /** `3 competitors tracked`. */
  competitorCountLabel: string
  /** GSC clicks tile subtitle: `5.0K imp · 20.0% CTR · Apr 1, 2026 → Apr 30, 2026`. Null without GSC. */
  gscDelta: string | null
  /** GA sessions tile subtitle: `9.0K users · Apr 1, 2026 → Apr 30, 2026`. Null without GA. */
  gaDelta: string | null
}

/** Every data-driven string in the executive summary hero and metric tiles. */
export function reportExecutiveHeadline(report: ProjectReportDto): ReportExecutiveHeadline {
  const copy = AGENCY_OVERVIEW_COPY['executive-summary']
  const summary = report.executiveSummary
  const trend = summary.trend
  const trendLabel = trend === 'up' ? copy.trendLabels.up
    : trend === 'down' ? copy.trendLabels.down
      : trend === 'flat' ? copy.trendLabels.flat
        : copy.trendLabels.unknown
  const trendTone: DeltaTone = trend === 'up' ? 'positive' : trend === 'down' ? 'negative' : 'neutral'
  const hasQueries = (summary.totalQueryCount ?? 0) > 0
  const queryNoun = summary.totalQueryCount === 1 ? 'query' : 'queries'
  const priorities = report.agencyDiagnostics.priorities.length > 0 ? report.agencyDiagnostics.priorities : report.actionPlan
  const gscDateRange = summary.gsc ? reportGscDateRange(report) : ''
  return {
    trendLabel,
    trendTone,
    title: hasQueries
      ? `${summary.citedQueryCount} of ${summary.totalQueryCount} tracked ${queryNoun} cite ${report.meta.project.displayName}`
      : copy.emptyTitle,
    subtitle: hasQueries
      ? `${formatPercent(summary.citationRate, RatioUnits.percent)} citation coverage and ${formatPercent(summary.mentionRate, RatioUnits.percent)} mention coverage across ${summary.providerCount} ${pluralize(summary.providerCount, 'provider')}.`
      : copy.emptySubtitle,
    citedFragment: hasQueries ? `${summary.citedQueryCount}/${summary.totalQueryCount} ${queryNoun} cited` : copy.noQueries,
    mentionedFragment: hasQueries ? `${summary.mentionedQueryCount}/${summary.totalQueryCount} ${queryNoun} mentioned` : copy.noQueries,
    prioritizedActionCount: dedupeReportActions(report, priorities).length,
    providerCountLabel: `${summary.providerCount} provider${summary.providerCount === 1 ? '' : 's'}`,
    competitorCountLabel: `${summary.competitorCount} competitor${summary.competitorCount === 1 ? '' : 's'} tracked`,
    gscDelta: summary.gsc
      ? `${formatNumber(summary.gsc.impressions)} imp · ${formatPercent(summary.gsc.ctr)} CTR${gscDateRange ? ` · ${gscDateRange}` : ''}`
      : null,
    gaDelta: summary.ga
      ? `${formatNumber(summary.ga.users)} users · ${formatDate(summary.ga.periodStart)} → ${formatDate(summary.ga.periodEnd)}`
      : null,
  }
}

export interface ReportMarketScope {
  /** The market this run was scoped to, or `No market set`. */
  currentValue: string
  /** Other configured markets (up to four, then `+N more`), or `None`. */
  notIncludedValue: string
  notIncludedCopy: string
  /** How many providers reported location handling, or `—`. */
  providerValue: string
  providerCopy: string
  /** Providers that ignored the market or used browser geolocation, for the warning; null when none did. */
  weakProviders: string | null
}

/** The executive summary's market scope card, or null when the report has neither a market nor provider location data. */
export function reportMarketScope(report: ProjectReportDto): ReportMarketScope | null {
  const copy = AGENCY_OVERVIEW_COPY['executive-summary'].marketScope
  const location = report.meta.location
  const handling = report.meta.providerLocationHandling
  if (!location && handling.length === 0) return null
  const otherLocations = location?.otherConfiguredLabels ?? []
  const weak = handling
    .filter(entry => entry.treatment === 'ignored' || entry.treatment === 'browser-geo')
    .map(entry => entry.provider)
  return {
    currentValue: location ? reportLocationDisplay(location) : REPORT_HEADER_COPY.noMarket,
    notIncludedValue: otherLocations.length > 0 ? reportCompactList(otherLocations, 4) : copy.noOtherMarkets,
    notIncludedCopy: location
      ? otherLocations.length > 0
        ? `${otherLocations.length} configured ${pluralize(otherLocations.length, 'market')} still ${otherLocations.length === 1 ? 'needs' : 'need'} a matching check before cross-market recommendations.`
        : copy.singleMarketCopy
      : copy.noMarketCopy,
    providerValue: handling.length > 0 ? formatNumber(handling.length) : copy.noProviders,
    providerCopy: handling.length > 0
      ? weak.length > 0
        ? `${weak.length} ${pluralize(weak.length, 'provider')} need a closer location check.`
        : `${handling.length} ${pluralize(handling.length, 'provider')} received the market context.`
      : copy.noProviderMetadataCopy,
    weakProviders: weak.length > 0 ? reportCompactList(weak, 4) : null,
  }
}
// ── end report slice S1 ──

// ── report slice S2: competitive evidence ──
const COMPETITIVE_EVIDENCE_COPY = {
  'citation-scorecard': {
    eyebrow: 'Section 3',
    title: 'Citation Scorecard',
    intro: 'Per-engine citation and mention coverage from the latest check.',
    providerChartTitle: 'Provider citation rate',
    empty: 'Run a check to populate the citation matrix.',
    queryHeader: 'Query',
    /** Two-glyph matrix cells: citation first, then mention. */
    glyphs: { cited: 'C', notCited: 'c', mentioned: 'M', notMentioned: 'm', pending: '–', missingCell: '— —' },
    legend: {
      lead: 'Legend:',
      citedMeaning: '= cited/not,',
      mentionedMeaning: '= mentioned/not,',
      pendingMeaning: '= no data.',
    },
  },
  'competitor-landscape': {
    eyebrow: 'Section 4',
    title: 'Competitor Landscape',
    intro: 'Who AI engines cite and mention instead of the client.',
    empty: 'No competitor data yet. Add competitors and run a check.',
    noCompetitors: 'No competitors configured.',
    citationsChartTitle: 'Citations per domain',
    brandedChartTitle: 'Mentions per domain · branded queries',
    headers: {
      domain: 'Domain',
      pressure: 'Pressure',
      citations: 'Citations',
      citationShare: 'Citation share',
      citedQueries: 'Cited queries',
    },
    citationShareTooltip: 'Citation share — % of cited-source slots that went to this competitor across tracked queries. Distinct from Mention Share.',
  },
  'ai-source-origin': {
    eyebrow: 'Section 5',
    title: 'AI Citation Sources',
    intro: 'External domains AI engines cited most in the latest check.',
    empty: 'No source data yet. Run a check first.',
    topSourcesHeading: 'Top sources',
    topSourceHeaders: ['Domain', 'Citations', 'Tag'],
    trackedCompetitorTag: 'Tracked competitor',
    externalTag: 'External',
    categoriesHeading: 'By source type',
  },
} as const

/** A provider bar's value: `50.0% (1/2)`. */
export function reportProviderRateLabel(rate: { citationRate: number; citedCount: number; totalCount: number }): string {
  return `${formatPercent(rate.citationRate, RatioUnits.percent)} (${rate.citedCount}/${rate.totalCount})`
}

const MENTION_SCOPE_LABELS: Readonly<Partial<Record<string, string>>> = {
  'non-brand': 'non-brand queries',
  pooled: 'pooled queries · classification unavailable',
}

/** The query class a mention figure must carry; a scope an older server sends reads as pooled. */
export function reportMentionScopeLabel(scope: MentionLandscape['scope']): string {
  return MENTION_SCOPE_LABELS[scope] ?? 'pooled queries · classification unavailable'
}

export interface ReportCompetitorMentionCopy {
  scopeLabel: string
  /** `Mentions (non-brand queries)`. */
  mentionsHeader: string
  mentionsTooltip: string
  /** `Mentions per domain · non-brand queries`. */
  mentionsChartTitle: string
  mentionShareUnavailable: string
  brandedNote: string
}

/** The competitor landscape's class-labelled mention header, tooltip, chart title and notes. */
export function reportCompetitorMentionCopy(mentionLandscape: Pick<MentionLandscape, 'scope' | 'branded'>): ReportCompetitorMentionCopy {
  const scopeLabel = reportMentionScopeLabel(mentionLandscape.scope)
  // `canonry report` renders locally from whatever the API returned, so a CLI
  // newer than its server can see a payload without the branded split.
  const branded = mentionLandscape.branded as MentionLandscape['branded'] | undefined
  return {
    scopeLabel,
    mentionsHeader: `Mentions (${scopeLabel})`,
    mentionsTooltip: mentionLandscape.scope === 'non-brand'
      ? `Mentions on ${scopeLabel}. Branded queries are counted separately — the client is named on nearly all of them and a competitor cannot be, so pooling the two would rank the client on its own brand recall.`
      : `Mentions on ${scopeLabel}. The project has no usable brand identity for a branded/non-brand split, so all tracked queries remain pooled and this is not a competitive category read.`,
    mentionsChartTitle: `Mentions per domain · ${scopeLabel}`,
    mentionShareUnavailable: `Mention share unavailable for ${scopeLabel}: no tracked brand was named, so the denominator is 0.`,
    brandedNote: `Branded queries contain the client's own name. The client is named on nearly all of them and a competitor structurally cannot be, so these are kept out of the competitive figure above. Read them as brand recall: ${branded?.projectMentionCount ?? 0} of ${branded?.totalAnswerSnapshots ?? 0} branded answers named the client.`,
  }
}

/** `1 cited URL`, `2 cited URLs`. */
export function reportCitedUrlCount(count: number): string {
  return `${count} cited URL${count > 1 ? 's' : ''}`
}

export interface ReportSourceOriginHeadline {
  /** `20.0%`, shown emphasized. */
  share: string
  /** `of citations went to tracked competitors (2 of 10).` */
  detail: string
}

/** The source-origin headline, shown only when a tracked-competitor bucket exists. */
export function reportSourceOriginHeadline(categories: readonly AiSourceCategoryBucket[]): ReportSourceOriginHeadline | null {
  const competitor = categories.find(category => category.category === SourceCategories.competitor)
  if (!competitor) return null
  const total = categories.reduce((sum, category) => sum + category.count, 0)
  return { share: formatPercent(competitor.sharePct, RatioUnits.percent), detail: `of citations went to tracked competitors (${competitor.count} of ${total}).` }
}

/** A source-type bar's share: `(20.0%)`. */
export function reportSourceCategoryShareLabel(sharePct: number): string {
  return `(${formatPercent(sharePct, RatioUnits.percent)})`
}
// ── end report slice S2 ──

// ── report slice S3: search and traffic ──
const SEARCH_TRAFFIC_COPY = {
  gsc: {
    eyebrow: 'Section 6',
    title: 'GSC Performance',
    empty: 'Connect Google Search Console to populate this section.',
    tiles: {
      clicks: 'Total clicks',
      impressions: 'Total impressions',
      ctr: 'Avg CTR',
      position: 'Avg position',
    },
    trendTitle: 'Clicks over time',
    topQueriesHeading: 'Top queries',
    topQueryHeaders: ['Query', 'Clicks', 'Imp.', 'CTR', 'Pos.', 'Category'],
    intentHeading: 'Search demand by intent',
    intentCountLabel: 'clicks',
    untrackedDemand: {
      heading: 'AEO queries without search demand',
      subtitle: 'Review whether these still belong in the tracking set.',
    },
    suggestedQueries: {
      heading: 'Search queries you should track',
      subtitle: 'High-impression candidates to add to AEO tracking.',
    },
  },
  ga: {
    eyebrow: 'Section 7',
    title: 'GA4 Traffic',
    empty: 'Connect Google Analytics 4 to populate this section.',
    tiles: {
      sessions: 'Total sessions',
      users: 'Total users',
      organicSessions: 'Organic sessions',
    },
    topPagesHeading: 'Top landing pages',
    topPageHeaders: ['Page', 'Sessions', 'Organic'],
    channelsHeading: 'Channel mix',
    channelsCountLabel: 'sessions',
  },
  'social-referrals': {
    eyebrow: 'Section 8',
    title: 'Social Referrals',
    intro: 'Social traffic split by channel and campaign.',
    empty: 'No social referral data yet.',
    tiles: {
      sessions: 'Total sessions',
      organic: 'Organic social',
      paid: 'Paid social',
    },
    channelsHeading: 'Social channel mix',
    channelsCountLabel: 'sessions',
    campaignsHeading: 'Top campaigns',
    campaignHeaders: ['Source', 'Medium', 'Sessions'],
  },
  'ai-referrals': {
    eyebrow: 'Section 9',
    title: 'AI Referral Traffic',
    intro: 'Traffic arriving from AI answer engines.',
    empty: 'No AI referral traffic detected yet.',
    tiles: {
      sessions: 'Total sessions',
    },
    trendTitle: 'AI referral sessions over time',
    sourcesHeading: 'AI sessions by source',
    sourcesCountLabel: 'sessions',
    topPagesHeading: 'Top AI landing pages',
    topPageHeaders: ['Page', 'Sessions'],
  },
} as const

/** The GSC reporting window: the summary's window, else the section's, else the trend's first and last days. */
export function reportGscDateRange(report: Pick<ProjectReportDto, 'executiveSummary' | 'gsc'>): string {
  const summary = report.executiveSummary.gsc
  const gsc = report.gsc
  const start = summary?.periodStart || gsc?.periodStart || gsc?.trend.at(0)?.date || ''
  const end = summary?.periodEnd || gsc?.periodEnd || gsc?.trend.at(-1)?.date || ''
  return formatDateRange(start, end)
}

export function reportGscIntro(report: Pick<ProjectReportDto, 'executiveSummary' | 'gsc'>): string {
  const dateRange = reportGscDateRange(report)
  return `Search demand signals to compare against AI visibility${dateRange ? ` for ${dateRange}` : ''}.`
}

export function reportGaIntro(ga: Pick<GaTrafficSection, 'periodStart' | 'periodEnd'>): string {
  return `Site traffic from ${formatDate(ga.periodStart)} to ${formatDate(ga.periodEnd)}.`
}

/** A share bar's detail after the count: `clicks · 80.0%`. */
export function reportShareBarShareLabel(countLabel: string, sharePct: number): string {
  return `${countLabel} · ${formatPercent(sharePct, RatioUnits.percent)}`
}
// ── end report slice S3 ──

// ── report slice S4: server-side, indexing and trend ──
const SERVER_TRENDS_COPY = {
  'server-activity': {
    title: 'AI Visibility — Server-Side',
    client: {
      eyebrow: 'AI engine attention',
      introNoData: 'Live telemetry from your server logs.',
      empty: 'Your server-side traffic source is connected. Numbers will appear after the next sync.',
      tiles: {
        botRequests: 'AI bot requests observed',
        userFetches: 'AI user-fetch requests',
        referralSessions: 'AI referral sessions',
      },
      userFetchFallback: 'ChatGPT-User, Perplexity-User, MistralAI-User',
      operatorsHeading: 'By AI tool',
      operatorsFootnote: 'Bot requests are bulk crawl (GPTBot, PerplexityBot, …). User fetches are on-demand reads triggered by real users inside an AI surface (ChatGPT-User, Perplexity-User, …). Verified means the request came from an IP the operator publishes as its own; unverified means the user-agent matched but the IP is not in a published range. User-fetch totals count both, since many genuine user fetches come from outside any published range.',
    },
    agency: {
      eyebrow: 'Section 10',
      intro: 'What AI engines actually do in your server logs — direct evidence, complementary to citations (which measure what they say).',
      emptyNotConnected: 'Connect a server-side traffic source to surface what AI engines do directly in your server logs — distinct from GA4 click-throughs.',
      empty: 'Source connected — collecting your first data. Numbers will appear after the next sync.',
      operatorsHeading: 'Per AI operator',
      operatorsNote: "Verified means the request's source IP falls inside the operator's published range. Unverified bots claim the user-agent but the IP is not in a published range, so it could be the real bot or an imitator. User fetches are on-demand reads from an AI surface on behalf of a real user (ChatGPT-User, Perplexity-User, …), disjoint from bulk crawl and counted whether or not the IP can be verified.",
      noDelta: '—',
      crawledPathsHeading: 'Top crawled paths',
      crawledPathHeaders: ['Path', 'Hits', 'Verified', 'Distinct operators'],
      referralProductsHeading: 'AI-referral sessions by product',
      referralProductsNote: 'Where humans landed coming from each AI product (chatgpt.com, claude.ai, …).',
      referralProductHeaders: ['Product', 'Sessions', 'Distinct landing paths'],
      referralLandingHeading: 'Top AI-referral landing paths',
      referralLandingHeaders: ['Path', 'Sessions', 'Distinct products'],
    },
    /** The noun `formatDeltaCopy` puts after the prior-window count. */
    countNouns: {
      requests: 'requests',
      hits: 'hits',
      sessions: 'sessions',
    },
  },
  'indexing-health': {
    eyebrow: 'Section 11',
    title: 'Indexing Health',
    empty: 'Connect Google Search Console or Bing Webmaster Tools and run a sitemap inspection.',
    tiles: {
      indexed: 'Indexed',
      total: 'Total inspected',
      share: 'Indexed share',
    },
    coverageHeading: 'Coverage breakdown',
    coverageLabel: 'Coverage stacked bar',
    segments: {
      indexed: 'Indexed',
      notIndexed: 'Not indexed',
      deindexed: 'Deindexed',
      unknown: 'Unknown',
    },
  },
  'citations-trend': {
    eyebrow: 'Section 12',
    title: 'Citations Over Time',
    intro: 'Citation coverage across recent checks.',
    empty: 'Run multiple checks to see a trend.',
    chartTitle: 'Overall citation rate',
    breakdownHeading: 'Check-by-check breakdown',
    breakdownHeaders: ['Check', 'Cited queries', 'Per-engine rates'],
  },
} as const

export interface ReportSectionHeading {
  id: ReportSectionId
  eyebrow: string
  title: string
  intro: string
}

/** Server activity's heading, which differs by audience and, for the client, by whether data has synced. */
export function reportServerActivityHeading(audience: ReportAudience, hasData: boolean, windowDays: number): ReportSectionHeading {
  const copy = SERVER_TRENDS_COPY['server-activity']
  const isClient = audience === CLIENT_AUDIENCE
  return {
    id: ReportSectionIds['server-activity'],
    eyebrow: isClient ? copy.client.eyebrow : copy.agency.eyebrow,
    title: copy.title,
    intro: isClient
      ? hasData
        ? `What AI engines actually do in your server logs over the last ${windowDays} days — the other half of citations.`
        : copy.client.introNoData
      : copy.agency.intro,
  }
}

/** `7d`. */
export function reportServerActivityWindowLabel(windowDays: number): string {
  return `${windowDays}d`
}

export function reportServerActivityClientOperatorHeaders(windowDays: number): readonly [string, string, string, string] {
  const window = reportServerActivityWindowLabel(windowDays)
  return ['AI tool', `Bot requests (${window})`, `User fetches (${window})`, 'Referral sessions']
}

export function reportServerActivityAgencyTiles(windowDays: number): { verified: string; unverified: string; userFetches: string; referralSessions: string } {
  const window = reportServerActivityWindowLabel(windowDays)
  return {
    verified: `Verified crawler hits (${window})`,
    unverified: `Unverified crawler hits (${window})`,
    userFetches: `AI user-fetch hits (${window})`,
    referralSessions: `AI-referral sessions (${window})`,
  }
}

export function reportServerActivityAgencyOperatorHeaders(windowDays: number): readonly [string, string, string, string, string, string] {
  return ['Operator', 'Verified hits', 'Unverified', 'User fetches', 'Referral sessions', `${reportServerActivityWindowLabel(windowDays)} delta`]
}

export function reportServerActivityTrendTitle(windowDays: number): string {
  return `Verified crawler hits over time (last ${windowDays} days)`
}

export function reportServerActivityCrawledPathsNote(windowDays: number): string {
  return `Pages AI bots fetched most often (verified only, last ${reportServerActivityWindowLabel(windowDays)}).`
}

/**
 * An operator's prior-window change, signed, from the API's percent-unit
 * `deltaPct`: `+75.0%`, `-33.3%`, `0%`. With no prior window to compare
 * against it is a dash.
 */
export function reportServerActivityOperatorDelta(deltaPct: number | null): string {
  if (deltaPct === null) return SERVER_TRENDS_COPY['server-activity'].agency.noDelta
  return formatSignedPercent(deltaPct, RatioUnits.percent)
}

/**
 * A crawled path's total hits: verified plus unverified. A path stored before
 * unverified hits were recorded has no count for them, and that adds nothing.
 */
export function reportServerActivityPathHits(path: { verifiedHits: number; unverifiedHits: number }): number {
  return path.verifiedHits + path.unverifiedHits
}

/** `234 verified · 15 unverified`. */
export function reportCrawlerTrustSummary(verified: number, unverified: number): string {
  return `${formatNumber(verified)} verified · ${formatNumber(unverified)} unverified`
}

/** `120 blocked by redirects`, or empty when no AI-referred request was redirected. */
export function reportReferralRedirectNote(redirects: number): string {
  return redirects > 0 ? `${formatNumber(redirects)} blocked by redirects` : ''
}

export function reportIndexingIntro(provider: IndexingHealthSection['provider']): string {
  return `Pages absent from ${provider === 'google' ? 'Google' : 'Bing'} are harder for AI engines to retrieve.`
}

/** A coverage legend entry: `Indexed: 80`. */
export function reportIndexingLegendLabel(label: string, count: number): string {
  return `${label}: ${count}`
}

export function reportCitationsTrendBaseline(pointCount: number): string {
  return `Building baseline (${pointCount} of ${MIN_TREND_POINTS} checks completed). Trend will appear once more checks are recorded.`
}

/** A trend row's per-engine rates: `gemini: 65.0% · openai: 50.0%`. */
export function reportTrendProviderRates(rates: readonly { provider: string; citationRate: number }[]): string {
  return rates.map(rate => `${rate.provider}: ${formatPercent(rate.citationRate, RatioUnits.percent)}`).join(' · ')
}
// ── end report slice S4 ──

// ── report slice S5: insights and content ──
const INSIGHTS_CONTENT_COPY = {
  insights: {
    eyebrow: 'Section 13',
    title: 'Insights & Alerts',
    intro: 'Regressions, gains, and recurring alerts ordered by severity.',
    empty: 'No insights yet — run a check to generate alerts.',
    headers: ['Severity', 'Title', 'Query', 'Provider', 'Recommendation'],
    noRecommendation: '—',
  },
  'content-opportunities': {
    eyebrow: 'Section 14',
    title: 'Content Opportunities',
    intro: 'Queries where content work has the clearest path to more AI citations. Opportunity score is 0–100, higher = stronger. Winnability flags whether the cited surface is ownable or ceded to aggregators/editorial.',
    headers: ['Query', 'Action', 'Winnability', 'Score', 'Why', 'Our page', 'Winning competitor', 'Confidence'],
    scoreSuffix: '/100',
    scoreCardTooltip: 'Opportunity score (0–100, higher = stronger)',
    scoreHeaderTooltip: 'Opportunity score (0–100)',
    noDriverSignal: 'No driver signal yet',
    noPage: 'No page yet',
    noWinningCompetitor: '—',
  },
  'content-gaps': {
    eyebrow: 'Section 15',
    title: 'Content Gaps',
    intro: 'Tracked queries where competitors are cited and the client is missing.',
    headers: ['Query', 'Competitors cited', 'Domains', 'Miss rate'],
  },
} as const

/** An opportunity card's action line: `Create · High confidence`. */
export function reportOpportunityActionLine(opportunity: Pick<ContentTargetRowDto, 'action' | 'actionConfidence'>): string {
  return `${contentActionLabel(opportunity.action)} · ${actionConfidenceLabel(opportunity.actionConfidence)} confidence`
}

/** A content gap's miss rate, a 0..1 fraction, as a percent: `50.0%`. */
export function reportMissRateLabel(missRate: number): string {
  return formatPercent(missRate)
}
// ── end report slice S5 ──

/** Section copy by section id. Share of voice has none: its copy lives in `share-of-voice.ts`. */
export const REPORT_SECTION_COPY = {
  ...SHARED_SECTION_COPY,
  ...AGENCY_OVERVIEW_COPY,
  ...COMPETITIVE_EVIDENCE_COPY,
  ...SEARCH_TRAFFIC_COPY,
  ...SERVER_TRENDS_COPY,
  ...INSIGHTS_CONTENT_COPY,
} as const
