import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Play,
  Search,
  Settings2,
} from 'lucide-react'
import {
  SITE_CRAWL_GRAPH_MAX_EDGES,
  SITE_CRAWL_GRAPH_MAX_NODES,
  SiteCrawlIndexabilityReasons,
  SiteHealthStates,
  TEMPLATE_LINK_MIN_FETCHED_PAGES,
  isTemplateDetectionApplied,
  type SiteCrawlEdgeDto,
  type SiteCrawlGraphNodeDto,
  type SiteCrawlIndexabilityReason,
  type SiteCrawlPageAuditDto,
  type SiteCrawlPageDto,
  type SiteCrawlStructureChildDto,
  type SiteCrawlStructureResponseDto,
  type SiteCrawlTermination,
  type SiteHealthScanDto,
  type SiteHealthState,
  type SiteHealthTemplateDetection,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameTechnicalAeoCrawlOptions,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesOptions,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteOptions,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksOptions,
  getApiV1ProjectsByNameTechnicalAeoGraphOptions,
  getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsOptions,
  getApiV1ProjectsByNameTechnicalAeoRunsOptions,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewOptions,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressOptions,
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient, isEmbed } from '../../api.js'
import { cn } from '../../lib/utils.js'
import { useTriggerSiteAudit } from '../../queries/mutations.js'
import type { MetricTone } from '../../view-models.js'
import { SiteGraphSigma } from './SiteGraphSigma.js'
import {
  siteGraphStatusDescription,
  siteGraphStatusLabel,
  siteGraphVisualState,
  type SiteGraphVisualState,
} from './site-graph-sigma.js'
import { displayPagePath, siteHostFromUrl } from './site-health-paths.js'
import { PageAuditEvidence } from './PageAuditEvidence.js'
import { TechnicalAeoSection } from './TechnicalAeoSection.js'
import { WriteButton } from '../shared/AccessControls.js'
import { OnboardingProgress } from '../shared/OnboardingProgress.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { Button } from '../ui/button.js'

type SiteHealthView = 'map' | 'inventory' | 'technical'

// The `inventory` id is the stable wire/route token. Only the label reads
// "Pages"; nothing keyed off the id changes with it.
const SITE_HEALTH_VIEWS = [
  { id: 'map', label: 'Map' },
  { id: 'inventory', label: 'Pages' },
  { id: 'technical', label: 'Page health' },
] as const satisfies ReadonlyArray<{ id: SiteHealthView; label: string }>

export const SITE_HEALTH_VIEW_DESCRIPTIONS: Record<SiteHealthView, string> = {
  map: 'Explore how pages, site sections, and internal links fit together.',
  inventory: 'Review discovered pages and the links that shape their visibility.',
  technical: 'Prioritize audit findings and inspect the pages that need work.',
}

/**
 * Page-list filters. Each one maps to a server-side filter the crawl/pages
 * route already supports, so a chip never narrows only the loaded window.
 */
type InventoryFilterId = 'all' | 'hidden'

/** Whether the selected page's own row (which carries its reasons) is known. */
type PageReasonsState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * `hidden` is the DERIVED health state, not `indexabilityState=noindex`: a
 * redirect, a robots block, a non-HTML response, and a canonical pointing
 * elsewhere all hide a page from answer engines without ever setting noindex.
 * The route derives this with the same contract function the map uses.
 */
const INVENTORY_FILTERS = [
  { id: 'all', label: 'All', healthState: undefined },
  { id: 'hidden', label: 'Hidden pages', healthState: SiteHealthStates.hidden },
] as const satisfies ReadonlyArray<{
  id: InventoryFilterId
  label: string
  healthState: SiteHealthState | undefined
}>

/**
 * Plain-word reading of the crawler's machine indexability reasons. The
 * `Record` over the closed union is what makes a newly added reason a compile
 * error here instead of raw machine text in the UI.
 */
const INDEXABILITY_REASON_COPY: Record<SiteCrawlIndexabilityReason, string> = {
  [SiteCrawlIndexabilityReasons.metaRobotsNoindex]: 'Hidden by meta robots tag',
  [SiteCrawlIndexabilityReasons.xRobotsNoindex]: 'Hidden by X-Robots-Tag header',
  [SiteCrawlIndexabilityReasons.robotsDisallow]: 'Blocked by robots.txt',
  [SiteCrawlIndexabilityReasons.redirectTerminal]: 'Redirects to another page',
  [SiteCrawlIndexabilityReasons.canonicalToOther]: 'Points to another page as canonical',
  [SiteCrawlIndexabilityReasons.notHtmlOrUnavailable]: 'Not an HTML page, so it was not scored',
}

/** Persisted rows stay string-backed, so the lookup must admit a miss. */
const INDEXABILITY_REASON_LABELS = new Map<string, string>(Object.entries(INDEXABILITY_REASON_COPY))

/**
 * An unrecognized reason is shown verbatim. Dropping it would hide the only
 * evidence the crawler gave for a page being out of the index.
 */
function indexabilityReasonLabel(reason: string): string {
  return INDEXABILITY_REASON_LABELS.get(reason) ?? reason
}

const SCAN_HISTORY_LIMIT = 20
const INVENTORY_LIMIT = 200
const STRUCTURE_LIMIT = 100
const NEIGHBOR_LIMIT = 100
const DEAD_LINK_LIMIT = 50
const GRAPH_NODE_LIMIT = SITE_CRAWL_GRAPH_MAX_NODES
const GRAPH_EDGE_LIMIT = SITE_CRAWL_GRAPH_MAX_EDGES
const ONBOARDING_CONTINUATION_DELAY_MS = 20_000
const LIVE_PAGE_HEALTH_SLOT_COUNT = 3

const numberFormatter = new Intl.NumberFormat()
const scanDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const SITE_HEALTH_STATUS_TONES: Record<SiteGraphVisualState, MetricTone> = {
  eligible: 'positive',
  hidden: 'caution',
  // Neutral: a file that is not a page, and a page that moved, are facts about
  // what the crawler found, not problems to fix.
  resource: 'neutral',
  redirect: 'neutral',
  failed: 'negative',
  unchecked: 'neutral',
}

function formatScanDate(value: string | null | undefined): string {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : scanDateFormatter.format(date)
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

type InspectableCrawlPage = SiteCrawlPageDto | SiteCrawlGraphNodeDto

function crawlStatus(page: InspectableCrawlPage): { label: string; tone: MetricTone } {
  const state = siteGraphVisualState(page)
  return {
    label: siteGraphStatusLabel(state),
    tone: SITE_HEALTH_STATUS_TONES[state],
  }
}

function formatImportance(value: number | null): string {
  if (value == null) return 'Not scored'
  const percent = value <= 1 ? value * 100 : value
  return `${Math.round(percent)}%`
}

function formatHealth(page: InspectableCrawlPage): string {
  return page.auditScore == null ? 'Not checked' : `${Math.round(page.auditScore)}/100`
}

function metricValue(value: number | null | undefined): string {
  return value == null ? 'Not available' : numberFormatter.format(value)
}

/**
 * What every Site Health number means, in plain words.
 *
 * One source of truth, because the same four metrics appear on the page
 * inspector tiles AND as Pages table columns. Two copies would drift, and a
 * metric explained differently in two places is worse than one not explained
 * at all.
 */
type SiteHealthMetric =
  | 'clicksFromHome'
  | 'linksIn'
  | 'linksOut'
  | 'linkImportance'
  | 'technicalScore'
  | 'linkTimes'
  | 'pagesFound'
  | 'pagesChecked'
  | 'internalLinks'

const SITE_HEALTH_METRIC_HELP: Record<SiteHealthMetric, string> = {
  clicksFromHome: 'How many clicks it takes to reach this page from the home page, following links.',
  linksIn: 'How many other pages link to this page.',
  linksOut: 'How many other pages this page links to.',
  linkImportance: 'How much link value flows to this page, based on how many pages link to it and how important those pages are. Shown relative to the highest page on this site, which is 100%.',
  technicalScore: 'How well this page is set up for AI and search engines to read, from 0 to 100. Open a page to see what it is marked down for.',
  linkTimes: 'How many times this link appears on the page it comes from.',
  pagesFound: 'How many pages this scan discovered, whether or not it could load them.',
  pagesChecked: 'How many of the pages it found this scan actually loaded.',
  internalLinks: 'How many links between pages on this site the scan recorded.',
}

/**
 * Metrics the crawl engine computes over the FULL link graph, before nav and
 * footer links are told apart. The filter cannot change them, so they say so
 * out loud: without that, a reader seeing them beside two filtered counts
 * would reasonably assume all four were filtered.
 */
const FULL_GRAPH_METRICS: ReadonlySet<SiteHealthMetric> = new Set([
  'clicksFromHome',
  'linkImportance',
  'internalLinks',
  'pagesFound',
  'pagesChecked',
])

/**
 * Help text for one metric, told truthfully for the surface it sits on.
 * `filtered` means THIS surface is currently hiding nav and footer links.
 */
export function siteHealthMetricHelp(metric: SiteHealthMetric, filtered: boolean): string {
  const base = SITE_HEALTH_METRIC_HELP[metric]
  if (FULL_GRAPH_METRICS.has(metric)) {
    return `${base} This always counts every link, including menu and footer.`
  }
  if (metric === 'technicalScore' || metric === 'linkTimes') return base
  return filtered
    ? `${base} Right now this counts only links written in your page text. Menu and footer links are hidden.`
    : `${base} This counts every link, including menu and footer.`
}

/** Counted nouns in map copy. "1 content links" reads like a bug report. */
function countedLinks(count: number, noun: string): string {
  return `${numberFormatter.format(count)} ${noun}${count === 1 ? '' : 's'}`
}

function movedSiteHosts(requestedRootUrl: string | null, effectiveRootUrl: string | null): {
  requested: string
  effective: string
} | null {
  if (!requestedRootUrl || !effectiveRootUrl) return null
  try {
    const requestedUrl = new URL(requestedRootUrl)
    const effectiveUrl = new URL(effectiveRootUrl)
    const identity = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
    return identity(requestedUrl) !== identity(effectiveUrl)
      ? { requested: requestedUrl.host, effective: effectiveUrl.host }
      : null
  } catch {
    return null
  }
}

function scanTone(status: string | null | undefined): MetricTone {
  if (status === 'completed') return 'positive'
  if (status === 'partial' || status === 'queued' || status === 'running') return 'caution'
  if (status === 'failed' || status === 'cancelled') return 'negative'
  return 'neutral'
}

/**
 * A scan that kept no crawl is still real, selectable history. Say what it
 * holds ("Score only") rather than hiding it or letting it look broken.
 */
function scanOptionLabel(scan: SiteHealthScanDto): string {
  const when = formatScanDate(scan.finishedAt ?? scan.startedAt ?? scan.createdAt)
  const suffix = scan.hasCrawlData ? '' : ' · Score only'
  return `${when} · ${titleCase(scan.status)}${suffix}`
}

/**
 * Why a scan stopped, in plain words. A closed Record over the crawler's own
 * vocabulary, so a new reason is a compile error rather than silently falling
 * through to generic copy.
 */
const TERMINATION_COPY: Record<SiteCrawlTermination, string> = {
  'complete': 'This scan finished on its own.',
  'unknown': 'This scan stopped before it checked every page it found.',
  'max-pages': 'This scan stopped at the page limit, so some pages were not checked.',
  'max-edges': 'This scan stopped at the link limit, so some links are missing.',
  'max-fetches': 'This scan stopped after checking as many pages as it could.',
  'max-duration': 'This scan ran out of time, so some pages were not checked.',
  'max-bytes': 'This scan stopped at the data limit, so some pages were not checked.',
  'max-page-bytes': 'This scan skipped a page that was too large to read.',
  'max-depth': 'This scan stopped at the depth limit, so deeper pages were not checked.',
  'max-links-per-page': 'This scan stopped reading links on pages that had too many.',
  'max-query-variants': 'This scan stopped at the limit for pages that differ only by a query string.',
  'max-sitemap-fanout': 'This scan stopped at the sitemap limit, so some sitemaps were not read.',
  'max-sitemap-urls': 'This scan stopped at the sitemap page limit, so some pages were not found.',
  'root-host-redirect': 'The site moved to another address during this scan.',
}

const TERMINATION_LABELS = new Map<string, string>(Object.entries(TERMINATION_COPY))

function terminationCopy(termination: string | null): string {
  if (!termination) return 'This scan stopped before it checked every page it found.'
  // An unrecognized reason is shown as-is: it is the only thing the crawler
  // told us about why the scan stopped.
  return TERMINATION_LABELS.get(termination) ?? `This scan stopped early: ${termination}.`
}

/**
 * How this scan told nav and footer links apart, in plain words. A closed
 * Record over the contract's own vocabulary, so a new state is a compile error
 * rather than a silently missing explanation.
 *
 * Every state has copy, including the ones where the control works, because the
 * two rules do not measure the same thing: a reader comparing this month's
 * content-link count with last month's needs to know whether the number moved
 * because the site changed or because the scan could finally see where each
 * link sits.
 */
export const TEMPLATE_DETECTION_COPY: Record<SiteHealthTemplateDetection, string> = {
  'applied': 'This scan told menu and footer links apart by how often the same link repeats across pages. It cannot spot a link written into the page text when its wording matches the menu. Run a new scan to read the page layout instead.',
  'applied-placement': 'This scan read where each link sits in the page, so links in the page text are separated from the menu, header, and footer even when they use the same wording.',
  'applied-placement-with-ubiquity': 'This scan read where each link sits in the page. Some pages mark out no menu or main area, so those links fall back to how often the link repeats across pages, which can miss a link written into the page text.',
  'applied-placement-partial': `This scan read where each link sits in the page. Some pages mark out no menu or main area, and this scan found fewer than ${TEMPLATE_LINK_MIN_FETCHED_PAGES} pages, so nothing could tell those links apart. They are counted as links in your page text, which is what a link no rule marked as menu, header, or footer means here.`,
  'unavailable-too-few-pages': `This scan found fewer than ${TEMPLATE_LINK_MIN_FETCHED_PAGES} pages and did not read where each link sits in the page. On a site that small every link is on most pages, so menu and footer links cannot be told apart from the rest.`,
  'unavailable-legacy-scan': 'This scan ran before menu and footer links were separated. Run a new scan to split them out.',
}

/** Persisted rows stay string-backed, so the lookup must admit a miss. */
const TEMPLATE_DETECTION_LABELS = new Map<string, string>(Object.entries(TEMPLATE_DETECTION_COPY))

function templateDetectionCopy(detection: SiteHealthTemplateDetection | null): string {
  if (detection === null) return ''
  // A value outside the union can still arrive on the wire. Fall back to the
  // "run a new scan" copy, which is true of any scan we cannot classify.
  return TEMPLATE_DETECTION_LABELS.get(detection) ?? TEMPLATE_DETECTION_COPY['unavailable-legacy-scan']
}

/**
 * Why a map's stored page positions predate the current link split. Kept beside
 * the detection copy because both answer the same question a reader has about
 * the same numbers, and both belong in the same tooltip rather than in a second
 * and third line of the header strip.
 */
/** Heading help for the map. Was a subtitle line under the heading. */
export const SITE_MAP_HELP = 'Scroll to zoom. Click a page to inspect it.'

/** Heading help for the page inspector's link section. Was a subtitle line. */
export const PAGE_INTERNAL_LINKS_HELP = 'Observed links to and from this page in the selected scan.'

export const SITE_MAP_STALE_LAYOUT_COPY =
  'Page positions on this map were set before menu and footer links were separated. Run a new scan to update them.'

/**
 * The map header's VISIBLE line: the numbers, and nothing else.
 *
 * It used to carry the counts plus two more lines of prose, which is more copy
 * than a header strip can hold. The numbers are what a reader scans for; the
 * explanation behind them is one hover or one tab away in `siteMapLinkRuleHelp`.
 *
 * "Content link" and "template link" are OUR words, not a reader's. The real
 * distinction is where the link was written: in the page's own text, or in the
 * furniture that repeats on every page. The copy says that; the wire format
 * (`linkKind=content|template|all`) is unchanged and stays our vocabulary.
 */
export function siteMapLinkCountsLabel(counts: {
  filterUnavailable: boolean
  showTemplateLinks: boolean
  contentEdgeCount: number
  templateEdgeCount: number
  totalEdgeCount: number
}): string {
  if (counts.filterUnavailable) return `All ${countedLinks(counts.totalEdgeCount, 'link')} shown.`
  const inText = `${numberFormatter.format(counts.contentEdgeCount)} link${counts.contentEdgeCount === 1 ? '' : 's'} in your page text`
  const template = numberFormatter.format(counts.templateEdgeCount)
  return counts.showTemplateLinks
    ? `${inText}, ${template} menu and footer.`
    : `${inText}. ${template} menu and footer link${counts.templateEdgeCount === 1 ? '' : 's'} hidden.`
}

/**
 * Why the split is worth having, before how it was made.
 *
 * A reader does not arrive wanting to know which rule ran. They want to know
 * why the map hides most of their links, so the tooltip answers that first and
 * only then explains the rule behind the numbers.
 */
export const SITE_MAP_LINK_SPLIT_COPY =
  'Menu, header, and footer links repeat on every page, so they say nothing about which pages relate to each other. Links written in your page text do.'

/**
 * Everything the header line no longer says out loud: what the split is for,
 * which rule produced it, and whether the positions predate it. Nothing was
 * dropped in the compression, it moved into the tooltip.
 */
export function siteMapLinkRuleHelp(
  detection: SiteHealthTemplateDetection | null,
  options: { staleLayout: boolean },
): string {
  const parts = [SITE_MAP_LINK_SPLIT_COPY, templateDetectionCopy(detection)]
  if (options.staleLayout) parts.push(SITE_MAP_STALE_LAYOUT_COPY)
  return parts.filter(Boolean).join(' ')
}

/**
 * Tri-state, and it never shows a bare zero when the check did not run: "0"
 * would read as "we looked and found none".
 *
 * `unverified` links are ones the crawler never got a response for, which is a
 * fact about the scan and not about the link. They must never be added to
 * `found`, and "none found" must not be shown as a clean bill of health while
 * some links went unchecked — that is the same claim of proven absence, one
 * step further along.
 */
function deadLinkLabel(state: string, found?: number, unverified?: number): { label: string; tone: MetricTone } {
  if (state === 'disabled') return { label: 'Broken links: not checked', tone: 'neutral' }
  const unchecked = unverified ?? 0
  const uncheckedSuffix = unchecked > 0 ? `, ${numberFormatter.format(unchecked)} unchecked` : ''
  if (state === 'complete') {
    if (found) return { label: `Broken links: ${numberFormatter.format(found)} found${uncheckedSuffix}`, tone: 'negative' }
    return unchecked > 0
      ? { label: `Broken links: none found, ${numberFormatter.format(unchecked)} unchecked`, tone: 'caution' }
      : { label: 'Broken links: none found', tone: 'positive' }
  }
  if (state === 'partial') {
    return { label: `Broken links: ${numberFormatter.format(found ?? 0)} found so far${uncheckedSuffix}`, tone: 'caution' }
  }
  return { label: 'Broken links: not checked', tone: 'neutral' }
}

/**
 * What one direction's tile should say, given the active link filter.
 *
 * The tiles used to always show the crawl's full-graph totals while the tables
 * beneath them honoured the content-only filter, so one panel read "Links in
 * 48" directly above a table headed "Links in (1)". Both were right and the
 * pair was unreadable. The tile now counts exactly what the table lists.
 */
export function linkTileCount(counts: {
  total: number
  visible: number
  hidden: number
  truncated: boolean
  showTemplateLinks: boolean
  known: boolean
}): { value: string; hiddenNote: string | null; filtered: boolean } {
  // `filtered` is decided HERE, by the same branch that decides the number, so
  // the tooltip can never describe a count this function did not produce.
  //
  // Filter off, or no per-kind answer to give: the crawl's own total, which is
  // the only number here that covers every link.
  if (counts.showTemplateLinks || !counts.known) {
    return { value: metricValue(counts.total), hiddenNote: null, filtered: false }
  }
  // The neighbour read is bounded, so a truncated list can only prove a lower
  // bound. Say so rather than presenting a partial count as the answer.
  return {
    filtered: true,
    value: counts.truncated ? `${metricValue(counts.visible)}+` : metricValue(counts.visible),
    hiddenNote: counts.hidden === 0
      ? null
      : counts.truncated
        ? `At least ${metricValue(counts.hidden)} menu and footer hidden`
        : `${metricValue(counts.hidden)} menu and footer hidden`,
  }
}

function LinkMetricTile({ label, value, hiddenNote, help }: {
  label: string
  value: string
  hiddenNote?: string | null
  help: string
}) {
  return (
    <div className="px-4 py-3">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {label}
        <InfoTooltip text={help} />
      </dt>
      <dd className="mt-1 text-sm font-medium tabular-nums text-heading">{value}</dd>
      {hiddenNote && <dd className="mt-0.5 text-xs text-muted">{hiddenNote}</dd>}
    </div>
  )
}

function LinkMetrics({ page, inbound, outbound }: {
  page: InspectableCrawlPage
  inbound: ReturnType<typeof linkTileCount>
  outbound: ReturnType<typeof linkTileCount>
}) {
  // Depth and link importance are computed by the crawl engine over the FULL
  // link graph, before nav and footer links are classified, so the filter does
  // not change them. That used to be said twice: once in a footnote under this
  // grid, and once in the two affected tiles' own tooltips, which
  // `siteHealthMetricHelp` already appends it to for every FULL_GRAPH_METRIC.
  // The footnote was the duplicate, so it is gone and nothing was lost.
  return (
    <>
      <dl className="grid grid-cols-2 divide-x divide-y divide-default rounded-lg border border-default sm:grid-cols-4 sm:divide-y-0">
        <LinkMetricTile
          label="Clicks from home"
          value={String(page.depth ?? 'Not reached')}
          help={siteHealthMetricHelp('clicksFromHome', false)}
        />
        <LinkMetricTile
          label="Links in"
          value={inbound.value}
          hiddenNote={inbound.hiddenNote}
          help={siteHealthMetricHelp('linksIn', inbound.filtered)}
        />
        <LinkMetricTile
          label="Links out"
          value={outbound.value}
          hiddenNote={outbound.hiddenNote}
          help={siteHealthMetricHelp('linksOut', outbound.filtered)}
        />
        <LinkMetricTile
          label="Link importance"
          value={formatImportance(page.linkScoreNormalized)}
          help={siteHealthMetricHelp('linkImportance', false)}
        />
      </dl>
    </>
  )
}

/**
 * What an empty link list MEANS, in plain words with the real numbers.
 *
 * A page whose only connections are nav and footer chrome is editorially
 * orphaned, which is the single most useful thing this map can tell someone.
 * Drawing nothing and saying nothing turns that finding into what looks like a
 * broken map, so the counts are always named. Both numbers come from the
 * neighbours read; nothing here is inferred.
 */
export function emptyLinkCopy(
  direction: 'inbound' | 'outbound',
  hiddenTemplateCount: number,
  truncated: boolean,
): string {
  if (hiddenTemplateCount === 0) {
    return direction === 'inbound'
      ? 'Nothing links to this page.'
      : 'This page links to nothing.'
  }
  const lead = direction === 'inbound'
    ? 'No links in the page text point here.'
    : 'No links in the page text lead away from here.'
  // A truncated list can only prove a lower bound, so it says so rather than
  // rounding a partial count into a fact.
  const hidden = truncated
    ? `At least ${metricValue(hiddenTemplateCount)} menu and footer links hidden.`
    : `${countedLinks(hiddenTemplateCount, 'menu and footer link')} hidden.`
  return `${lead} ${hidden}`
}

/**
 * A table column heading with its plain-words explanation attached.
 *
 * Table columns read the server's full-graph counts, so they are never the
 * filtered variant. The page inspector tiles are, which is why they call
 * `siteHealthMetricHelp` themselves with the live toggle state.
 */
function ColumnLabel({ label, metric }: { label: string; metric: SiteHealthMetric }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <InfoTooltip text={siteHealthMetricHelp(metric, false)} />
    </span>
  )
}

function NeighborTable({
  direction,
  edges,
  truncated,
  rootHost,
  hiddenTemplateCount,
}: {
  direction: 'inbound' | 'outbound'
  edges: SiteCrawlEdgeDto[]
  truncated: boolean
  rootHost: string | null
  hiddenTemplateCount: number
}) {
  const heading = direction === 'inbound' ? 'Links in' : 'Links out'
  return (
    <section className="min-w-0" aria-labelledby={`site-health-${direction}-heading`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 id={`site-health-${direction}-heading`} className="text-sm font-medium text-heading">
          {heading} ({metricValue(edges.length)})
        </h4>
        {truncated && <span className="text-xs text-muted">First {NEIGHBOR_LIMIT}</span>}
      </div>
      {edges.length === 0 ? (
        <p className="rounded-lg border border-subtle bg-surface-subtle px-3 py-4 text-sm text-secondary">
          {emptyLinkCopy(direction, hiddenTemplateCount, truncated)}
        </p>
      ) : (
        <div className="evidence-table-wrap max-h-64 overflow-auto">
          <table className="evidence-table site-health-table min-w-[420px]">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Anchor text</th>
                <th scope="col"><ColumnLabel label="Times" metric="linkTimes" /></th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => {
                const url = direction === 'inbound' ? edge.sourceUrl : edge.targetUrl
                return (
                <tr key={edge.edgeKey}>
                  {/* The path is the display; the full URL stays on hover. */}
                  <td className="max-w-64 truncate font-mono" title={url}>
                    {displayPagePath(url, rootHost)}
                  </td>
                  <td className="max-w-52 truncate" title={edge.anchors.join(', ') || undefined}>
                    {edge.anchors.join(', ') || 'No anchor text'}
                  </td>
                  <td className="tabular-nums">{metricValue(edge.occurrences)}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * Only the full page DTO carries the crawler's reasons; the compact graph node
 * does not. The inspector must therefore look the page up in the inventory
 * read rather than reuse whichever object it selected from, or a page picked
 * on the map silently shows no reason at all.
 */
function indexabilityReasons(page: InspectableCrawlPage | null): readonly string[] {
  return page && 'indexabilityReasons' in page ? page.indexabilityReasons : []
}

function PageInspector({
  page,
  isLoading,
  error,
  inbound,
  outbound,
  inboundTruncated,
  outboundTruncated,
  audit,
  auditLoading,
  auditError,
  onRetryAudit,
  rootHost,
  reasonSource,
  reasonsState,
  onRetryReasons,
  showTemplateLinks,
}: {
  page: InspectableCrawlPage | null
  isLoading: boolean
  error: Error | null
  inbound: SiteCrawlEdgeDto[]
  outbound: SiteCrawlEdgeDto[]
  inboundTruncated: boolean
  outboundTruncated: boolean
  audit: SiteCrawlPageAuditDto | undefined
  auditLoading: boolean
  auditError: Error | null
  onRetryAudit: () => void
  rootHost: string | null
  /** The same page from the inventory read, which carries the crawler reasons. */
  reasonSource: SiteCrawlPageDto | null
  reasonsState: PageReasonsState
  onRetryReasons: () => void
  /** Mirrors the map, so the two never disagree about one page. */
  showTemplateLinks: boolean
}) {
  if (!page) {
    return (
      <section className="border-t border-default pt-5" aria-label="Selected page details">
        <h3 className="text-base font-medium text-heading">Page links</h3>
        <p className="mt-1 text-sm text-secondary">Select a page to inspect its internal links and crawl signals.</p>
      </section>
    )
  }

  const status = crawlStatus(page)
  const reasons = indexabilityReasons(reasonSource ?? page)
  // The inspector shows what the MAP shows. Listing nav links the map is
  // hiding would make the two disagree about the same page.
  const visibleInbound = showTemplateLinks ? inbound : inbound.filter((edge) => !edge.isTemplate)
  const visibleOutbound = showTemplateLinks ? outbound : outbound.filter((edge) => !edge.isTemplate)
  // Until the neighbour read lands there is no per-kind answer, so the tiles
  // stay on the crawl's own totals rather than briefly showing a zero.
  const linkCountsKnown = !isLoading && !error
  const hiddenInboundCount = inbound.length - visibleInbound.length
  const hiddenOutboundCount = outbound.length - visibleOutbound.length
  // The tiles read from exactly the lists the tables render, so the panel
  // cannot show two different answers for the same page again.
  const inboundTile = linkTileCount({
    total: page.inboundUniqueEdges,
    visible: visibleInbound.length,
    hidden: hiddenInboundCount,
    truncated: inboundTruncated,
    showTemplateLinks,
    known: linkCountsKnown,
  })
  const outboundTile = linkTileCount({
    total: page.outboundUniqueEdges,
    visible: visibleOutbound.length,
    hidden: hiddenOutboundCount,
    truncated: outboundTruncated,
    showTemplateLinks,
    known: linkCountsKnown,
  })
  return (
    <section className="border-t border-default pt-5" aria-labelledby="site-health-page-inspector-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="site-health-page-inspector-title" className="break-words font-mono text-base font-semibold text-heading">
              {page.path}
            </h3>
            <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
          </div>
          <p className="mt-1 break-all text-sm text-secondary">{page.url}</p>
          {reasonsState === 'loading' ? (
            <p className="mt-2 text-sm text-secondary" role="status">Loading page details...</p>
          ) : reasonsState === 'error' ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-negative" role="alert">
              Page details could not be loaded, so any reason this page is hidden is unknown.
              <Button type="button" variant="secondary" size="sm" onClick={onRetryReasons}>Try again</Button>
            </p>
          ) : reasons.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-secondary" aria-label="Why this page is hidden">
              {reasons.map((reason) => (
                <li key={reason}>{indexabilityReasonLabel(reason)}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <Button asChild variant="secondary" size="sm">
          <a href={page.url} target="_blank" rel="noreferrer">
            Open page <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>

      <div className="mt-4">
        <PageAuditEvidence
          audit={audit}
          isLoading={auditLoading}
          error={auditError}
          onRetry={onRetryAudit}
        />
      </div>

      <section className="mt-5 border-t border-default pt-5" aria-labelledby="site-health-page-links-heading">
        <div className="flex items-center gap-1">
          <h3 id="site-health-page-links-heading" className="text-base font-semibold text-heading">Internal links</h3>
          <InfoTooltip text={PAGE_INTERNAL_LINKS_HELP} />
        </div>
        <div className="mt-4">
          <LinkMetrics page={page} inbound={inboundTile} outbound={outboundTile} />
        </div>
        <div className="mt-5">
          {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-secondary">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Loading page links...
          </div>
        ) : error ? (
          <p className="rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
            Page links could not be loaded.
          </p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <NeighborTable
              direction="inbound"
              edges={visibleInbound}
              truncated={inboundTruncated}
              rootHost={rootHost}
              hiddenTemplateCount={hiddenInboundCount}
            />
            <NeighborTable
              direction="outbound"
              edges={visibleOutbound}
              truncated={outboundTruncated}
              rootHost={rootHost}
              hiddenTemplateCount={hiddenOutboundCount}
            />
          </div>
          )}
        </div>
      </section>
    </section>
  )
}

function InventoryTable({
  pages,
  total,
  selectedNodeKey,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  filter,
  onFilterChange,
  filterUnavailable,
}: {
  pages: SiteCrawlPageDto[]
  total: number
  selectedNodeKey: string | null
  onSelect: (nodeKey: string) => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  filter: InventoryFilterId
  onFilterChange: (filter: InventoryFilterId) => void
  /** This scan predates persisted health state, so it cannot be filtered. */
  filterUnavailable: boolean
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()
  const visiblePages = useMemo(
    () => normalizedSearch
      ? pages.filter((page) => `${page.path} ${page.url}`.toLowerCase().includes(normalizedSearch))
      : pages,
    [normalizedSearch, pages],
  )
  const searchCoversLoadedWindowOnly = normalizedSearch.length > 0 && (hasNextPage || pages.length < total)

  return (
    <section aria-labelledby="site-health-inventory-heading">
      <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 id="site-health-inventory-heading" className="text-base font-semibold text-heading">Pages</h2>
          <p className="mt-1 text-sm text-secondary">
            {filter === 'all'
              ? `Showing ${metricValue(pages.length)} of ${metricValue(total)} pages found.`
              : `Showing ${metricValue(pages.length)} of ${metricValue(total)} hidden pages.`}
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search loaded pages</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded pages"
            className="h-9 w-full rounded-md border border-base bg-bg pl-9 pr-3 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-600"
          />
        </label>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter pages">
        {INVENTORY_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => onFilterChange(option.id)}
            className={`filter-chip ${filter === option.id ? 'filter-chip-active' : ''}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="evidence-table-wrap">
        <table className="evidence-table site-health-table min-w-[800px]">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col" title={siteGraphStatusDescription('eligible')}>Status</th>
              <th scope="col"><ColumnLabel label="Clicks from home" metric="clicksFromHome" /></th>
              <th scope="col"><ColumnLabel label="Links in" metric="linksIn" /></th>
              <th scope="col"><ColumnLabel label="Links out" metric="linksOut" /></th>
              <th scope="col"><ColumnLabel label="Link importance" metric="linkImportance" /></th>
              <th scope="col"><ColumnLabel label="Score" metric="technicalScore" /></th>
            </tr>
          </thead>
          <tbody>
            {visiblePages.map((page) => {
              const status = crawlStatus(page)
              return (
                <tr key={page.nodeKey} className={selectedNodeKey === page.nodeKey ? 'bg-surface-active' : undefined}>
                  <td className="max-w-80">
                    <button
                      type="button"
                      onClick={() => onSelect(page.nodeKey)}
                      className="block max-w-full truncate rounded-sm font-mono text-sm font-medium text-link outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                      title={page.url}
                    >
                      {page.path}
                    </button>
                  </td>
                  <td title={siteGraphStatusDescription(siteGraphVisualState(page))}>
                    <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                  </td>
                  <td className="tabular-nums">{page.depth ?? 'Not reached'}</td>
                  <td className="tabular-nums">{metricValue(page.inboundUniqueEdges)}</td>
                  <td className="tabular-nums">{metricValue(page.outboundUniqueEdges)}</td>
                  <td className="tabular-nums">{formatImportance(page.linkScoreNormalized)}</td>
                  <td className="tabular-nums">{formatHealth(page)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {visiblePages.length === 0 && (
        <p className="border-x border-b border-default px-4 py-8 text-center text-sm text-secondary">
          {normalizedSearch.length === 0
            ? filterUnavailable
              ? 'This scan cannot be filtered. Run a new scan to filter its pages.'
              : filter === 'hidden'
                ? 'No hidden pages were found in this scan.'
                : 'No pages are available.'
            : searchCoversLoadedWindowOnly
              ? `No matches in the ${metricValue(pages.length)} loaded pages. Load more pages to continue searching.`
              : 'No pages match this search.'}
        </p>
      )}
      {hasNextPage && (
        <div className="flex justify-center border-x border-b border-default px-4 py-3">
          <Button variant="secondary" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
            {isFetchingNextPage && <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            {isFetchingNextPage ? 'Loading more pages' : 'Load more pages'}
          </Button>
        </div>
      )}
    </section>
  )
}

function SiteSectionRow({
  projectName,
  runId,
  section,
  onSelect,
}: {
  projectName: string
  runId: string
  section: SiteCrawlStructureChildDto
  onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const descendantCount = section.pageCount - (section.hasPage ? 1 : 0)
  const expandable = descendantCount > 0

  return (
    <li>
      <div className="flex min-h-11 items-center gap-1 px-2 py-1">
        {expandable ? (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.path}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted outline-none hover:bg-surface-hover hover:text-heading focus-visible:ring-2 focus-visible:ring-mono-400"
          >
            {expanded
              ? <ChevronDown className="size-3.5" aria-hidden="true" />
              : <ChevronRight className="size-3.5" aria-hidden="true" />}
          </button>
        ) : (
          <span className="block size-8 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onSelect(section.path)}
          className="min-w-0 flex-1 break-all rounded-sm py-2 text-left font-mono text-sm text-heading outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-mono-400"
        >
          {section.path}
        </button>
        <span className="shrink-0 px-2 font-mono text-xs text-muted">{metricValue(section.pageCount)}</span>
      </div>
      {expanded && (
        <div className="ml-6 border-l border-default pl-1">
          <SiteSectionChildren
            projectName={projectName}
            runId={runId}
            parentPath={section.path}
            onSelect={onSelect}
          />
        </div>
      )}
    </li>
  )
}

/**
 * The crawl root sits in no folder, so a folders-only list left the home page
 * with nowhere to be clicked. It leads the top-level list as its own row.
 */
function RootPageRow({ page, onSelect }: {
  page: Pick<SiteCrawlGraphNodeDto, 'nodeKey' | 'path' | 'inventoryEligible'>
  onSelect: (nodeKey: string) => void
}) {
  return (
    <li className="bg-surface-subtle">
      <div className="flex min-h-11 items-center gap-1 px-2 py-1">
        <span className="block size-8 shrink-0" aria-hidden="true" />
        <button
          type="button"
          onClick={() => onSelect(page.nodeKey)}
          className="min-w-0 flex-1 break-all rounded-sm py-2 text-left font-mono text-sm font-semibold text-heading outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-mono-400"
        >
          {page.path || '/'}
        </button>
        <span className="shrink-0 px-2 font-mono text-xs text-muted">{metricValue(1)}</span>
      </div>
    </li>
  )
}

function SiteSectionChildren({
  projectName,
  runId,
  parentPath,
  onSelect,
  rootPage,
  onSelectRootPage,
}: {
  projectName: string
  runId: string
  parentPath: string
  onSelect: (path: string) => void
  /** Only the top-level list carries it; nested folder lists pass null. */
  rootPage?: Pick<SiteCrawlGraphNodeDto, 'nodeKey' | 'path' | 'inventoryEligible'> | null
  onSelectRootPage?: (nodeKey: string) => void
}) {
  const structureInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, parentPath, limit: STRUCTURE_LIMIT },
  } as const
  const structureQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameTechnicalAeoStructureInfiniteOptions(structureInput),
    initialPageParam: structureInput,
    getNextPageParam: (lastPage: SiteCrawlStructureResponseDto) => lastPage.nextCursor
      ? {
          path: structureInput.path,
          query: { ...structureInput.query, cursor: lastPage.nextCursor },
        }
      : undefined,
  })
  const sections = structureQuery.data?.pages.flatMap((page) => page.children) ?? []

  if (structureQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-sm text-secondary" role="status">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> Loading sections...
      </div>
    )
  }
  if (structureQuery.error) {
    return <p className="px-3 py-4 text-sm text-negative" role="alert">Site sections could not be loaded.</p>
  }
  if (sections.length === 0 && !rootPage) {
    return <p className="px-3 py-4 text-sm text-secondary">No nested sections were found.</p>
  }

  return (
    <>
      <ul className="divide-y divide-default">
        {rootPage && onSelectRootPage && (
          <RootPageRow page={rootPage} onSelect={onSelectRootPage} />
        )}
        {sections.map((section) => (
          <SiteSectionRow
            key={section.path}
            projectName={projectName}
            runId={runId}
            section={section}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {structureQuery.hasNextPage && (
        <div className="px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={structureQuery.isFetchingNextPage}
            onClick={() => void structureQuery.fetchNextPage()}
          >
            {structureQuery.isFetchingNextPage ? 'Loading more sections' : 'Load more sections'}
          </Button>
        </div>
      )}
    </>
  )
}

function GraphLoadingState() {
  return (
    <div
      role="status"
      className="flex min-h-[420px] items-center justify-center rounded-lg border border-default bg-surface-inset px-6 text-center lg:min-h-[520px]"
    >
      <div className="max-w-sm">
        <LoaderCircle className="mx-auto size-5 motion-safe:animate-spin text-muted" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-heading">Preparing the interactive site map</p>
        <p className="mt-1 text-sm text-secondary">Page and link data is ready for the graph renderer.</p>
      </div>
    </div>
  )
}

type SiteAuditProgressSnapshot = {
  phase: 'queued' | 'discovering' | 'checking' | 'arranging-map' | 'completed' | 'partial' | 'failed' | 'cancelled'
  attempt: {
    pagesDiscovered: number
    pagesFetched: number
    edgesDiscovered: number
    pagesErrored: number
    error: string | null
  } | null
  error: string | null
}

function scanPhaseCopy(phase: SiteAuditProgressSnapshot['phase'] | 'running' | 'queued' | null | undefined): string {
  if (phase === 'discovering') return 'Discovering pages'
  if (phase === 'checking') return 'Checking pages'
  if (phase === 'arranging-map') return 'Arranging map'
  if (phase === 'queued') return 'Waiting to start'
  return 'Preparing scan'
}

function shouldPollSiteAuditProgress(phase: SiteAuditProgressSnapshot['phase'] | undefined): boolean {
  return phase !== 'completed'
    && phase !== 'partial'
    && phase !== 'failed'
    && phase !== 'cancelled'
}

function isActiveSiteAuditPhase(phase: SiteAuditProgressSnapshot['phase'] | undefined): boolean {
  return phase === 'queued'
    || phase === 'discovering'
    || phase === 'checking'
    || phase === 'arranging-map'
}

function isTerminalSiteAuditPhase(phase: SiteAuditProgressSnapshot['phase'] | undefined): boolean {
  return phase === 'completed'
    || phase === 'partial'
    || phase === 'failed'
    || phase === 'cancelled'
}

function queryErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; error?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  if (candidate.error && typeof candidate.error === 'object') {
    const nested = candidate.error as { code?: unknown }
    return typeof nested.code === 'string' ? nested.code : null
  }
  return null
}

function onboardingContinuationDeadline(createdAt: string | undefined): number | null {
  if (!createdAt) return null
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs) || createdAtMs > Date.now()) return null
  return createdAtMs + ONBOARDING_CONTINUATION_DELAY_MS
}

/**
 * This is deliberately keyed to the server-persisted run timestamp. A reload
 * resumes the same wait, while a replacement run starts with its own window.
 */
function useOnboardingContinuationThreshold({
  active,
  runId,
  createdAt,
}: {
  active: boolean
  runId: string | null
  createdAt: string | undefined
}): boolean {
  const deadline = onboardingContinuationDeadline(createdAt)
  const [elapsedForRun, setElapsedForRun] = useState<{ runId: string; deadline: number } | null>(null)

  useEffect(() => {
    if (!active || !runId || deadline == null) {
      setElapsedForRun(null)
      return
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      setElapsedForRun({ runId, deadline })
      return
    }

    setElapsedForRun(null)
    const timeoutId = window.setTimeout(() => setElapsedForRun({ runId, deadline }), remaining)
    return () => window.clearTimeout(timeoutId)
  }, [active, deadline, runId])

  return active
    && runId != null
    && deadline != null
    && (Date.now() >= deadline || (elapsedForRun?.runId === runId && elapsedForRun.deadline === deadline))
}

function OnboardingContinuationActions({
  onContinueOnboarding,
  onSkipOnboarding,
}: {
  onContinueOnboarding?: () => void
  onSkipOnboarding?: () => void
}) {
  return (
    <section aria-labelledby="site-health-continuation-heading" className="mt-5 flex flex-col gap-3 border-t border-default pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 id="site-health-continuation-heading" className="text-base font-semibold text-heading">Continue while Site Health finishes</h3>
        <p className="mt-1 text-sm text-secondary">Canonry will finish this scan locally. Saved results will appear in Site Health.</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button type="button" onClick={onContinueOnboarding}>Set up AI Visibility</Button>
        <Button type="button" variant="secondary" onClick={onSkipOnboarding}>Skip for now</Button>
      </div>
    </section>
  )
}

function TransientSiteHealthPanel({
  view,
  tabbed = true,
  children,
}: {
  view: Exclude<SiteHealthView, 'technical'>
  tabbed?: boolean
  children: ReactNode
}) {
  return (
    <div
      id={tabbed ? `site-health-${view}-panel` : undefined}
      role={tabbed ? 'tabpanel' : undefined}
      aria-labelledby={tabbed ? `site-health-${view}-tab` : undefined}
      className="min-w-0"
    >
      {children}
    </div>
  )
}

function ActiveScanState({
  status,
  progress,
  progressError,
  onRetryProgress,
  pageHealthDestination = false,
  livePageHealthPreview,
  livePageHealthError = false,
  livePageHealthRunId = null,
  continuation,
}: {
  status: SiteAuditProgressSnapshot['phase'] | 'running'
  progress?: SiteAuditProgressSnapshot | null
  progressError?: boolean
  onRetryProgress?: () => void
  pageHealthDestination?: boolean
  livePageHealthPreview?: LivePageHealthPreviewView | null
  livePageHealthError?: boolean
  livePageHealthRunId?: string | null
  continuation?: ReactNode
}) {
  const attempt = progress?.attempt ?? null
  const phase = progress?.phase ?? status
  const arrangingMap = phase === 'arranging-map'

  return (
    <section
      aria-label="Current scan progress"
      className="rounded-lg border border-caution bg-caution-soft px-5 py-6"
    >
      <h2 className="min-h-6 text-base font-semibold text-heading">
        {arrangingMap && pageHealthDestination ? 'Preparing page health' : arrangingMap ? 'Preparing site map' : 'Scanning site'}
      </h2>
      <p aria-atomic="true" aria-label="Current scan progress" aria-live="polite" role="status" className="mt-1 min-h-[4.5rem] text-sm text-secondary sm:min-h-10">
        {pageHealthDestination
          ? arrangingMap
            ? 'Finalizing page health. The scan is complete and its findings are being published.'
            : `${scanPhaseCopy(phase)}. Page health appears after the scan finishes.`
          : arrangingMap
            ? 'Arranging map. The scan is complete and its map is being published.'
            : `${scanPhaseCopy(phase)}. The map appears after the scan finishes.`}
      </p>
      <dl aria-label="Live scan counters" className="mt-5 grid grid-cols-2 divide-x divide-y divide-default rounded-lg border border-default bg-surface-subtle sm:grid-cols-4 sm:divide-y-0">
          <div className="px-4 py-3">
            <dt className="text-sm text-secondary">Pages found</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-heading">{attempt ? metricValue(attempt.pagesDiscovered) : '—'}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm text-secondary">Pages checked</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-heading">{attempt ? metricValue(attempt.pagesFetched) : '—'}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm text-secondary">Links found</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-heading">{attempt ? metricValue(attempt.edgesDiscovered) : '—'}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-sm text-secondary">Pages failed</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-heading">{attempt ? metricValue(attempt.pagesErrored) : '—'}</dd>
          </div>
        </dl>
      {progressError && (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-secondary">
          <span>{arrangingMap
            ? pageHealthDestination ? 'Page health publishing status could not load.' : 'Map publishing status could not load.'
            : 'Live scan counts could not load. The scan is still running.'}</span>
          {onRetryProgress && <Button type="button" variant="secondary" size="sm" onClick={onRetryProgress}>Retry progress</Button>}
        </div>
      )}
      {pageHealthDestination ? (
        <LivePageHealthFindings
          runId={livePageHealthRunId}
          preview={livePageHealthPreview}
          error={livePageHealthError}
        />
      ) : null}
      {continuation}
    </section>
  )
}

export type LivePageHealthExampleView = {
  nodeKey: string
  url: string
  auditScore: number | null
  checksNeedingAttention: number
}

export type LivePageHealthPreviewView = {
  state: 'waiting' | 'collecting' | 'terminal'
  pagesAudited: number
  examples: readonly LivePageHealthExampleView[]
}

type LivePageHealthSlots = ReadonlyArray<LivePageHealthExampleView | null>

function emptyLivePageHealthSlots(): LivePageHealthSlots {
  return Array.from({ length: LIVE_PAGE_HEALTH_SLOT_COUNT }, () => null)
}

function sameLivePageHealthExample(
  left: LivePageHealthExampleView | null,
  right: LivePageHealthExampleView | null,
): boolean {
  return left === right || (left != null
    && right != null
    && left.nodeKey === right.nodeKey
    && left.url === right.url
    && left.auditScore === right.auditScore
    && left.checksNeedingAttention === right.checksNeedingAttention)
}

function sameLivePageHealthSlots(left: LivePageHealthSlots, right: LivePageHealthSlots): boolean {
  return left.length === right.length && left.every((slot, index) => sameLivePageHealthExample(slot, right[index] ?? null))
}

/**
 * An in-progress audit only returns a small, changeable sample. Once an
 * example has occupied a row, keep it there for this run. That avoids visual
 * churn when a later poll sorts the sample differently or no longer includes
 * a previously seen page.
 */
function latchLivePageHealthExamples(
  current: LivePageHealthSlots,
  examples: readonly LivePageHealthExampleView[],
): LivePageHealthSlots {
  const next = [...current]

  for (const example of examples) {
    const existingIndex = next.findIndex((slot) => slot?.nodeKey === example.nodeKey)
    if (existingIndex >= 0) {
      next[existingIndex] = example
      continue
    }

    const emptyIndex = next.findIndex((slot) => slot == null)
    if (emptyIndex < 0) break
    next[emptyIndex] = example
  }

  return next
}

/**
 * Provisional examples are intentionally not a mini Page Health table. The
 * fixed three-row sample is enough to establish that useful evidence is
 * arriving, while keeping the scan panel from moving on every three-second
 * poll. A different run starts with a clean set of slots.
 */
export function LivePageHealthFindings({
  runId,
  preview,
  error = false,
}: {
  runId: string | null
  preview?: LivePageHealthPreviewView | null
  error?: boolean
}) {
  const [latched, setLatched] = useState<{
    runId: string | null
    slots: LivePageHealthSlots
  }>(() => ({ runId, slots: emptyLivePageHealthSlots() }))
  // A terminal preview is the handoff to immutable Page Health. Hide the
  // sample in the same render that terminal state arrives, rather than
  // waiting for scan history or progress to refetch.
  const terminal = preview?.state === 'terminal'
  const slots = terminal || latched.runId !== runId ? emptyLivePageHealthSlots() : latched.slots

  useEffect(() => {
    setLatched((current) => {
      const baseline = current.runId === runId ? current.slots : emptyLivePageHealthSlots()
      const nextSlots = terminal
        ? emptyLivePageHealthSlots()
        : latchLivePageHealthExamples(baseline, preview?.examples ?? [])
      if (current.runId === runId && sameLivePageHealthSlots(current.slots, nextSlots)) return current
      return { runId, slots: nextSlots }
    })
  }, [preview?.examples, runId, terminal])

  const pagesAudited = preview?.pagesAudited ?? 0
  const hasExamples = slots.some((slot) => slot != null)

  return (
    <section aria-labelledby="live-page-health-findings-heading" className="mt-5 border-t border-default pt-5">
      <h3 id="live-page-health-findings-heading" className="text-base font-semibold text-heading">Findings so far</h3>
      <div className="relative mt-1 min-h-[5.25rem] text-sm text-secondary sm:min-h-[3.5rem]">
        <p>Based on {numberFormatter.format(pagesAudited)} audited pages. Results may change until the scan finishes.</p>
        <p className={cn('absolute bottom-0 text-caution', error ? 'visible' : 'invisible')}>
          Live findings paused. The scan is still running.
        </p>
      </div>
      <ul
        aria-label="Live Page Health findings"
        className="mt-3 grid h-[10.5rem] grid-rows-3 divide-y divide-default overflow-hidden rounded-lg border border-default bg-surface-subtle"
      >
        {slots.map((example, index) => {
          const placeholder = example == null && index === 0 && !hasExamples
          const emptySlot = example == null && !placeholder

          return (
            <li
              key={`live-page-health-slot-${index}`}
              aria-hidden={emptySlot || undefined}
              data-testid="live-page-health-slot"
              className="grid h-14 min-h-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 sm:gap-4"
            >
              {example ? (
                <>
                  <span className="min-w-0 truncate text-sm font-medium text-strong" title={example.url}>{example.url}</span>
                  <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-secondary">
                    <span aria-hidden="true" className="sm:hidden">{numberFormatter.format(example.checksNeedingAttention)} checks</span>
                    <span className="hidden sm:inline">{numberFormatter.format(example.checksNeedingAttention)} checks need attention</span>
                    <span className="sr-only sm:hidden">{numberFormatter.format(example.checksNeedingAttention)} checks need attention</span>
                  </span>
                </>
              ) : placeholder ? (
                <span className="text-sm text-secondary">Checks that need attention will appear here.</span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function TerminalScanRecoveryState({
  phase,
  progress,
  onRunAgain,
  pageHealthDestination = false,
}: {
  phase: 'failed' | 'cancelled'
  progress?: SiteAuditProgressSnapshot | null
  onRunAgain: () => void
  pageHealthDestination?: boolean
}) {
  const cancelled = phase === 'cancelled'
  const error = progress?.error ?? progress?.attempt?.error

  return (
    <section
      aria-label="Site scan recovery"
      role="alert"
      className="rounded-lg border border-negative bg-negative-soft px-5 py-6"
    >
      <h2 className="text-base font-semibold text-negative">{cancelled ? 'Scan cancelled' : 'Scan failed'}</h2>
      <p className="mt-1 text-sm text-secondary">
        {pageHealthDestination
          ? cancelled
            ? 'The scan was cancelled before Canonry could publish page health results.'
            : 'The scan did not complete, so page health results are unavailable.'
          : cancelled
            ? 'The scan was cancelled before Canonry could publish a site map.'
            : 'The scan did not complete, so there is no site map for this run.'}
      </p>
      {error && <p className="mt-3 text-sm text-negative">{error}</p>}
      <Button type="button" className="mt-4" onClick={onRunAgain}>Run scan again</Button>
    </section>
  )
}

export function SiteHealthSection({
  projectName,
  projectId,
  initialRunId,
  onReleaseInitialRun,
  showOnboardingActions = false,
  onContinueOnboarding,
  onSkipOnboarding,
}: {
  projectName: string
  projectId: string
  /** The durable route handoff wins over a derived latest scan after reload. */
  initialRunId?: string
  /** Clears an onboarding handoff from durable route state before a replacement scan. */
  onReleaseInitialRun?: () => void
  /** Reserved for the explicit post-scan onboarding flow. */
  showOnboardingActions?: boolean
  /** Continues the explicit onboarding flow. */
  onContinueOnboarding?: () => void
  /** Leaves the explicit onboarding flow. */
  onSkipOnboarding?: () => void
}) {
  const [view, setView] = useState<SiteHealthView>('map')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => initialRunId ?? null)
  const previousInitialRunId = useRef(initialRunId)
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const [checkDeadLinks, setCheckDeadLinks] = useState(false)
  const [inventoryFilter, setInventoryFilter] = useState<InventoryFilterId>('all')
  /**
   * The map opens on content links only. Nav and footer links repeat on every
   * page, so drawing them buries the structure this view exists to show. The
   * server sends both kinds tagged, so this only changes what is DRAWN: node
   * positions were computed without template links and never move.
  */
  const [showTemplateLinks, setShowTemplateLinks] = useState(false)
  const embedded = isEmbed()
  const explicitOnboarding = showOnboardingActions && !embedded
  const runMutation = useTriggerSiteAudit()

  useEffect(() => {
    const previous = previousInitialRunId.current
    if (previous === initialRunId) return
    previousInitialRunId.current = initialRunId
    setSelectedRunId((current) => initialRunId ?? (current === previous ? null : current))
    setSelectedNodeKey(null)
  }, [initialRunId])

  // The Site Health scan history, not the generic run list: it already excludes
  // probes and says which scans kept a crawl.
  const auditRunsQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: SCAN_HISTORY_LIMIT },
    }),
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => query.state.data?.scans.some(
      (scan) => scan.status === 'queued' || scan.status === 'running',
    ) ? 3_000 : 15_000,
  })
  const auditScans = auditRunsQuery.data?.scans ?? []
  const activeAudit = auditScans.find((scan) => scan.status === 'queued' || scan.status === 'running')
  const latestTerminalAudit = auditScans
    .find((scan) => scan.status === 'completed' || scan.status === 'partial')
  const mutationRunId = explicitOnboarding ? runMutation.data?.runId ?? null : null
  // During explicit setup, a replacement scan remains the current work through
  // every status transition. Its own terminal evidence or recovery must replace
  // the prior result; merely appearing in scan history does not release it.
  const requestedRunId = selectedRunId ?? (explicitOnboarding
    ? mutationRunId ?? activeAudit?.runId ?? latestTerminalAudit?.runId
    : latestTerminalAudit?.runId ?? activeAudit?.runId) ?? null
  // Scan history is eventually consistent. Keep its active state only until
  // the exact progress read for this selected run can say otherwise.
  const activeRequestedRun = activeAudit?.runId === requestedRunId ? activeAudit : null
  const requestedAuditRun = requestedRunId
    ? auditScans.find((scan) => scan.runId === requestedRunId)
    : undefined
  const isInitialRunSelection = Boolean(initialRunId && requestedRunId === initialRunId)
  const isMutationRunSelection = Boolean(mutationRunId && requestedRunId === mutationRunId)
  const mutationNeedsExactProgress = isMutationRunSelection && !requestedAuditRun
  const exactProgressRunId = activeRequestedRun?.runId
    ?? (isInitialRunSelection || mutationNeedsExactProgress ? requestedRunId : null)

  const activeProgressQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressOptions({
      client: heyClient,
      path: { name: projectName, runId: exactProgressRunId ?? '' },
    }),
    enabled: Boolean(exactProgressRunId),
    refetchInterval: (query) => shouldPollSiteAuditProgress(query.state.data?.phase) ? 3_000 : false,
  })
  useEffect(() => {
    if (!isInitialRunSelection || !activeProgressQuery.isError) return
    if (queryErrorCode(activeProgressQuery.error) !== 'NOT_FOUND') return
    setSelectedRunId(null)
    setSelectedNodeKey(null)
    onReleaseInitialRun?.()
  }, [activeProgressQuery.error, activeProgressQuery.isError, isInitialRunSelection, onReleaseInitialRun])
  const exactProgressActive = isActiveSiteAuditPhase(activeProgressQuery.data?.phase)
  const exactProgressTerminal = isTerminalSiteAuditPhase(activeProgressQuery.data?.phase)
  // A terminal exact run is authoritative over stale `running` scan history.
  // Without this, the active-history guard can withhold a persisted crawl and
  // leave onboarding on provisional progress after the scan has finished.
  const activeRunWithoutPublishedMap = exactProgressTerminal ? null : activeRequestedRun
  const exactProgressPending = Boolean(exactProgressRunId && activeProgressQuery.isPending)
  const exactProgressNeedsAuthority = Boolean(
    (isInitialRunSelection || isMutationRunSelection) && !requestedAuditRun,
  )
  const exactProgressUnavailable = Boolean(exactProgressNeedsAuthority && activeProgressQuery.isError)
  const livePageHealthPreviewEnabled = Boolean(
    explicitOnboarding
    && exactProgressRunId
    && (activeRunWithoutPublishedMap?.runId === exactProgressRunId || exactProgressActive),
  )
  const livePageHealthPreviewQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewOptions({
      client: heyClient,
      path: { name: projectName, runId: exactProgressRunId ?? '' },
    }),
    // This is onboarding-only evidence. Normal Site Health retains its
    // terminal, immutable result model and never fetches this live sample.
    enabled: livePageHealthPreviewEnabled,
    refetchInterval: (query) => query.state.data?.state === 'terminal' ? false : 3_000,
    refetchIntervalInBackground: true,
  })
  const deferTerminalEvidence = Boolean(
    activeRunWithoutPublishedMap
    || exactProgressActive
    || exactProgressPending
    || exactProgressUnavailable,
  )
  const recoveryPhase = activeProgressQuery.data?.phase === 'failed' || activeProgressQuery.data?.phase === 'cancelled'
    ? activeProgressQuery.data.phase
    : (isInitialRunSelection || isMutationRunSelection)
      && (requestedAuditRun?.status === 'failed' || requestedAuditRun?.status === 'cancelled')
      ? requestedAuditRun.status
      : null

  const crawlQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlOptions({
      client: heyClient,
      path: { name: projectName },
      ...(requestedRunId ? { query: { runId: requestedRunId } } : {}),
    }),
    // The crawl endpoint deliberately exposes terminal persisted crawls only.
    // Exact progress is the authoritative read while this run is still active.
    enabled: !deferTerminalEvidence,
  })
  const crawl = crawlQuery.data
  const resolvedRunId = requestedRunId ?? crawl?.runId ?? null
  const detailsEnabled = Boolean(resolvedRunId && crawl?.hasCrawlData && crawl.detailsAvailable)
  const siteExplorerEnabled = detailsEnabled && !explicitOnboarding
  const scopedRunQuery = resolvedRunId ? { runId: resolvedRunId } : {}

  const graphQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoGraphOptions({
      client: heyClient,
      path: { name: projectName },
      query: { ...scopedRunQuery, maxNodes: GRAPH_NODE_LIMIT, maxEdges: GRAPH_EDGE_LIMIT },
    }),
    // Layout publication is terminal. Fetch this large payload once after the
    // exact progress route leaves `arranging-map`, never while it is pending.
    enabled: siteExplorerEnabled && !deferTerminalEvidence,
  })
  // The chip narrows on the server, so `total` and the cursor stay truthful
  // instead of describing an unfiltered list.
  const inventoryHealthState = INVENTORY_FILTERS
    .find((option) => option.id === inventoryFilter)?.healthState
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: {
      ...scopedRunQuery,
      ...(inventoryHealthState ? { healthState: inventoryHealthState } : {}),
      limit: INVENTORY_LIMIT,
      sort: 'path' as const,
    },
  }
  const pagesQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteOptions(pagesInput),
    enabled: siteExplorerEnabled,
    initialPageParam: pagesInput,
    getNextPageParam: (lastPage) => lastPage.nextCursor
      ? {
          path: pagesInput.path,
          query: { ...pagesInput.query, cursor: lastPage.nextCursor },
        }
      : undefined,
  })
  const deadLinkDetailsEnabled = siteExplorerEnabled
    && (crawl?.deadLinks.state === 'complete' || crawl?.deadLinks.state === 'partial')
  const deadLinksQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoDeadLinksOptions({
      client: heyClient,
      path: { name: projectName },
      query: { ...scopedRunQuery, limit: DEAD_LINK_LIMIT },
    }),
    enabled: deadLinkDetailsEnabled,
  })

  const graphPages = graphQuery.data?.nodes ?? []
  const internalLinkCount = graphQuery.data?.layout.state === 'ready'
    ? graphQuery.data.totalEdges
    : null
  const graphEdges = graphQuery.data?.edges ?? []
  // Counted from the edges actually drawn, not from a site-wide total, so the
  // legend describes THIS map rather than a number the reader cannot see.
  const templateEdgeCount = useMemo(
    () => graphEdges.filter((edge) => edge.isTemplate).length,
    [graphEdges],
  )
  const contentEdgeCount = graphEdges.length - templateEdgeCount
  const templateDetection = graphQuery.data?.templateDetection ?? null
  // Which rule ran is a separate question from whether one ran at all, and only
  // the second one decides the control. Asking the contract keeps a new
  // detection value a compile error instead of a silently disabled toggle.
  const templateFilterUnavailable = templateDetection === null || !isTemplateDetectionApplied(templateDetection)
  // When detection did not run, the per-link flag proves nothing, so nothing
  // is hidden. Hiding on an untrustworthy flag would quietly drop real links
  // from the map and the copy would be a lie.
  const visibleGraphEdges = useMemo(
    () => showTemplateLinks || templateFilterUnavailable
      ? graphEdges
      : graphEdges.filter((edge) => !edge.isTemplate),
    [graphEdges, showTemplateLinks, templateFilterUnavailable],
  )
  // A scan published before template detection still has classified links (the
  // migration backfills them) but its stored positions were computed with the
  // nav mesh included. Say so rather than implying the map already reflects
  // content structure.
  const staleTemplateLayout = graphQuery.data?.layout.state === 'ready'
    && !graphQuery.data.layout.templateLinksExcluded
  const inventoryPages = useMemo(
    () => pagesQuery.data?.pages.flatMap((page) => page.pages) ?? [],
    [pagesQuery.data],
  )
  const inventoryTotal = pagesQuery.data?.pages[0]?.total ?? inventoryPages.length
  const loadedInventoryPage = useMemo(
    () => inventoryPages.find((page) => page.nodeKey === selectedNodeKey) ?? null,
    [inventoryPages, selectedNodeKey],
  )
  // The map holds up to 20,000 nodes while the inventory loads 200 at a time,
  // so a page selected on the map usually is not in the loaded window. Read
  // that ONE row by key rather than degrading: paging to find it would be the
  // scan this surface is built to avoid, and giving up loses its reasons.
  const selectedPageNeedsRead = Boolean(detailsEnabled && selectedNodeKey && !loadedInventoryPage)
  const selectedPageQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...scopedRunQuery,
        ...(inventoryHealthState ? { healthState: inventoryHealthState } : {}),
        nodeKey: selectedNodeKey ?? undefined,
        limit: 1,
      },
    }),
    enabled: selectedPageNeedsRead,
  })
  const inventoryPage = loadedInventoryPage ?? selectedPageQuery.data?.pages[0] ?? null

  /**
   * Drop the selection only when the SERVER has confirmed this page is not in
   * the filtered set. Absence from the loaded window proves nothing, and a
   * scan that cannot be filtered at all must not deselect anything either.
   */
  const selectionFilteredOut = Boolean(
    selectedNodeKey
    && inventoryHealthState
    && selectedPageNeedsRead
    && selectedPageQuery.isSuccess
    && selectedPageQuery.data.healthStateFilter === 'applied'
    && selectedPageQuery.data.pages.length === 0,
  )
  useEffect(() => {
    if (selectionFilteredOut) setSelectedNodeKey(null)
  }, [selectionFilteredOut])
  const selectedPage = useMemo(
    () => selectionFilteredOut
      ? null
      : graphPages.find((page) => page.nodeKey === selectedNodeKey) ?? inventoryPage,
    [graphPages, inventoryPage, selectedNodeKey, selectionFilteredOut],
  )
  const effectiveSelectedNodeKey = selectedPage?.nodeKey ?? null
  /**
   * A page whose own row could not be read is NOT a page with nothing to say.
   * Without this the inspector renders a hidden page with no reasons and no
   * error, which is indistinguishable from a page that genuinely has none.
   */
  const reasonsState: PageReasonsState = !selectedPage
    ? 'idle'
    : inventoryPage
      ? 'ready'
      : selectedPageQuery.isError
        ? 'error'
        : selectedPageNeedsRead && selectedPageQuery.isLoading
          ? 'loading'
          : 'ready'

  const neighborsQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...scopedRunQuery,
        nodeKey: effectiveSelectedNodeKey ?? undefined,
        limit: NEIGHBOR_LIMIT,
      },
    }),
    enabled: siteExplorerEnabled && Boolean(effectiveSelectedNodeKey),
  })
  const pageAuditQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...scopedRunQuery,
        nodeKey: effectiveSelectedNodeKey ?? undefined,
      },
    }),
    enabled: siteExplorerEnabled && Boolean(effectiveSelectedNodeKey),
  })

  // The server already orders scans newest first, so the dropdown does not
  // keep a second ordering of the same list.
  const selectableScans = useMemo(() => {
    const terminalScans = auditScans
      .filter((scan) => scan.status === 'completed' || scan.status === 'partial')
    const selectedScan = selectedRunId
      ? auditScans.find((scan) => scan.runId === selectedRunId)
      : undefined
    return selectedScan && !terminalScans.some((scan) => scan.runId === selectedScan.runId)
      ? [selectedScan, ...terminalScans]
      : terminalScans
  }, [auditScans, selectedRunId])
  const newestRunStatus = auditScans[0]?.status ?? null
  const selectedRun = resolvedRunId ? requestedAuditRun : undefined
  const status = activeRunWithoutPublishedMap
    ? activeRunWithoutPublishedMap.status
    : exactProgressActive
      ? activeProgressQuery.data?.status ?? null
    : recoveryPhase ?? crawl?.runStatus ?? selectedRun?.status ?? null
  const statusLabel = status === 'running'
    ? 'Scan running'
    : status === 'queued'
      ? 'Scan queued'
      : status === 'partial'
        ? 'Partial scan'
        : status === 'completed'
          ? 'Complete'
          : status === 'failed'
            ? 'Scan failed'
            : status === 'cancelled'
              ? 'Scan cancelled'
            : 'No scan'
  const deadLinks = deadLinksQuery.data
  const deadLinkCounts = deadLinks && 'found' in deadLinks
    ? deadLinks
    : crawl?.deadLinks && 'found' in crawl.deadLinks ? crawl.deadLinks : undefined
  const deadLinkStatus = deadLinkLabel(
    deadLinks?.state ?? crawl?.deadLinks?.state ?? 'unavailable',
    deadLinkCounts?.found,
    deadLinkCounts?.unverified,
  )
  const movedSite = movedSiteHosts(crawl?.requestedRootUrl ?? null, crawl?.rootUrl ?? null)
  const rootHost = siteHostFromUrl(crawl?.rootUrl ?? null)
  // The root is identified by the server. Sourcing it from the graph alone
  // made the row disappear on exactly the scans whose layout is missing, so
  // the inventory read (which every crawl has) is the fallback.
  const rootNodeKey = graphQuery.data?.rootNodeKey ?? null
  const rootPageQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesOptions({
      client: heyClient,
      path: { name: projectName },
      query: { ...scopedRunQuery, nodeKey: rootNodeKey ?? undefined, limit: 1 },
    }),
    enabled: Boolean(detailsEnabled && rootNodeKey),
  })
  const rootGraphPage = useMemo(
    () => graphPages.find((page) => page.nodeKey === rootNodeKey)
      ?? rootPageQuery.data?.pages[0]
      ?? null,
    [graphPages, rootNodeKey, rootPageQuery.data],
  )
  const scanBusy = runMutation.isPending || Boolean(activeRunWithoutPublishedMap) || exactProgressActive || exactProgressPending
  const showProgressState = deferTerminalEvidence || (explicitOnboarding && runMutation.isPending)
  const requestedRunIsActive = requestedAuditRun?.status === 'queued' || requestedAuditRun?.status === 'running'
  const hasOnboardingContinuationActions = Boolean(onContinueOnboarding && onSkipOnboarding)
  const showOnboardingContinuation = useOnboardingContinuationThreshold({
    active: explicitOnboarding
      && showProgressState
      && hasOnboardingContinuationActions
      && Boolean(requestedRunIsActive || (exactProgressRunId === requestedRunId && exactProgressActive)),
    runId: requestedRunId,
    createdAt: requestedAuditRun?.createdAt,
  })
  const siteAuditReady = Boolean(crawl?.hasCrawlData && !showProgressState && !recoveryPhase)
  // Explicit onboarding has one task per state. A usable terminal crawl opens
  // Page health immediately; active and recovery states stay on the scan view.
  const currentView: SiteHealthView = explicitOnboarding
    ? siteAuditReady ? 'technical' : 'map'
    : view
  const transientView = currentView === 'technical' ? 'map' : currentView
  const selectRun = (runId: string) => {
    setSelectedRunId(runId || null)
    setSelectedNodeKey(null)
  }
  const startScan = () => {
    // Release any pinned scan before dispatching its replacement.
    // Otherwise the durable URL handoff keeps the old run selected while the
    // newly queued scan progresses invisibly in the background.
    setSelectedRunId(null)
    setSelectedNodeKey(null)
    if (initialRunId) onReleaseInitialRun?.()
    runMutation.mutate({
      projectName,
      projectId,
      body: { checkDeadLinks: explicitOnboarding || checkDeadLinks },
    })
  }
  const selectSection = (path: string) => {
    const matchingPage = graphPages.find((page) => page.path === path || page.path.startsWith(`${path}/`))
    if (matchingPage) setSelectedNodeKey(matchingPage.nodeKey)
  }

  const selectView = (nextView: SiteHealthView) => setView(nextView)
  const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % SITE_HEALTH_VIEWS.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + SITE_HEALTH_VIEWS.length) % SITE_HEALTH_VIEWS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = SITE_HEALTH_VIEWS.length - 1
    }
    if (nextIndex == null) return
    event.preventDefault()
    selectView(SITE_HEALTH_VIEWS[nextIndex]!.id)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="space-y-5">
      {explicitOnboarding ? <OnboardingProgress current={siteAuditReady ? 'fixes' : 'site'} /> : null}
      {!explicitOnboarding && <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-heading">Site Health</h2>
            <InfoTooltip text={SITE_HEALTH_VIEW_DESCRIPTIONS[currentView]} />
            <ToneBadge tone={scanTone(status)}>{statusLabel}</ToneBadge>
            {selectedRun && (
              <span className="text-xs text-muted">{formatScanDate(selectedRun.finishedAt ?? selectedRun.startedAt)}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <label className="grid gap-1 text-xs text-muted">
            Scan history
            <select
              aria-label="View a Site Health scan"
              value={selectedRunId ?? ''}
              onChange={(event) => selectRun(event.target.value)}
              className="h-9 min-w-48 rounded-md border border-base bg-bg px-3 text-sm text-primary outline-none focus:border-strong focus:ring-2 focus:ring-mono-600"
            >
              <option value="">Latest scan</option>
              {selectableScans.map((scan) => (
                <option key={scan.runId} value={scan.runId}>{scanOptionLabel(scan)}</option>
              ))}
            </select>
          </label>

          {!embedded && (
            <div className="flex items-end gap-2 pt-5">
              <details className="group relative">
                <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-base bg-bg px-3 text-sm font-medium text-heading outline-none hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-mono-400">
                  <Settings2 className="size-4" aria-hidden="true" />
                  Scan settings
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-strong bg-bg-elevated p-4 shadow-[0_12px_32px_var(--color-shadow-panel)]">
                  <label className="flex cursor-pointer items-start gap-3 text-sm text-heading">
                    <input
                      type="checkbox"
                      aria-label="Check dead links"
                      checked={checkDeadLinks}
                      disabled={scanBusy}
                      onChange={(event) => setCheckDeadLinks(event.target.checked)}
                      className="mt-0.5 size-4 rounded border-base accent-mono-200 focus:ring-2 focus:ring-mono-400"
                    />
                    <span>
                      <span className="font-medium">Check dead links</span>
                      <span className="mt-1 block text-sm text-secondary">Adds dead-link analysis to this scan.</span>
                    </span>
                  </label>
                </div>
              </details>
              <WriteButton onClick={startScan} disabled={scanBusy}>
                {scanBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                {activeAudit?.status === 'running' ? 'Scan running' : activeAudit?.status === 'queued' ? 'Scan queued' : 'Run scan'}
              </WriteButton>
            </div>
          )}
        </div>
      </header>}

      {crawl?.hasCrawlData && currentView !== 'technical' && (
        <div className="grid grid-cols-2 divide-x divide-y divide-default rounded-lg border border-default bg-surface-subtle sm:grid-cols-4 sm:divide-y-0">
          <div className="px-4 py-3">
            <div className="flex items-center gap-1 text-xs text-muted">
              Pages found
              <InfoTooltip text={siteHealthMetricHelp('pagesFound', false)} />
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesDiscovered)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-1 text-xs text-muted">
              Pages checked
              <InfoTooltip text={siteHealthMetricHelp('pagesChecked', false)} />
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesFetched)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted" title={siteGraphStatusDescription('eligible')}>Indexable</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesEligible)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-1 text-xs text-muted">
              Internal links
              <InfoTooltip text={siteHealthMetricHelp('internalLinks', false)} />
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(internalLinkCount)}</div>
          </div>
        </div>
      )}

      {!explicitOnboarding && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default">
        <div role="tablist" aria-label="Site Health views" aria-orientation="horizontal" className="flex min-w-0 gap-5">
          {SITE_HEALTH_VIEWS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`site-health-${item.id}-tab`}
              aria-selected={currentView === item.id}
              aria-controls={`site-health-${item.id}-panel`}
              tabIndex={currentView === item.id ? 0 : -1}
              ref={(element) => { tabRefs.current[index] = element }}
              onClick={() => selectView(item.id)}
              onKeyDown={(event) => handleViewKeyDown(event, index)}
              className={`min-h-11 border-b-2 px-0.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-50 ${
                currentView === item.id
                  ? 'border-strong text-heading'
                  : 'border-transparent text-secondary hover:border-base hover:text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {crawl?.hasCrawlData && currentView !== 'technical' && (
          <div className="flex items-center gap-2 pb-2">
            <span className="text-xs text-muted">Dead-link check</span>
            <ToneBadge tone={deadLinkStatus.tone}>{deadLinkStatus.label}</ToneBadge>
          </div>
        )}
      </div>}

      {!selectedRunId && activeAudit && !activeRunWithoutPublishedMap && (
        <div className="rounded-lg border border-caution bg-caution-soft px-4 py-3 text-sm text-caution" role="status">
          A newer scan is running. The latest published result remains available until it finishes.
        </div>
      )}
      {movedSite && (
        <div className="rounded-lg border border-base bg-surface-subtle px-4 py-3 text-sm text-secondary" role="status">
          <span className="font-medium text-heading">Site address changed during this scan.</span>{' '}
          The scan started at <span className="font-mono text-primary">{movedSite.requested}</span> and continued at{' '}
          <span className="font-mono text-primary">{movedSite.effective}</span>.{' '}
          {explicitOnboarding
            ? 'Page health uses the new address.'
            : 'The map and inventory use the new address.'}
        </div>
      )}
      {crawl?.hasCrawlData && !crawl.complete && (
        <div className="rounded-lg border border-caution bg-caution-soft px-4 py-3 text-sm text-caution" role="status">
          {terminationCopy(crawl.termination)}
        </div>
      )}
      {!activeAudit && newestRunStatus === 'failed' && !selectedRunId && (
        <div className="flex gap-3 rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>The latest scan failed. The previous completed results remain available.</span>
        </div>
      )}

      {recoveryPhase ? (
        <TransientSiteHealthPanel view={transientView} tabbed={!explicitOnboarding}>
          <TerminalScanRecoveryState
            phase={recoveryPhase}
            progress={activeProgressQuery.data}
            onRunAgain={startScan}
            pageHealthDestination={explicitOnboarding}
          />
        </TransientSiteHealthPanel>
      ) : showProgressState ? (
        <TransientSiteHealthPanel view={transientView} tabbed={!explicitOnboarding}>
          <ActiveScanState
            status={activeProgressQuery.data?.phase ?? (activeRunWithoutPublishedMap?.status === 'running' ? 'running' : 'queued')}
            progress={activeProgressQuery.data}
            progressError={activeProgressQuery.isError}
            onRetryProgress={() => { void activeProgressQuery.refetch() }}
            pageHealthDestination={explicitOnboarding}
            livePageHealthPreview={livePageHealthPreviewQuery.data}
            livePageHealthError={livePageHealthPreviewQuery.isError}
            livePageHealthRunId={exactProgressRunId}
            continuation={showOnboardingContinuation ? (
              <OnboardingContinuationActions
                onContinueOnboarding={onContinueOnboarding}
                onSkipOnboarding={onSkipOnboarding}
              />
            ) : null}
          />
        </TransientSiteHealthPanel>
      ) : currentView === 'technical' ? (
        <div
          id="site-health-technical-panel"
          role={explicitOnboarding ? undefined : 'tabpanel'}
          aria-labelledby={explicitOnboarding ? undefined : 'site-health-technical-tab'}
          className="min-w-0 space-y-6"
        >
          {explicitOnboarding ? (
            <h2 className="text-xl font-semibold tracking-tight text-heading">Page health</h2>
          ) : null}
          <TechnicalAeoSection
            projectName={projectName}
            projectId={projectId}
            runId={resolvedRunId}
            integrated
            compactCopy={explicitOnboarding}
            footer={explicitOnboarding && siteAuditReady ? (
              <section aria-labelledby="ai-visibility-next-heading" className="mt-5 flex flex-col gap-3 border-t border-default pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 id="ai-visibility-next-heading" className="text-base font-semibold text-heading">Next: Set up AI Visibility</h2>
                  <p className="mt-1 text-sm text-secondary">
                    See whether answer engines mention your brand and cite your pages.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" onClick={onContinueOnboarding}>Set up AI Visibility</Button>
                  <Button type="button" variant="secondary" onClick={onSkipOnboarding}>Skip for now</Button>
                </div>
              </section>
            ) : undefined}
            unavailableFooter={explicitOnboarding && siteAuditReady ? (
              <section aria-label="Page health recovery" className="mt-4">
                <Button
                  type="button"
                  disabled={scanBusy}
                  onClick={() => {
                    setView('map')
                    startScan()
                  }}
                >
                  Run site audit again
                </Button>
              </section>
            ) : undefined}
          />
        </div>
      ) : crawlQuery.isLoading ? (
        <TransientSiteHealthPanel view={currentView} tabbed={!explicitOnboarding}>
          <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-secondary" role="status">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Loading site health...
          </div>
        </TransientSiteHealthPanel>
      ) : crawlQuery.error ? (
        <TransientSiteHealthPanel view={currentView} tabbed={!explicitOnboarding}>
          <section className="rounded-lg border border-negative bg-negative-soft px-5 py-6" role="alert">
            <h2 className="font-semibold text-negative">Site Health could not load</h2>
            <p className="mt-1 text-sm text-negative">Try loading the crawl again.</p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => void crawlQuery.refetch()}>Try again</Button>
          </section>
        </TransientSiteHealthPanel>
      ) : !crawl?.hasCrawlData ? (
        <TransientSiteHealthPanel view={currentView} tabbed={!explicitOnboarding}>
          <section className="rounded-lg border border-default bg-surface-subtle px-5 py-8 text-center">
            <h2 className="text-base font-semibold text-heading">
              {explicitOnboarding ? 'Page health results unavailable' : 'Full-site map not available'}
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-secondary">
              {explicitOnboarding
                ? 'This scan did not produce page health results. Run it again to continue setup.'
                : crawl?.legacyAuditAvailable
                ? 'Existing page health results are preserved. Run a new scan to build the page and internal-link map.'
                : embedded
                  ? 'A full-site scan has not been run for this project.'
                  : 'Run a scan to discover pages, site sections, and internal links.'}
            </p>
            {(crawl?.legacyAuditAvailable || explicitOnboarding) && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {crawl?.legacyAuditAvailable && !explicitOnboarding && (
                  <Button variant="secondary" size="sm" onClick={() => setView('technical')}>View page health</Button>
                )}
                {explicitOnboarding && (
                  <Button type="button" size="sm" onClick={startScan}>Run scan again</Button>
                )}
              </div>
            )}
          </section>
        </TransientSiteHealthPanel>
      ) : !crawl.detailsAvailable ? (
        <TransientSiteHealthPanel view={currentView} tabbed={!explicitOnboarding}>
          <section className="rounded-lg border border-caution bg-caution-soft px-5 py-6">
            <h2 className="font-semibold text-caution">
              {explicitOnboarding ? 'Page health results unavailable' : 'Page details unavailable'}
            </h2>
            <p className="mt-1 text-sm text-caution">
              {explicitOnboarding
                ? 'This scan did not publish page-level results. Run it again to continue setup.'
                : 'Summary metrics are preserved for this scan, but its page graph cannot be opened.'}
            </p>
            {explicitOnboarding ? (
              <Button type="button" size="sm" className="mt-4" onClick={startScan}>Run scan again</Button>
            ) : null}
          </section>
        </TransientSiteHealthPanel>
      ) : currentView === 'inventory' ? (
        <div id="site-health-inventory-panel" role="tabpanel" aria-labelledby="site-health-inventory-tab" className="space-y-5">
          {pagesQuery.isLoading ? (
            <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-secondary" role="status">
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              Loading page inventory...
            </div>
          ) : pagesQuery.error ? (
            <p className="rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
              The page inventory could not be loaded.
            </p>
          ) : (
            <InventoryTable
              pages={inventoryPages}
              total={inventoryTotal}
              filterUnavailable={pagesQuery.data?.pages[0]?.healthStateFilter === 'unavailable-legacy-scan'}
              selectedNodeKey={effectiveSelectedNodeKey}
              onSelect={setSelectedNodeKey}
              hasNextPage={Boolean(pagesQuery.hasNextPage)}
              isFetchingNextPage={pagesQuery.isFetchingNextPage}
              onLoadMore={() => void pagesQuery.fetchNextPage()}
              filter={inventoryFilter}
              onFilterChange={setInventoryFilter}
            />
          )}
          <PageInspector
            page={selectedPage}
            isLoading={neighborsQuery.isLoading && Boolean(selectedPage)}
            error={neighborsQuery.error}
            inbound={neighborsQuery.data?.inbound ?? []}
            outbound={neighborsQuery.data?.outbound ?? []}
            inboundTruncated={neighborsQuery.data?.inboundTruncated ?? false}
            outboundTruncated={neighborsQuery.data?.outboundTruncated ?? false}
            audit={pageAuditQuery.data}
            auditLoading={pageAuditQuery.isLoading && Boolean(selectedPage)}
            auditError={pageAuditQuery.error}
            onRetryAudit={() => { void pageAuditQuery.refetch() }}
            rootHost={rootHost}
            reasonSource={inventoryPage}
            reasonsState={reasonsState}
            onRetryReasons={() => { void selectedPageQuery.refetch() }}
            showTemplateLinks={showTemplateLinks || templateFilterUnavailable}
          />
        </div>
      ) : (
        <div id="site-health-map-panel" role="tabpanel" aria-labelledby="site-health-map-tab" className="space-y-5">
          <section aria-labelledby="site-map-heading">
            <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
              <div>
                <div className="flex items-center gap-1">
                  <h2 id="site-map-heading" className="text-base font-semibold text-heading">Site map</h2>
                  <InfoTooltip text={SITE_MAP_HELP} />
                </div>
              </div>
              {graphQuery.data?.sampled && (
                <span className="text-xs text-muted">
                  Showing {metricValue(graphQuery.data.nodes.length)} of {metricValue(graphQuery.data.totalNodes)} pages
                  {' · '}
                  {metricValue(graphQuery.data.edges.length)} of {metricValue(graphQuery.data.totalEdges)} links
                </span>
              )}
            </div>

            {graphQuery.data?.layout.state === 'ready' && graphEdges.length > 0 && (
              <div className="mb-3 flex flex-col gap-1.5 rounded-lg border border-default bg-surface-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                {/*
                  One line, the numbers only. The rule that produced them and
                  any staleness warning are always available on the tooltip, in
                  every state, because these counts are the output of a rule and
                  the rule can change between scans: a reader who cannot see
                  which rule ran cannot tell a real change on the site from a
                  change in how it was measured.
                */}
                <p className="flex items-center gap-1 text-sm text-secondary" data-testid="site-map-link-counts">
                  {siteMapLinkCountsLabel({
                    filterUnavailable: templateFilterUnavailable,
                    showTemplateLinks,
                    contentEdgeCount,
                    templateEdgeCount,
                    totalEdgeCount: graphEdges.length,
                  })}
                  <InfoTooltip text={siteMapLinkRuleHelp(templateDetection, {
                    staleLayout: staleTemplateLayout && !templateFilterUnavailable,
                  })} />
                </p>
                <label
                  className={cn(
                    'flex shrink-0 items-center gap-2 text-sm',
                    templateFilterUnavailable ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-heading',
                  )}
                  title={templateFilterUnavailable
                    ? templateDetectionCopy(templateDetection)
                    : 'Menu and footer links are drawn on top. Pages do not move, because the map was laid out from the links in your page text.'}
                >
                  <input
                    type="checkbox"
                    checked={showTemplateLinks && !templateFilterUnavailable}
                    disabled={templateFilterUnavailable}
                    onChange={(event) => setShowTemplateLinks(event.target.checked)}
                    className="size-4 rounded border-base accent-mono-200 focus:ring-2 focus:ring-mono-400"
                  />
                  Show menu and footer links
                </label>
              </div>
            )}

            <div id="site-health-map-explorer" className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
              <aside className="rounded-lg border border-default bg-surface-subtle" aria-labelledby="site-sections-heading">
                <div className="border-b border-default px-4 py-3">
                  <h3 id="site-sections-heading" className="text-sm font-semibold text-heading">Site sections</h3>
                  <p className="mt-1 text-xs text-muted">Folders in this scan</p>
                </div>
                <div className="max-h-[468px] overflow-auto">
                  {resolvedRunId && (
                    <SiteSectionChildren
                      projectName={projectName}
                      runId={resolvedRunId}
                      parentPath="/"
                      onSelect={selectSection}
                      rootPage={rootGraphPage}
                      onSelectRootPage={setSelectedNodeKey}
                    />
                  )}
                </div>
              </aside>

              <div className="min-w-0">
                {graphQuery.isLoading ? (
                  <GraphLoadingState />
                ) : graphQuery.error ? (
                  <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-negative bg-negative-soft px-6 text-center lg:min-h-[520px]" role="alert">
                    <div>
                      <p className="text-sm font-medium text-negative">The interactive map could not be loaded.</p>
                      <p className="mt-1 text-sm text-secondary">The page inventory and technical findings remain available.</p>
                      <Button variant="secondary" size="sm" className="mt-4" onClick={() => setView('inventory')}>Open page inventory</Button>
                    </div>
                  </div>
                ) : (
                  <SiteGraphSigma
                    nodes={graphQuery.data?.nodes ?? []}
                    // Every edge, always. Hiding is done by the edge reducer,
                    // so toggling template links never rebuilds the renderer.
                    edges={graphEdges}
                    showTemplateLinks={showTemplateLinks || templateFilterUnavailable}
                    layoutState={graphQuery.data?.layout.state ?? 'unavailable'}
                    layoutUnavailableReason={graphQuery.data?.layout.state === 'unavailable' ? graphQuery.data.layout.reason : null}
                    rootNodeKey={graphQuery.data?.rootNodeKey ?? null}
                    selectedNodeKey={effectiveSelectedNodeKey}
                    onSelectNode={(node) => setSelectedNodeKey(node.nodeKey)}
                    onOpenInventory={() => setView('inventory')}
                    ariaLabel={`Interactive site map showing ${metricValue(graphQuery.data?.nodes.length ?? 0)} pages and ${metricValue(visibleGraphEdges.length)} internal links`}
                  />
                )}
              </div>
            </div>

          </section>

          <PageInspector
            page={selectedPage}
            isLoading={neighborsQuery.isLoading && Boolean(selectedPage)}
            error={neighborsQuery.error}
            inbound={neighborsQuery.data?.inbound ?? []}
            outbound={neighborsQuery.data?.outbound ?? []}
            inboundTruncated={neighborsQuery.data?.inboundTruncated ?? false}
            outboundTruncated={neighborsQuery.data?.outboundTruncated ?? false}
            audit={pageAuditQuery.data}
            auditLoading={pageAuditQuery.isLoading && Boolean(selectedPage)}
            auditError={pageAuditQuery.error}
            onRetryAudit={() => { void pageAuditQuery.refetch() }}
            rootHost={rootHost}
            reasonSource={inventoryPage}
            reasonsState={reasonsState}
            onRetryReasons={() => { void selectedPageQuery.refetch() }}
            showTemplateLinks={showTemplateLinks || templateFilterUnavailable}
          />
        </div>
      )}
    </div>
  )
}
