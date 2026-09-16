import { REPORT_VISIBILITY_COPY as visibilityCopy, reportQueryClassLabel, reportVisibilityRate, reportVisibilityEvidence, reportVisibilityComparison, reportVisibilityMeasurementLabel, reportVisibilityHistoryLabel, reportVisibilityLocationLabel, type ReportVisibility } from '@ainyc/canonry-contracts'
import { shareOfVoiceReason, shareOfVoiceSummary } from '@ainyc/canonry-contracts'
import type {
  AiSourceCategoryBucket,
  CitationsTrendPoint,
  GscQueryRow,
  ProjectReportDto,
  ReportActionPlanItem,
  ReportAudience,
  ReportInsight,
} from '@ainyc/canonry-contracts'
import {
  absolutizeProjectUrl,
  actionConfidenceLabel,
  CitationStates,
  contentActionLabel,
  winnabilityClassLabel,
  dedupeReportOpportunities,
  deltaPercent,
  deltaTone,
  describeLandingPage,
  formatDate,
  formatDeltaCopy,
  formatIsoDate,
  formatNumber,
  formatRatio,
  formatWindowCountDelta,
  reportActionCategoryLabel,
  reportActionTone,
  reportSeverityLabel,
  reportInsightTone,
  reportPressureTone,
  reportSourceCategoryTone,
  safeLinkHref,
} from '@ainyc/canonry-contracts'
// Every visible string the SPA report shares comes from the contracts copy
// module (report parity). Byte snapshots in test/report-renderer-bytes.test.ts
// pin the output, so moving copy there changes nothing a reader downloads.
import {
  REPORT_HEADER_COPY,
  REPORT_SECTION_COPY,
  ReportSectionIds,
  reportActionConfidenceBadge,
  reportActionHorizonBadge,
  reportAudienceActions,
  reportBarChartLabel,
  reportCitationsTrendBaseline,
  reportCitedUrlCount,
  reportClientCitedSubtitle,
  reportClientClicksNoun,
  reportClientHeroSentence,
  reportClientIndexedPages,
  reportClientIndexingTone,
  reportClientMentionedSubtitle,
  reportClientNotIndexedTail,
  reportClientProvidersSubtitle,
  reportClientQueriesSubtitle,
  reportClientSearchCount,
  reportClientSourceCount,
  reportClientTrendCopy,
  reportCompactList,
  reportCompetitorMentionCopy,
  reportCrawlerTrustSummary,
  reportDeltaArrow,
  reportDirectionTone,
  reportExecutiveHeadline,
  reportGaIntro,
  reportGscIntro,
  reportHeaderMarketLabel,
  reportHeaderPeriodLabel,
  reportIndexingIntro,
  reportIndexingLegendLabel,
  reportInstanceCountLabel,
  reportLineChartLabel,
  reportMarketScope,
  reportMissRateLabel,
  reportMoreChipLabel,
  reportMovementChangeCopy,
  reportOpportunityActionLine,
  reportPriorWindowLabel,
  reportProviderDisplayName,
  reportProviderRateLabel,
  reportRateDeltaCopy,
  reportReferralRedirectNote,
  reportServerActivityAgencyOperatorHeaders,
  reportServerActivityAgencyTiles,
  reportServerActivityClientOperatorHeaders,
  reportServerActivityCrawledPathsNote,
  reportServerActivityHeading,
  reportServerActivityOperatorDelta,
  reportServerActivityPathHits,
  reportServerActivityTrendTitle,
  reportShareBarShareLabel,
  reportSourceCategoryShareLabel,
  reportSourceOriginHeadline,
  reportTrendProviderRates,
  reportTruncatedList,
} from '@ainyc/canonry-contracts'
import {
  groupInsights,
  isTrendBaseline,
} from '@ainyc/canonry-intelligence'

const COLORS = {
  bg: '#09090b',
  surface: '#18181b4d',
  border: '#27272a99',
  text: '#fafafa',
  textMuted: '#a1a1aa',
  textFaint: '#71717a',
  positive: '#10b981',
  caution: '#f59e0b',
  negative: '#f43f5e',
  neutral: '#71717a',
  accent: '#3b82f6',
  series: ['#10b981', '#3b82f6', '#ec4899', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ef4444'],
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Safe, escaped `href` value for anchor tags. Citation and competitor URLs in
 * the report come from LLM grounding sources, and `escapeHtml` only escapes HTML
 * metacharacters, not URL schemes. `safeLinkHref` turns a planted `javascript:`
 * or `data:` URI into `#` first, so it cannot detonate when an operator clicks
 * the link in the downloaded file.
 */
function safeHref(value: string | null | undefined): string {
  return escapeHtml(safeLinkHref(value))
}

/** A landing page cell: the path, plus the tracking-query summary with the full URL as its title. */
export function formatLandingPageHtml(raw: string): string {
  const page = describeLandingPage(raw)
  const pathHtml = `<span class="page-path">${escapeHtml(page.path)}</span>`
  if (!page.querySummary) return pathHtml
  return `${pathHtml}<span class="page-query" title="${escapeHtml(page.raw)}">${escapeHtml(page.querySummary)}</span>`
}

function renderProofChips(items: readonly string[], limit = 3): string {
  if (items.length === 0) return ''
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  const chips = visible.map(item => `<span class="proof-chip">${escapeHtml(item)}</span>`)
  if (more > 0) chips.push(`<span class="proof-chip">${reportMoreChipLabel(more)}</span>`)
  return `<div class="proof-chips">${chips.join('')}</div>`
}

const STYLE = `
:root {
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: ${COLORS.bg};
  color: ${COLORS.text};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 48px 24px 96px;
}
.header {
  border-bottom: 1px solid ${COLORS.border};
  padding-bottom: 32px;
  margin-bottom: 48px;
}
.header h1 {
  font-size: 32px;
  font-weight: 700;
  margin: 0 0 8px;
  letter-spacing: 0;
}
.header .subtitle {
  color: ${COLORS.textMuted};
  font-size: 14px;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0;
  font-size: 10px;
  color: ${COLORS.textFaint};
  font-weight: 600;
  margin-bottom: 8px;
}
section.report-section {
  margin: 64px 0;
}
section.report-section h2 {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 24px;
  letter-spacing: 0;
}
section.report-section .section-intro {
  color: ${COLORS.textMuted};
  margin-bottom: 24px;
  max-width: 760px;
}
.executive-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(240px, 0.65fr);
  gap: 16px;
  margin-bottom: 16px;
}
.headline-card {
  background: #111827;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 28px;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.headline-card .hero-kicker {
  color: ${COLORS.textMuted};
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
}
.headline-card .hero-title {
  font-size: 44px;
  line-height: 1.05;
  font-weight: 800;
  letter-spacing: 0;
  margin: 18px 0;
}
.headline-card .hero-subtitle {
  color: ${COLORS.textMuted};
  font-size: 15px;
  max-width: 620px;
}
.hero-proof-grid {
  display: grid;
  gap: 12px;
}
.hero-proof {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 18px;
}
.hero-proof .mini-label {
  color: ${COLORS.textFaint};
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: 8px;
}
.hero-proof .mini-value {
  font-size: 30px;
  line-height: 1;
  font-weight: 800;
}
.hero-proof .mini-copy {
  color: ${COLORS.textMuted};
  font-size: 12px;
  margin-top: 8px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}
.metric {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 16px 20px;
}
.metric .label {
  text-transform: uppercase;
  letter-spacing: 0;
  font-size: 10px;
  color: ${COLORS.textFaint};
  font-weight: 600;
  margin-bottom: 8px;
}
.metric .value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0;
}
.metric .delta {
  font-size: 12px;
  color: ${COLORS.textMuted};
  margin-top: 4px;
}
.findings {
  margin-top: 24px;
  display: grid;
  gap: 12px;
}
.finding {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-left-width: 3px;
  border-radius: 6px;
  padding: 12px 16px;
}
.finding.tone-positive { border-left-color: ${COLORS.positive}; }
.finding.tone-caution { border-left-color: ${COLORS.caution}; }
.finding.tone-negative { border-left-color: ${COLORS.negative}; }
.finding.tone-neutral { border-left-color: ${COLORS.neutral}; }
.finding strong { display: block; margin-bottom: 4px; }
.finding span { color: ${COLORS.textMuted}; font-size: 13px; }
.market-scope-card { margin-top: 16px; }
.market-scope-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.scope-tile {
  background: #09090b;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 14px;
}
.scope-tile .scope-label {
  color: ${COLORS.textFaint};
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: 8px;
}
.scope-tile .scope-value {
  font-size: 18px;
  line-height: 1.2;
  font-weight: 700;
}
.scope-tile .scope-copy {
  color: ${COLORS.textMuted};
  font-size: 12px;
  margin-top: 8px;
}
.scope-warning {
  margin-top: 12px;
  border: 1px solid ${COLORS.caution}55;
  background: ${COLORS.caution}14;
  border-radius: 8px;
  padding: 12px 14px;
  color: ${COLORS.textMuted};
  font-size: 13px;
}
.scope-warning strong { color: ${COLORS.text}; display: block; margin-bottom: 4px; }
.source-origin-headline { margin: 0 0 12px; font-size: 14px; color: ${COLORS.text}; }
.source-origin-headline strong { color: ${COLORS.text}; }
.source-bars { display: flex; flex-direction: column; gap: 6px; }
.source-bar-row { display: grid; grid-template-columns: 220px 1fr 90px; align-items: center; gap: 12px; font-size: 13px; }
.source-bar-label { color: ${COLORS.textMuted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-bar-track { height: 14px; background: ${COLORS.border}; border-radius: 3px; overflow: hidden; }
.source-bar-fill { height: 100%; border-radius: 3px; }
.source-bar-value { color: ${COLORS.text}; text-align: right; font-variant-numeric: tabular-nums; }
.source-bar-pct { color: ${COLORS.textFaint}; font-size: 11px; }
.driver-list { margin: 0; padding-left: 16px; font-size: 12px; color: ${COLORS.textMuted}; }
.driver-list li { margin: 2px 0; }
.table-scroll { overflow-x: auto; }
table.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
table.report-table th, table.report-table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid ${COLORS.border};
  vertical-align: top;
  overflow-wrap: break-word;
  hyphens: auto;
}
table.report-table th {
  font-weight: 600;
  color: ${COLORS.textMuted};
  text-transform: uppercase;
  letter-spacing: 0;
  font-size: 10px;
}
table.report-table td.numeric { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.report-table td.page-cell { max-width: 0; }
table.insights-table { table-layout: fixed; min-width: 680px; }
table.insights-table th.col-severity, table.insights-table td.col-severity { width: 96px; }
table.insights-table th.col-query, table.insights-table td.col-query { width: 18%; }
table.insights-table th.col-provider, table.insights-table td.col-provider { width: 88px; }
table.insights-table th.col-title, table.insights-table td.col-title { width: 28%; }
table.insights-table th.col-recommendation, table.insights-table td.col-recommendation { width: auto; }
table.report-table td.page-cell .page-path {
  display: block;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  color: ${COLORS.text};
}
table.report-table td.page-cell .page-query {
  display: inline-block;
  margin-top: 4px;
  padding: 1px 8px;
  font-size: 11px;
  color: ${COLORS.textMuted};
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 999px;
  cursor: help;
}
table.report-table td .badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid;
}
table.report-table td p.muted { margin: 2px 0 0; font-size: 12px; color: ${COLORS.textMuted}; }
.cell-cited { color: ${COLORS.positive}; font-weight: 600; }
.cell-not-cited { color: ${COLORS.textFaint}; }
.cell-pending { color: ${COLORS.textFaint}; font-style: italic; }
.tone-positive { color: ${COLORS.positive}; }
.tone-caution { color: ${COLORS.caution}; }
.tone-negative { color: ${COLORS.negative}; }
.tone-neutral { color: ${COLORS.neutral}; }
.badge.tone-positive { color: ${COLORS.positive}; border-color: ${COLORS.positive}40; background: ${COLORS.positive}14; }
.badge.tone-caution { color: ${COLORS.caution}; border-color: ${COLORS.caution}40; background: ${COLORS.caution}14; }
.badge.tone-negative { color: ${COLORS.negative}; border-color: ${COLORS.negative}40; background: ${COLORS.negative}14; }
.badge.tone-neutral { color: ${COLORS.textMuted}; border-color: ${COLORS.border}; background: transparent; }
.chart-card {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}
.chart-card h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 16px;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
  gap: 16px;
}
.mention-branded-block {
  margin-top: 20px;
}
.chart-note {
  font-size: 12px;
  line-height: 1.6;
  color: #4b5563;
  margin: 0 0 12px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  margin-top: 12px;
}
.legend-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: middle;
}
.empty-state {
  background: ${COLORS.surface};
  border: 1px dashed ${COLORS.border};
  border-radius: 8px;
  padding: 32px;
  color: ${COLORS.textMuted};
  text-align: center;
  font-size: 13px;
}
.steps {
  display: grid;
  gap: 12px;
}
.step {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 16px 20px;
  display: grid;
  gap: 4px;
}
.step .horizon {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0;
  color: ${COLORS.textFaint};
  font-weight: 600;
}
.step .title { font-weight: 600; }
.step .rationale { color: ${COLORS.textMuted}; font-size: 13px; }
.action-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.action-card {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.action-card .action-head {
  display: grid;
  grid-template-columns: 42px 1fr;
  gap: 12px;
  align-items: start;
}
.action-card .action-rank {
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 800;
  color: ${COLORS.text};
  background: #09090b;
}
.action-card .action-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.action-card h3 {
  font-size: 16px;
  margin: 8px 0 0;
}
.action-card p {
  margin: 0;
  color: ${COLORS.textMuted};
}
.action-card ul {
  margin: 0 0 12px;
  padding-left: 18px;
  color: ${COLORS.textMuted};
  font-size: 13px;
}
.action-card li { margin: 4px 0; }
.proof-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.proof-chip {
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 6px 8px;
  color: ${COLORS.textMuted};
  font-size: 12px;
  background: #09090b;
}
.action-details {
  color: ${COLORS.textMuted};
  font-size: 12px;
}
.action-details summary {
  cursor: pointer;
  color: ${COLORS.text};
  font-weight: 600;
}
.action-card .success-metric {
  color: ${COLORS.text};
  font-size: 13px;
  border-top: 1px solid ${COLORS.border};
  padding-top: 10px;
  margin-top: 12px;
}
.client-notes {
  margin-top: 18px;
  display: grid;
  gap: 8px;
}
.client-note {
  color: ${COLORS.textMuted};
  font-size: 13px;
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 10px 12px;
}
.diagnostics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.diagnostic-card {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-left-width: 3px;
  border-radius: 8px;
  padding: 14px 16px;
}
.diagnostic-card h3 { font-size: 14px; margin: 0 0 6px; }
.diagnostic-card p { margin: 0 0 8px; color: ${COLORS.textMuted}; font-size: 13px; }
.diagnostic-card ul { margin: 0; padding-left: 16px; color: ${COLORS.textMuted}; font-size: 12px; }
.diagnostic-card .proof-chips { margin-top: 10px; }
.diagnostic-card.tone-positive { border-left-color: ${COLORS.positive}; }
.diagnostic-card.tone-caution { border-left-color: ${COLORS.caution}; }
.diagnostic-card.tone-negative { border-left-color: ${COLORS.negative}; }
.diagnostic-card.tone-neutral { border-left-color: ${COLORS.neutral}; }
.opportunity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.opportunity-card {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 16px;
}
.opportunity-card .opportunity-score {
  font-size: 32px;
  line-height: 1;
  font-weight: 800;
  margin-bottom: 10px;
}
.opportunity-card .opportunity-score-suffix {
  font-size: 14px;
  font-weight: 600;
  color: ${COLORS.textFaint};
  margin-left: 4px;
}
.opportunity-card h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.opportunity-card p {
  color: ${COLORS.textMuted};
  font-size: 12px;
  margin: 0;
}
.footer {
  margin-top: 96px;
  padding-top: 24px;
  border-top: 1px solid ${COLORS.border};
  text-align: center;
  color: ${COLORS.textFaint};
  font-size: 12px;
}
.client-hero {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 16px;
  padding: 32px;
  margin-bottom: 24px;
}
.client-hero .client-hero-eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 11px;
  font-weight: 600;
  color: ${COLORS.textFaint};
}
.client-hero .client-hero-number {
  font-size: 80px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: ${COLORS.text};
  margin: 14px 0 18px;
}
.client-hero .client-hero-sentence {
  font-size: 17px;
  color: #d4d4d8;
  max-width: 720px;
  margin: 0;
}
.client-hero .client-hero-trend {
  margin-top: 14px;
  font-size: 14px;
  font-weight: 500;
}
.client-hero .client-hero-trend.tone-positive { color: ${COLORS.positive}; }
.client-hero .client-hero-trend.tone-negative { color: ${COLORS.negative}; }
.client-hero .client-hero-trend.tone-neutral { color: ${COLORS.textMuted}; }
.client-metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.client-metric-tile {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 12px;
  padding: 22px 24px;
}
.client-metric-tile .label {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 11px;
  font-weight: 600;
  color: ${COLORS.textFaint};
  margin-bottom: 14px;
}
.client-metric-tile .value {
  font-size: 48px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: ${COLORS.text};
}
.client-metric-tile .subtitle {
  margin-top: 10px;
  font-size: 12px;
  color: ${COLORS.textMuted};
}
.client-card {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 12px;
  padding: 22px 24px;
  margin-bottom: 16px;
}
.client-card h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 4px;
}
.client-card .card-subtitle {
  font-size: 12px;
  color: ${COLORS.textMuted};
  margin: 0 0 18px;
}
.client-bar-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.client-bar-row {
  display: grid;
  grid-template-columns: 140px 1fr 130px;
  align-items: center;
  gap: 14px;
  font-size: 13px;
}
.client-bar-row .bar-label { color: #d4d4d8; }
.client-bar-row .bar-track {
  height: 10px;
  background: ${COLORS.border};
  border-radius: 999px;
  overflow: hidden;
}
.client-bar-row .bar-fill {
  height: 100%;
  border-radius: 999px;
  background: ${COLORS.positive}b3;
}
.client-bar-row .bar-fill.bar-fill-neutral { background: #a1a1aaaa; }
.client-bar-row .bar-fill.bar-fill-sky { background: #38bdf8b3; }
.client-bar-row .bar-value {
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  color: ${COLORS.text};
  font-variant-numeric: tabular-nums;
}
.client-bar-row .bar-value-sub { color: ${COLORS.textFaint}; font-weight: 400; }
.client-progress-number {
  font-size: 56px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
  margin: 12px 0 4px;
}
.client-progress-number.tone-positive { color: ${COLORS.positive}; }
.client-progress-number.tone-caution { color: ${COLORS.caution}; }
.client-progress-number.tone-negative { color: ${COLORS.negative}; }
.client-progress-bar {
  height: 12px;
  background: ${COLORS.border};
  border-radius: 999px;
  overflow: hidden;
  margin: 12px 0 14px;
}
.client-progress-fill { height: 100%; border-radius: 999px; }
.client-progress-fill.tone-positive { background: ${COLORS.positive}b3; }
.client-progress-fill.tone-caution { background: ${COLORS.caution}b3; }
.client-progress-fill.tone-negative { background: ${COLORS.negative}b3; }
.client-evidence-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
  gap: 16px;
}
.client-opportunity-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.client-opportunity-list li {
  background: #09090b;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 10px 14px;
}
.client-opportunity-list li .op-query {
  font-weight: 500;
  color: ${COLORS.text};
  font-size: 13px;
}
.client-opportunity-list li .op-action {
  margin-top: 2px;
  font-size: 11px;
  color: ${COLORS.textMuted};
}
.client-confidence-note {
  background: ${COLORS.surface};
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  color: ${COLORS.textMuted};
  margin-bottom: 6px;
}
.client-explainer {
  background: #09090b;
  border: 1px solid ${COLORS.border};
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 12px;
  color: ${COLORS.textMuted};
  margin-bottom: 16px;
  line-height: 1.6;
}
.client-explainer strong { color: ${COLORS.text}; }
.client-explainer .term { color: #d4d4d8; font-weight: 500; }
.client-questions-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.client-questions-list li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: #09090b;
  border: 1px solid ${COLORS.border};
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  color: #d4d4d8;
}
.client-questions-list li .qnum {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: ${COLORS.textFaint};
  font-variant-numeric: tabular-nums;
}
@media (max-width: 760px) {
  .container { padding: 32px 16px 72px; }
  .executive-hero { grid-template-columns: 1fr; }
  .headline-card .hero-title { font-size: 34px; }
  .source-bar-row { grid-template-columns: 1fr; gap: 6px; }
  .source-bar-value { text-align: left; }
  .chart-grid { grid-template-columns: 1fr; }
  .client-hero .client-hero-number { font-size: 56px; }
  .client-metric-tile .value { font-size: 36px; }
  .client-bar-row { grid-template-columns: 100px 1fr 100px; gap: 10px; }
}
@media print {
  @page { margin: 0.5in; }
  html, body {
    background: ${COLORS.bg};
    color: ${COLORS.text};
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .container { max-width: none; padding: 0; }
  .table-scroll { overflow: visible; }
  section.report-section,
  .executive-hero,
  .headline-card,
  .hero-proof,
  .client-hero,
  .client-metric-tile,
  .client-card,
  .client-note,
  .chart-card,
  .action-card,
  .insight-card,
  .source-bar-row,
  .client-bar-row,
  tr,
  table { break-inside: avoid; }
  h1, h2, h3, .eyebrow { break-after: avoid; }
  .footer { margin-top: 32px; }
  .footer a { color: ${COLORS.text}; }
}
`

interface SectionOpts {
  id: string
  eyebrow: string
  title: string
  intro?: string
}

function section(opts: SectionOpts, body: string): string {
  return `<section class="report-section" id="${escapeHtml(opts.id)}">
    <div class="eyebrow">${escapeHtml(opts.eyebrow)}</div>
    <h2>${escapeHtml(opts.title)}</h2>
    ${opts.intro ? `<p class="section-intro">${escapeHtml(opts.intro)}</p>` : ''}
    ${body}
  </section>`
}

function renderEmpty(message: string): string {
  return `<div class="empty-state">${escapeHtml(message)}</div>`
}

function renderHeaderLocationFragment(location: ProjectReportDto['meta']['location']): string {
  return ` · ${escapeHtml(reportHeaderMarketLabel(location))}`
}


function renderLocationCard(report: ProjectReportDto): string {
  const scope = reportMarketScope(report)
  if (!scope) return ''
  const copy = REPORT_SECTION_COPY['executive-summary'].marketScope

  const warning = scope.weakProviders !== null
    ? `<div class="scope-warning">
        <strong>${copy.warningTitle}</strong>
        ${escapeHtml(scope.weakProviders)} ${copy.warningDetail}
      </div>`
    : ''

  return `<div class="chart-card market-scope-card">
    <h3>${copy.heading}</h3>
    <div class="market-scope-grid">
      <div class="scope-tile">
        <div class="scope-label">${copy.currentLabel}</div>
        <div class="scope-value">${escapeHtml(scope.currentValue)}</div>
        <div class="scope-copy">${copy.currentCopy}</div>
      </div>
      <div class="scope-tile">
        <div class="scope-label">${copy.notIncludedLabel}</div>
        <div class="scope-value">${escapeHtml(scope.notIncludedValue)}</div>
        <div class="scope-copy">${escapeHtml(scope.notIncludedCopy)}</div>
      </div>
      <div class="scope-tile">
        <div class="scope-label">${copy.providerLabel}</div>
        <div class="scope-value">${scope.providerValue}</div>
        <div class="scope-copy">${escapeHtml(scope.providerCopy)}</div>
      </div>
    </div>
    ${warning}
  </div>`
}

function renderExecutiveSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const copy = REPORT_SECTION_COPY['executive-summary']
  const headline = reportExecutiveHeadline(report)
  const heroHtml = `<div class="executive-hero">
    <div class="headline-card">
      <div>
        <div class="hero-kicker">${copy.heroKicker}</div>
        <div class="hero-title">${escapeHtml(headline.title)}</div>
      </div>
      <div class="hero-subtitle">${escapeHtml(headline.subtitle)}</div>
    </div>
    <div class="hero-proof-grid">
      <div class="hero-proof">
        <div class="mini-label">${copy.proofTiles.citationTrend}</div>
        <div class="mini-value tone-${headline.trendTone}">${escapeHtml(headline.trendLabel)}</div>
        <div class="mini-copy">${escapeHtml(headline.citedFragment)}</div>
      </div>
      <div class="hero-proof">
        <div class="mini-label">${copy.proofTiles.mentionCoverage}</div>
        <div class="mini-value">${s.mentionRate}%</div>
        <div class="mini-copy">${escapeHtml(headline.mentionedFragment)}</div>
      </div>
      <div class="hero-proof">
        <div class="mini-label">${copy.proofTiles.prioritizedActions}</div>
        <div class="mini-value">${formatNumber(headline.prioritizedActionCount)}</div>
        <div class="mini-copy">${copy.prioritizedActionsCopy}</div>
      </div>
    </div>
  </div>`
  const metrics: Array<{ label: string; value: string; delta: string }> = [
    {
      label: copy.tiles.citationRate,
      value: `${s.citationRate}%`,
      delta: `<span class="tone-${headline.trendTone}">${headline.trendLabel}</span> · ${headline.citedFragment} · ${headline.providerCountLabel}`,
    },
    {
      label: copy.tiles.mentionRate,
      value: `${s.mentionRate}%`,
      delta: headline.mentionedFragment,
    },
    {
      label: copy.tiles.queriesTracked,
      value: formatNumber(s.queryCount),
      delta: headline.competitorCountLabel,
    },
  ]
  if (s.gsc && headline.gscDelta !== null) {
    metrics.push({
      label: copy.tiles.gscClicks,
      value: formatNumber(s.gsc.clicks),
      // Only the date range can hold markup; the counts and separators cannot,
      // so escaping the whole line matches escaping the range alone.
      delta: escapeHtml(headline.gscDelta),
    })
  }
  if (s.ga && headline.gaDelta !== null) {
    metrics.push({
      label: copy.tiles.gaSessions,
      value: formatNumber(s.ga.sessions),
      delta: headline.gaDelta,
    })
  }

  const metricsHtml = `<div class="metric-grid">
    ${metrics.map(m => `<div class="metric">
      <div class="label">${escapeHtml(m.label)}</div>
      <div class="value">${m.value}</div>
      <div class="delta">${m.delta}</div>
    </div>`).join('')}
  </div>`

  const findingsHtml = s.findings.length > 0
    ? `<div class="findings">${s.findings.map(f => `
        <div class="finding tone-${f.tone}">
          <strong>${escapeHtml(f.title)}</strong>
          <span>${escapeHtml(f.detail)}</span>
        </div>`).join('')}</div>`
    : ''

  const locationHtml = renderLocationCard(report)

  return section(
    {
      id: ReportSectionIds['executive-summary'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    heroHtml + metricsHtml + findingsHtml + locationHtml,
  )
}

function deltaToneClass(direction: 'up' | 'down' | 'flat'): string {
  const tone = reportDirectionTone(direction)
  return tone === 'neutral' ? '' : `tone-${tone}`
}

function renderRateDeltaTile(
  label: string,
  delta: ProjectReportDto['whatsChanged']['citationRate'],
  unit: '%' | 'count',
): string {
  if (!delta) {
    return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">—</div><div class="delta">${REPORT_SECTION_COPY['whats-changed'].rateTileEmpty}</div></div>`
  }
  const valueSuffix = unit === '%' ? '%' : ''
  // unit='%' keeps its percentage-point copy; unit='count' routes through the
  // shared "smart %" formatter (big base → %, small base → rounded raw delta).
  // The SPA calls the same helper, so both surfaces print the same words.
  const deltaText = reportRateDeltaCopy(delta, unit)
  return `<div class="metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${deltaToneClass(delta.direction)}">${delta.current}${valueSuffix} <span style="font-size:14px;font-weight:500;">${reportDeltaArrow(delta.direction)}</span></div>
    <div class="delta">${deltaText}</div>
  </div>`
}

function renderTrafficDeltaTile(
  label: string,
  delta: ProjectReportDto['whatsChanged']['gscClicksDelta'],
  countLabel: string,
  comparisonWindowDays: number,
): string {
  if (!delta) {
    return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">—</div><div class="delta">${REPORT_SECTION_COPY['whats-changed'].trafficTileEmpty}</div></div>`
  }
  // Shared "smart %" formatter: big prior base → signed %, small base →
  // rounded absolute delta with the count label. Same helper the SPA calls.
  const deltaText = formatWindowCountDelta(delta, countLabel, reportPriorWindowLabel(comparisonWindowDays))
  return `<div class="metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${deltaToneClass(delta.direction)}">${formatNumber(delta.current)} <span style="font-size:14px;font-weight:500;">${reportDeltaArrow(delta.direction)}</span></div>
    <div class="delta">${deltaText}</div>
  </div>`
}

function renderProviderMovements(
  movements: ProjectReportDto['whatsChanged']['providerMovements'],
  audience: ReportAudience,
): string {
  const meaningful = movements.filter(m => m.direction !== 'flat')
  if (meaningful.length === 0) return ''
  const isClient = audience === 'client'
  const copy = isClient ? REPORT_SECTION_COPY['whats-changed'].client : REPORT_SECTION_COPY['whats-changed'].agency
  const rows = meaningful.map(m => {
    return `<tr>
      <td>${escapeHtml(isClient ? reportProviderDisplayName(m.provider) : m.provider)}</td>
      <td class="numeric">${m.prior}%</td>
      <td class="numeric">${m.current}%</td>
      <td class="numeric ${deltaToneClass(m.direction)}">${reportMovementChangeCopy(m)}</td>
    </tr>`
  }).join('')
  const [engineHeader, priorHeader, currentHeader, changeHeader] = copy.movementHeaders
  return `<div class="chart-card"><h3>${copy.movementsHeading}</h3>
    <div class="table-scroll"><table class="report-table">
      <thead><tr><th>${engineHeader}</th><th class="numeric">${priorHeader}</th><th class="numeric">${currentHeader}</th><th class="numeric">${changeHeader}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`
}

function renderWinsLosses(
  insights: readonly ReportInsight[],
  heading: string,
  emptyMessage: string,
  audience: ReportAudience,
): string {
  if (insights.length === 0) {
    return `<div class="chart-card"><h3>${escapeHtml(heading)}</h3>
      <p class="section-intro">${escapeHtml(emptyMessage)}</p>
    </div>`
  }
  const isClient = audience === 'client'
  const rows = insights.map(i => {
    const tone = reportInsightTone(i)
    const countChip = i.instanceCount > 1 ? ` <span class="badge tone-neutral">${reportInstanceCountLabel(i.instanceCount)}</span>` : ''
    const severityCell = isClient ? '' : `<td><span class="badge tone-${tone}">${escapeHtml(reportSeverityLabel(i.severity))}</span></td>`
    return `<tr>
      ${severityCell}
      <td>${escapeHtml(i.title)}${countChip}</td>
      <td>${escapeHtml(i.query)}</td>
      <td>${escapeHtml(isClient ? reportProviderDisplayName(i.provider) : i.provider)}</td>
    </tr>`
  }).join('')
  const headerCells = (isClient ? REPORT_SECTION_COPY['whats-changed'].client : REPORT_SECTION_COPY['whats-changed'].agency).insightHeaders
  const headers = `<tr>${headerCells.map(header => `<th>${header}</th>`).join('')}</tr>`
  return `<div class="chart-card"><h3>${escapeHtml(heading)}</h3>
    <div class="table-scroll"><table class="report-table">
      <thead>${headers}</thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`
}

function renderWhatsChanged(report: ProjectReportDto, audience: ReportAudience): string {
  const w = report.whatsChanged
  const isClient = audience === 'client'
  const { client, agency } = REPORT_SECTION_COPY['whats-changed']
  const copy = isClient ? client : agency
  const heading = { id: ReportSectionIds['whats-changed'], eyebrow: copy.eyebrow, title: copy.title, intro: isClient ? '' : w.headline }
  if (!w.enoughHistory && !w.gscClicksDelta && !w.aiReferralsDelta && w.wins.length === 0 && w.regressions.length === 0) {
    return section(heading, renderEmpty(copy.empty))
  }
  const rateTiles = `<div class="metric-grid">
    ${renderRateDeltaTile(isClient ? client.tiles.mentionRate : agency.tiles.citationRate, isClient ? w.mentionRate : w.citationRate, '%')}
    ${renderRateDeltaTile(isClient ? client.tiles.citationRate : agency.tiles.mentionRate, isClient ? w.citationRate : w.mentionRate, '%')}
    ${renderRateDeltaTile(isClient ? client.tiles.mentionedQueryCount : agency.tiles.citedQueryCount, isClient ? w.mentionedQueryCount : w.citedQueryCount, 'count')}
    ${renderTrafficDeltaTile(copy.tiles.gscClicks, w.gscClicksDelta, copy.gscCountLabel, w.comparisonWindowDays)}
    ${renderTrafficDeltaTile(copy.tiles.aiReferrals, w.aiReferralsDelta, copy.aiReferralsCountLabel, w.comparisonWindowDays)}
  </div>`
  const movements = renderProviderMovements(w.providerMovements, audience)
  const wins = renderWinsLosses(w.wins, copy.winsHeading, copy.winsEmpty, audience)
  const regressions = renderWinsLosses(w.regressions, copy.regressionsHeading, copy.regressionsEmpty, audience)
  return section(heading, `${rateTiles}${movements}${wins}${regressions}`)
}

function renderProviderBars(rates: ProjectReportDto['citationScorecard']['providerRates']): string {
  if (rates.length === 0) return ''
  const max = Math.max(...rates.map(r => r.citationRate), 100)
  const width = 600
  const height = Math.max(rates.length * 32 + 24, 80)
  const labelWidth = 80
  const padding = 8
  const barWidth = width - labelWidth - padding * 2

  const bars = rates.map((r, i) => {
    const y = i * 32 + padding
    const barHeight = 22
    const w = max > 0 ? (r.citationRate / max) * barWidth : 0
    const color = COLORS.series[i % COLORS.series.length]
    return `
      <text x="${labelWidth - 8}" y="${y + 16}" fill="${COLORS.textMuted}" font-size="11" text-anchor="end">${escapeHtml(r.provider)}</text>
      <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${COLORS.border}" opacity="0.4" rx="3" />
      <rect x="${labelWidth}" y="${y}" width="${w}" height="${barHeight}" fill="${color}" rx="3" />
      <text x="${labelWidth + w + 6}" y="${y + 16}" fill="${COLORS.text}" font-size="11">${reportProviderRateLabel(r)}</text>`
  }).join('')

  const title = REPORT_SECTION_COPY['citation-scorecard'].providerChartTitle
  return `<div class="chart-card">
    <h3>${title}</h3>
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${reportBarChartLabel(title)}">
      ${bars}
    </svg>
  </div>`
}

function renderCitationMatrix(scorecard: ProjectReportDto['citationScorecard']): string {
  const copy = REPORT_SECTION_COPY['citation-scorecard']
  const glyphs = copy.glyphs
  if (scorecard.queries.length === 0 || scorecard.providers.length === 0) {
    return renderEmpty(copy.empty)
  }
  const headers = scorecard.providers.map(p => `<th>${escapeHtml(p)}</th>`).join('')
  const rows = scorecard.queries.map((q, qi) => {
    const cells = scorecard.providers.map((_, pi) => {
      const cell = scorecard.matrix[qi]?.[pi]
      if (!cell) {
        return `<td><span class="cell-pending">${glyphs.missingCell}</span></td>`
      }
      // Two-glyph cell — citation flag then mention flag — per the AGENTS.md
      // vocabulary rules. A query can be cited without being mentioned and
      // vice versa, so a single label would conflate independent signals.
      const citedGlyph = cell.citationState === CitationStates.cited
        ? `<span class="cell-cited">${glyphs.cited}</span>`
        : `<span class="cell-not-cited">${glyphs.notCited}</span>`
      const mentionedGlyph = cell.answerMentioned === true
        ? `<span class="cell-cited">${glyphs.mentioned}</span>`
        : cell.answerMentioned === false
          ? `<span class="cell-not-cited">${glyphs.notMentioned}</span>`
          : `<span class="cell-pending">${glyphs.pending}</span>`
      return `<td>${citedGlyph} ${mentionedGlyph}</td>`
    }).join('')
    return `<tr><td>${escapeHtml(q)}</td>${cells}</tr>`
  }).join('')

  const legendCopy = copy.legend
  const legend = `<p class="section-intro" style="margin-top:0;font-size:11px;">${legendCopy.lead} <span class="cell-cited">${glyphs.cited}</span>/<span class="cell-not-cited">${glyphs.notCited}</span> ${legendCopy.citedMeaning} <span class="cell-cited">${glyphs.mentioned}</span>/<span class="cell-not-cited">${glyphs.notMentioned}</span> ${legendCopy.mentionedMeaning} <span class="cell-pending">${glyphs.pending}</span> ${legendCopy.pendingMeaning}</p>`

  return `${legend}<div class="table-scroll"><table class="report-table">
    <thead><tr><th>${copy.queryHeader}</th>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function renderCitationScorecard(report: ProjectReportDto): string {
  const body = `
    ${renderProviderBars(report.citationScorecard.providerRates)}
    ${renderCitationMatrix(report.citationScorecard)}
  `
  const copy = REPORT_SECTION_COPY['citation-scorecard']
  return section(
    { id: ReportSectionIds['citation-scorecard'], eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    body,
  )
}

interface LandscapeBar {
  label: string
  count: number
  isProject: boolean
}

function renderLandscapeBars(data: LandscapeBar[], heading: string, ariaLabel: string): string {
  if (data.length <= 1) return ''
  const max = Math.max(...data.map(d => d.count), 1)
  const width = 600
  const height = data.length * 28 + 16
  const labelWidth = 160

  const bars = data.map((d, i) => {
    const y = i * 28 + 8
    const barHeight = 18
    const w = (d.count / max) * (width - labelWidth - 60)
    const color = d.isProject ? COLORS.accent : COLORS.series[(i + 1) % COLORS.series.length]
    return `
      <text x="${labelWidth - 8}" y="${y + 13}" fill="${COLORS.textMuted}" font-size="11" text-anchor="end">${escapeHtml(d.label)}</text>
      <rect x="${labelWidth}" y="${y}" width="${w}" height="${barHeight}" fill="${color}" rx="3" />
      <text x="${labelWidth + w + 6}" y="${y + 13}" fill="${COLORS.text}" font-size="11">${d.count}</text>`
  }).join('')

  return `<div class="chart-card">
    <h3>${escapeHtml(heading)}</h3>
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapeHtml(ariaLabel)}">
      ${bars}
    </svg>
  </div>`
}

function renderCompetitorBars(landscape: ProjectReportDto['competitorLandscape'], canonical: string): string {
  const data: LandscapeBar[] = [
    { label: canonical, count: landscape.projectCitationCount, isProject: true },
    ...landscape.competitors.map(c => ({ label: c.domain, count: c.citationCount, isProject: false })),
  ]
  const title = REPORT_SECTION_COPY['competitor-landscape'].citationsChartTitle
  return renderLandscapeBars(data, title, reportBarChartLabel(title))
}

function renderMentionBars(
  section: ProjectReportDto['mentionLandscape']['nonBrand'],
  canonical: string,
  title: string,
): string {
  const data: LandscapeBar[] = [
    { label: canonical, count: section.projectMentionCount, isProject: true },
    ...section.competitors.map(c => ({ label: c.domain, count: c.mentionCount, isProject: false })),
  ]
  return renderLandscapeBars(data, title, reportBarChartLabel(title))
}

function renderReportShareOfVoice(report: ProjectReportDto): string {
  return [report.mentionLandscape.nonBrand?.shareOfVoice, report.mentionLandscape.branded?.shareOfVoice?.queryClass === 'branded' ? report.mentionLandscape.branded.shareOfVoice : undefined]
    .map(share => share ? `<div class="chart-note"><p>${escapeHtml(shareOfVoiceSummary(share.percent, share.queryClass, share))}</p>${share.reason ? `<p>${escapeHtml(shareOfVoiceReason(share.reason))}</p>` : ''}</div>` : '').join('')
}

function renderCompetitorLandscape(report: ProjectReportDto): string {
  const competitors = report.competitorLandscape.competitors
  const mentionLandscape = report.mentionLandscape
  const noCitationData = competitors.length === 0 && report.competitorLandscape.projectCitationCount === 0
  // `canonry report` renders this HTML locally from whatever the API returned,
  // so a CLI newer than its server sees a payload without the class split. Fall
  // back to "no branded data" rather than throwing: an older server's numbers
  // are pooled, which the scope label below already says.
  const brandedMentions = mentionLandscape.branded as ProjectReportDto['mentionLandscape']['branded'] | undefined
  const hasBrandedMentions = (brandedMentions?.totalAnswerSnapshots ?? 0) > 0
  const noMentionData = mentionLandscape.competitors.length === 0
    && mentionLandscape.projectMentionCount === 0
    && !hasBrandedMentions
  const copy = REPORT_SECTION_COPY['competitor-landscape']
  if (noCitationData && noMentionData) {
    return section(
      { id: ReportSectionIds['competitor-landscape'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const mentionByDomain = new Map(mentionLandscape.competitors.map(m => [m.domain, m]))
  const rows = competitors.map(c => {
    const tone = reportPressureTone(c.pressureLabel)
    const mention = mentionByDomain.get(c.domain)
    const mentionCount = mention?.mentionCount ?? 0
    const mentionTotal = mention?.totalCount ?? mentionLandscape.totalAnswerSnapshots
    const pagesDisclosure = c.theirCitedPages.length > 0
      ? `<details class="cited-pages"><summary>${reportCitedUrlCount(c.theirCitedPages.length)}</summary>
          <ul>${c.theirCitedPages.map(p => `<li><a href="${safeHref(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a> <span class="cited-for">${escapeHtml(p.citedFor.join(', '))}</span></li>`).join('')}</ul>
        </details>`
      : ''
    return `<tr>
      <td>${escapeHtml(c.domain)}</td>
      <td><span class="badge tone-${tone}">${escapeHtml(c.pressureLabel)}</span></td>
      <td class="numeric">${c.citationCount} / ${c.totalCount}</td>
      <td class="numeric">${mentionCount} / ${mentionTotal}</td>
      <td class="numeric">${c.sharePct}%</td>
      <td>${escapeHtml(reportTruncatedList(c.citedQueries, 5))}${pagesDisclosure}</td>
    </tr>`
  }).join('')

  const mentionCopy = reportCompetitorMentionCopy(mentionLandscape)
  const headers = copy.headers
  const table = competitors.length > 0
    ? `<div class="table-scroll"><table class="report-table">
        <thead><tr><th>${headers.domain}</th><th>${headers.pressure}</th><th>${headers.citations}</th><th class="numeric" title="${escapeHtml(mentionCopy.mentionsTooltip)}">${escapeHtml(mentionCopy.mentionsHeader)}</th><th class="numeric" title="${copy.citationShareTooltip}">${headers.citationShare}</th><th>${headers.citedQueries}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : renderEmpty(copy.noCompetitors)

  const citationBars = renderCompetitorBars(report.competitorLandscape, report.meta.project.canonicalDomain)
  const mentionBars = renderMentionBars(
    mentionLandscape,
    report.meta.project.canonicalDomain,
    mentionCopy.mentionsChartTitle,
  )
  const charts = citationBars && mentionBars
    ? `<div class="chart-grid">${citationBars}${mentionBars}</div>`
    : `${citationBars}${mentionBars}`
  const mentionShareUnavailable = !mentionLandscape.nonBrand?.shareOfVoice
    && mentionLandscape.projectMentionCount === 0
    && mentionLandscape.competitors.length > 0
    && mentionLandscape.competitors.every(row => row.sharePct === null)
  const mentionShareNote = mentionShareUnavailable
    ? `<p class="chart-note">${escapeHtml(mentionCopy.mentionShareUnavailable)}</p>`
    : ''

  // Branded is shown, never dropped and never merged in. Two labelled charts
  // answer two different questions: "where do I place in my category?" and
  // "when someone asks about me by name, does AI know me?"
  const brandedBars = hasBrandedMentions && brandedMentions
    ? renderMentionBars(brandedMentions, report.meta.project.canonicalDomain, copy.brandedChartTitle)
    : ''
  const brandedBlock = brandedBars
    ? `<div class="mention-branded-block">
        <p class="chart-note">${mentionCopy.brandedNote}</p>
        ${brandedBars}
      </div>`
    : ''

  return section(
    {
      id: ReportSectionIds['competitor-landscape'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    `${mentionShareNote}${charts}${table}${brandedBlock}`,
  )
}

function renderCategoryBars(buckets: AiSourceCategoryBucket[]): string {
  if (buckets.length === 0) return ''
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return ''
  const max = Math.max(...buckets.map(b => b.count), 1)

  const rows = buckets.map((b) => {
    const pct = (b.count / max) * 100
    const tone = reportSourceCategoryTone(b.category)
    const color = tone === 'negative' ? COLORS.negative
      : tone === 'caution' ? COLORS.caution
      : COLORS.accent
    return `
      <div class="source-bar-row">
        <div class="source-bar-label">${escapeHtml(b.label)}</div>
        <div class="source-bar-track">
          <div class="source-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
        </div>
        <div class="source-bar-value">${b.count} <span class="source-bar-pct">${reportSourceCategoryShareLabel(b.sharePct)}</span></div>
      </div>`
  }).join('')

  return `<div class="chart-card">
    <h3>${REPORT_SECTION_COPY['ai-source-origin'].categoriesHeading}</h3>
    <div class="source-bars">${rows}</div>
  </div>`
}

function renderShareBars(
  heading: string,
  rows: Array<{ label: string; count: number; sharePct: number; color?: string }>,
  countLabel: string,
): string {
  const visibleRows = rows.filter(r => r.count > 0 || r.sharePct > 0)
  if (visibleRows.length === 0) return ''
  const bars = visibleRows.map((r, index) => {
    const pct = Math.max(0, Math.min(100, r.sharePct))
    const color = r.color ?? COLORS.series[index % COLORS.series.length]
    return `
      <div class="source-bar-row">
        <div class="source-bar-label">${escapeHtml(r.label)}</div>
        <div class="source-bar-track">
          <div class="source-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
        </div>
        <div class="source-bar-value">${formatNumber(r.count)} <span class="source-bar-pct">${escapeHtml(reportShareBarShareLabel(countLabel, r.sharePct))}</span></div>
      </div>`
  }).join('')

  return `<div class="chart-card">
    <h3>${escapeHtml(heading)}</h3>
    <div class="source-bars">${bars}</div>
  </div>`
}

function renderAiSourceOrigin(report: ProjectReportDto): string {
  const origin = report.aiSourceOrigin
  const copy = REPORT_SECTION_COPY['ai-source-origin']
  if (origin.categories.length === 0 && origin.topDomains.length === 0) {
    return section(
      { id: ReportSectionIds['ai-source-origin'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const headline = reportSourceOriginHeadline(origin.categories)
  const headlineFragment = headline
    ? `<p class="source-origin-headline"><strong>${headline.share}</strong> ${headline.detail}</p>`
    : ''

  const rows = origin.topDomains.map(d => `
    <tr>
      <td>${escapeHtml(d.domain)}</td>
      <td class="numeric">${d.count}</td>
      <td>${d.isCompetitor ? `<span class="badge tone-negative">${copy.trackedCompetitorTag}</span>` : `<span class="badge tone-neutral">${copy.externalTag}</span>`}</td>
    </tr>`).join('')

  const [domainHeader, citationsHeader, tagHeader] = copy.topSourceHeaders
  const table = origin.topDomains.length > 0
    ? `<div class="chart-card"><h3>${copy.topSourcesHeading}</h3>
        <div class="table-scroll"><table class="report-table">
          <thead><tr><th>${domainHeader}</th><th class="numeric">${citationsHeader}</th><th>${tagHeader}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`
    : ''

  return section(
    {
      id: ReportSectionIds['ai-source-origin'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    `${headlineFragment}${table}${renderCategoryBars(origin.categories)}`,
  )
}

function renderLineChart(points: Array<{ x: string; y: number; label?: string }>, color: string, title: string, height = 200): string {
  if (points.length === 0) return ''
  const width = 600
  const padX = 32
  const padY = 24
  const usableW = width - padX * 2
  const usableH = height - padY * 2
  const max = Math.max(...points.map(p => p.y), 1)

  const stepX = points.length > 1 ? usableW / (points.length - 1) : 0
  const xy = points.map((p, i) => ({
    x: padX + i * stepX,
    y: padY + usableH - (p.y / max) * usableH,
    raw: p,
  }))

  const path = xy.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const dots = xy.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}" />`).join('')
  const xLabels = xy.map((p, i) => {
    if (points.length > 8 && i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return ''
    return `<text x="${p.x.toFixed(1)}" y="${(height - 4).toFixed(1)}" fill="${COLORS.textFaint}" font-size="9" text-anchor="middle">${escapeHtml(p.raw.label ?? p.raw.x)}</text>`
  }).join('')

  return `<div class="chart-card">
    <h3>${escapeHtml(title)}</h3>
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapeHtml(reportLineChartLabel(title))}">
      <line x1="${padX}" y1="${padY + usableH}" x2="${padX + usableW}" y2="${padY + usableH}" stroke="${COLORS.border}" stroke-width="1" />
      <text x="${padX - 6}" y="${(padY + 4).toFixed(1)}" fill="${COLORS.textFaint}" font-size="9" text-anchor="end">${formatNumber(max)}</text>
      <text x="${padX - 6}" y="${(padY + usableH).toFixed(1)}" fill="${COLORS.textFaint}" font-size="9" text-anchor="end">0</text>
      <path d="${path}" stroke="${color}" stroke-width="2" fill="none" />
      ${dots}
      ${xLabels}
    </svg>
  </div>`
}

function renderGsc(report: ProjectReportDto): string {
  const gsc = report.gsc
  const copy = REPORT_SECTION_COPY.gsc
  if (!gsc) {
    return section(
      { id: ReportSectionIds.gsc, eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const rows = gsc.topQueries.map((q: GscQueryRow) => `
    <tr>
      <td>${escapeHtml(q.query)}</td>
      <td class="numeric">${formatNumber(q.clicks)}</td>
      <td class="numeric">${formatNumber(q.impressions)}</td>
      <td class="numeric">${formatRatio(q.ctr)}</td>
      <td class="numeric">${q.avgPosition.toFixed(1)}</td>
      <td><span class="badge tone-neutral">${escapeHtml(q.category)}</span></td>
    </tr>`).join('')

  const categoryBars = renderShareBars(
    copy.intentHeading,
    gsc.categoryBreakdown.map((c, index) => ({
      label: c.category,
      count: c.clicks,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    copy.intentCountLabel,
  )

  const trendChart = renderLineChart(
    gsc.trend.map(t => ({ x: t.date, y: t.clicks, label: t.date.slice(5) })),
    COLORS.accent,
    copy.trendTitle,
  )

  const crossoverBlocks: string[] = []
  if (gsc.trackedButNoGsc.length > 0) {
    crossoverBlocks.push(`<div class="chart-card"><h3>${copy.untrackedDemand.heading}</h3>
      <p class="section-intro">${copy.untrackedDemand.subtitle}</p>
      ${renderProofChips(gsc.trackedButNoGsc, 6)}
    </div>`)
  }
  if (gsc.gscButNotTracked.length > 0) {
    crossoverBlocks.push(`<div class="chart-card"><h3>${copy.suggestedQueries.heading}</h3>
      <p class="section-intro">${copy.suggestedQueries.subtitle}</p>
      ${renderProofChips(gsc.gscButNotTracked, 6)}
    </div>`)
  }

  const [queryHeader, clicksHeader, impressionsHeader, ctrHeader, positionHeader, categoryHeader] = copy.topQueryHeaders

  return section(
    { id: ReportSectionIds.gsc, eyebrow: copy.eyebrow, title: copy.title, intro: reportGscIntro(report) },
    `<div class="metric-grid">
      <div class="metric"><div class="label">${copy.tiles.clicks}</div><div class="value">${formatNumber(gsc.totalClicks)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.impressions}</div><div class="value">${formatNumber(gsc.totalImpressions)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.ctr}</div><div class="value">${formatRatio(gsc.ctr)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.position}</div><div class="value">${gsc.avgPosition.toFixed(1)}</div></div>
    </div>
    ${trendChart}
    <div class="chart-card"><h3>${copy.topQueriesHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${queryHeader}</th><th class="numeric">${clicksHeader}</th><th class="numeric">${impressionsHeader}</th><th class="numeric">${ctrHeader}</th><th class="numeric">${positionHeader}</th><th>${categoryHeader}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    ${categoryBars}
    ${crossoverBlocks.join('\n')}`,
  )
}

function renderGa(report: ProjectReportDto): string {
  const ga = report.ga
  const copy = REPORT_SECTION_COPY.ga
  if (!ga) {
    return section(
      { id: ReportSectionIds.ga, eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const pageRows = ga.topLandingPages.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
      <td class="numeric">${formatNumber(p.organicSessions)}</td>
    </tr>`).join('')

  const channelBars = renderShareBars(
    copy.channelsHeading,
    ga.channelBreakdown.map((c, index) => ({
      label: c.channel,
      count: c.sessions,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    copy.channelsCountLabel,
  )

  const [pageHeader, sessionsHeader, organicHeader] = copy.topPageHeaders

  return section(
    { id: ReportSectionIds.ga, eyebrow: copy.eyebrow, title: copy.title, intro: reportGaIntro(ga) },
    `<div class="metric-grid">
      <div class="metric"><div class="label">${copy.tiles.sessions}</div><div class="value">${formatNumber(ga.totalSessions)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.users}</div><div class="value">${formatNumber(ga.totalUsers)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.organicSessions}</div><div class="value">${formatNumber(ga.totalOrganicSessions)}</div></div>
    </div>
    <div class="chart-card"><h3>${copy.topPagesHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${pageHeader}</th><th class="numeric">${sessionsHeader}</th><th class="numeric">${organicHeader}</th></tr></thead>
        <tbody>${pageRows}</tbody>
      </table></div>
    </div>
    ${channelBars}`,
  )
}

function renderSocial(report: ProjectReportDto): string {
  const social = report.socialReferrals
  const copy = REPORT_SECTION_COPY['social-referrals']
  if (!social) {
    return section(
      { id: ReportSectionIds['social-referrals'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const channelBars = renderShareBars(
    copy.channelsHeading,
    social.channels.map((c, index) => ({
      label: c.channelGroup,
      count: c.sessions,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    copy.channelsCountLabel,
  )

  const campaignRows = social.topCampaigns.map(c => `
    <tr>
      <td>${escapeHtml(c.source)}</td>
      <td>${escapeHtml(c.medium)}</td>
      <td class="numeric">${formatNumber(c.sessions)}</td>
    </tr>`).join('')

  const [sourceHeader, mediumHeader, sessionsHeader] = copy.campaignHeaders

  return section(
    { id: ReportSectionIds['social-referrals'], eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    `<div class="metric-grid">
      <div class="metric"><div class="label">${copy.tiles.sessions}</div><div class="value">${formatNumber(social.totalSessions)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.organic}</div><div class="value">${formatNumber(social.organicSessions)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.paid}</div><div class="value">${formatNumber(social.paidSessions)}</div></div>
    </div>
    ${channelBars}
    <div class="chart-card"><h3>${copy.campaignsHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${sourceHeader}</th><th>${mediumHeader}</th><th class="numeric">${sessionsHeader}</th></tr></thead>
        <tbody>${campaignRows}</tbody>
      </table></div>
    </div>`,
  )
}

function renderAiReferrals(report: ProjectReportDto): string {
  const ai = report.aiReferrals
  const copy = REPORT_SECTION_COPY['ai-referrals']
  if (!ai) {
    return section(
      { id: ReportSectionIds['ai-referrals'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const sourceBars = renderShareBars(
    copy.sourcesHeading,
    ai.bySource.map((s, index) => ({
      label: s.source,
      count: s.sessions,
      sharePct: s.sharePct,
      color: COLORS.series[(index + 2) % COLORS.series.length],
    })),
    copy.sourcesCountLabel,
  )

  const pageRows = ai.topLandingPages.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
    </tr>`).join('')

  const trendChart = renderLineChart(
    ai.trend.map(t => ({ x: t.date, y: t.sessions, label: t.date.slice(5) })),
    COLORS.series[2]!,
    copy.trendTitle,
  )

  const [pageHeader, sessionsHeader] = copy.topPageHeaders

  return section(
    { id: ReportSectionIds['ai-referrals'], eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    `<div class="metric-grid">
      <div class="metric"><div class="label">${copy.tiles.sessions}</div><div class="value">${formatNumber(ai.totalSessions)}</div></div>
    </div>
    ${trendChart}
    ${sourceBars}
    <div class="chart-card"><h3>${copy.topPagesHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${pageHeader}</th><th class="numeric">${sessionsHeader}</th></tr></thead>
        <tbody>${pageRows}</tbody>
      </table></div>
    </div>`,
  )
}

function renderServerActivity(report: ProjectReportDto, audience: ReportAudience): string {
  const sa = report.serverActivity
  const isClient = audience === 'client'
  // The server-activity headline + daily trend span the report window, and the
  // prior comparison covers the equal-length window before it.
  const windowDays = report.meta.periodDays
  // Heading copy comes from contracts so the SPA renders the same eyebrow,
  // title and intro per audience (report parity).
  const copy = REPORT_SECTION_COPY['server-activity']
  const priorWindowLabel = reportPriorWindowLabel(windowDays)
  // Client view stays silent when no source is connected — surfacing a
  // "connect a Cloud Run source" call-to-action to a client who has no
  // technical access produces noise. Agency view shows the prompt because
  // the operator is the audience that can act on it.
  if (!sa) {
    if (isClient) return ''
    return section(
      reportServerActivityHeading('agency', false, windowDays),
      renderEmpty(copy.agency.emptyNotConnected),
    )
  }
  if (!sa.hasData) {
    return section(
      reportServerActivityHeading(audience, false, windowDays),
      renderEmpty(isClient ? copy.client.empty : copy.agency.empty),
    )
  }

  const formatDelta = (d: { current: number; prior: number; deltaPct: number | null }, suffix: string) => {
    const copy = formatDeltaCopy(d, suffix, priorWindowLabel)
    if (!copy) return ''
    return `<span class="tone-${deltaTone(d.deltaPct)}">${escapeHtml(copy)}</span>`
  }

  // Referral arrivals mix paid and organic clicks. Without the split a reader
  // takes the whole number for earned AI traffic. Same string on both surfaces
  // — the API renders it (`referralArrivalsClassSummary`) so they cannot drift.
  // Same fragment verbatim in ReportPage.tsx (report parity). Without it an
  // all-redirect site reads as having no AI traffic instead of naming the one
  // thing to fix.
  const referralRedirectNote = reportReferralRedirectNote(sa.referralRedirects)
  const referralSubtitle = [formatDelta(sa.referralArrivals, copy.countNouns.sessions), escapeHtml(sa.referralArrivalsClassSummary), referralRedirectNote]
    .filter(Boolean)
    .join(' · ')

  // ── Client view (lightweight; mirrors the SPA's ServerActivityClientView) ──
  if (isClient) {
    const crawlerRequests = {
      current: sa.verifiedCrawlerHits.current + sa.unverifiedCrawlerHits.current,
      prior: sa.verifiedCrawlerHits.prior + sa.unverifiedCrawlerHits.prior,
      deltaPct: deltaPercent(
        sa.verifiedCrawlerHits.current + sa.unverifiedCrawlerHits.current,
        sa.verifiedCrawlerHits.prior + sa.unverifiedCrawlerHits.prior,
      ),
    }
    const crawlerTrustSummary = reportCrawlerTrustSummary(sa.verifiedCrawlerHits.current, sa.unverifiedCrawlerHits.current)
    const crawlerDelta = formatDelta(crawlerRequests, copy.countNouns.requests)
    const crawlerSubtitle = crawlerDelta
      ? `${escapeHtml(crawlerTrustSummary)} · ${crawlerDelta}`
      : escapeHtml(crawlerTrustSummary)
    const userFetchDelta = formatDelta(sa.aiUserFetchHits, copy.countNouns.requests)
    const userFetchSubtitle = userFetchDelta
      || escapeHtml(copy.client.userFetchFallback)
    const clientOperators = sa.byOperator
      .filter(o => o.verifiedHits > 0 || o.unverifiedHits > 0 || o.userFetchHits > 0 || o.referralArrivals > 0)
      .slice(0, 5)
    const clientOperatorRows = clientOperators.map(o => `
    <tr>
      <td>${escapeHtml(o.operator)}</td>
      <td class="numeric">${formatNumber(o.verifiedHits + o.unverifiedHits)}</td>
      <td class="numeric">${formatNumber(o.userFetchHits)}</td>
      <td class="numeric">${formatNumber(o.referralArrivals)}</td>
    </tr>`).join('')

    const [toolHeader, botRequestsHeader, userFetchesHeader, referralSessionsHeader] = reportServerActivityClientOperatorHeaders(windowDays)

    return section(
      reportServerActivityHeading('client', true, windowDays),
      `<div class="metric-grid">
        <div class="metric">
          <div class="label">${copy.client.tiles.botRequests}</div>
          <div class="value">${formatNumber(crawlerRequests.current)}</div>
          <div class="subtitle">${crawlerSubtitle}</div>
        </div>
        <div class="metric">
          <div class="label">${copy.client.tiles.userFetches}</div>
          <div class="value">${formatNumber(sa.aiUserFetchHits.current)}</div>
          <div class="subtitle">${userFetchSubtitle}</div>
        </div>
        <div class="metric">
          <div class="label">${copy.client.tiles.referralSessions}</div>
          <div class="value">${formatNumber(sa.referralArrivals.current)}</div>
          <div class="subtitle">${referralSubtitle}</div>
        </div>
      </div>
      ${clientOperatorRows ? `<div class="chart-card"><h3>${copy.client.operatorsHeading}</h3>
        <div class="table-scroll"><table class="report-table">
          <thead><tr><th>${toolHeader}</th><th class="numeric">${botRequestsHeader}</th><th class="numeric">${userFetchesHeader}</th><th class="numeric">${referralSessionsHeader}</th></tr></thead>
          <tbody>${clientOperatorRows}</tbody>
        </table></div>
        <p class="meta">${copy.client.operatorsFootnote}</p>
      </div>` : ''}`,
    )
  }

  // ── Agency view (full forensic detail) ──
  const operatorRows = sa.byOperator.map(o => {
    const deltaText = reportServerActivityOperatorDelta(o.deltaPct)
    const toneClass = o.deltaPct === null ? '' : `tone-${deltaTone(o.deltaPct)}`
    return `
    <tr>
      <td>${escapeHtml(o.operator)}</td>
      <td class="numeric">${formatNumber(o.verifiedHits)}</td>
      <td class="numeric meta">${formatNumber(o.unverifiedHits)}</td>
      <td class="numeric">${formatNumber(o.userFetchHits)}</td>
      <td class="numeric">${formatNumber(o.referralArrivals)}</td>
      <td class="numeric ${toneClass}">${deltaText}</td>
    </tr>`
  }).join('')

  // Total hits, with the verified share beside it. The table is ordered by
  // total, so showing only the verified count made rows look mis-sorted, and on
  // a source that cannot verify at all (Vercel logs carry no client IP) every
  // cell read 0 next to a populated headline tile.
  const pathRows = sa.topCrawledPaths.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.path)}</td>
      <td class="numeric">${formatNumber(reportServerActivityPathHits(p))}</td>
      <td class="numeric meta">${formatNumber(p.verifiedHits)}</td>
      <td class="numeric">${p.distinctOperators}</td>
    </tr>`).join('')

  const referralProductRows = sa.referralProducts.map(p => `
    <tr>
      <td>${escapeHtml(p.product)}</td>
      <td class="numeric">${formatNumber(p.arrivals)}</td>
      <td class="numeric">${p.distinctLandingPaths}</td>
    </tr>`).join('')

  const referralLandingRows = sa.topReferralLandingPaths.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.path)}</td>
      <td class="numeric">${formatNumber(p.arrivals)}</td>
      <td class="numeric">${p.distinctProducts}</td>
    </tr>`).join('')

  const trendChart = sa.dailyTrend.length > 0
    ? renderLineChart(
        sa.dailyTrend.map(d => ({ x: d.date, y: d.verifiedCrawlerHits, label: d.date.slice(5) })),
        COLORS.series[1]!,
        reportServerActivityTrendTitle(windowDays),
      )
    : ''

  const agency = copy.agency
  const tiles = reportServerActivityAgencyTiles(windowDays)
  const [operatorHeader, verifiedHeader, unverifiedHeader, userFetchesHeader, referralSessionsHeader, deltaHeader] = reportServerActivityAgencyOperatorHeaders(windowDays)
  const [crawledPathHeader, hitsHeader, verifiedHitsHeader, operatorCountHeader] = agency.crawledPathHeaders
  const [productHeader, productSessionsHeader, landingPathCountHeader] = agency.referralProductHeaders
  const [landingPathHeader, landingSessionsHeader, productCountHeader] = agency.referralLandingHeaders

  return section(
    reportServerActivityHeading('agency', true, windowDays),
    `<div class="metric-grid">
      <div class="metric">
        <div class="label">${tiles.verified}</div>
        <div class="value">${formatNumber(sa.verifiedCrawlerHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.verifiedCrawlerHits, copy.countNouns.hits)}</div>
      </div>
      <div class="metric">
        <div class="label">${tiles.unverified}</div>
        <div class="value">${formatNumber(sa.unverifiedCrawlerHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.unverifiedCrawlerHits, copy.countNouns.hits)}</div>
      </div>
      <div class="metric">
        <div class="label">${tiles.userFetches}</div>
        <div class="value">${formatNumber(sa.aiUserFetchHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.aiUserFetchHits, copy.countNouns.hits)}</div>
      </div>
      <div class="metric">
        <div class="label">${tiles.referralSessions}</div>
        <div class="value">${formatNumber(sa.referralArrivals.current)}</div>
        <div class="subtitle">${referralSubtitle}</div>
      </div>
    </div>
    ${trendChart}
    ${operatorRows ? `<div class="chart-card"><h3>${agency.operatorsHeading}</h3>
      <p class="meta">${agency.operatorsNote}</p>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${operatorHeader}</th><th class="numeric">${verifiedHeader}</th><th class="numeric">${unverifiedHeader}</th><th class="numeric">${userFetchesHeader}</th><th class="numeric">${referralSessionsHeader}</th><th class="numeric">${deltaHeader}</th></tr></thead>
        <tbody>${operatorRows}</tbody>
      </table></div>
    </div>` : ''}
    ${pathRows ? `<div class="chart-card"><h3>${agency.crawledPathsHeading}</h3>
      <p class="meta">${reportServerActivityCrawledPathsNote(windowDays)}</p>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${crawledPathHeader}</th><th class="numeric">${hitsHeader}</th><th class="numeric">${verifiedHitsHeader}</th><th class="numeric">${operatorCountHeader}</th></tr></thead>
        <tbody>${pathRows}</tbody>
      </table></div>
    </div>` : ''}
    ${referralProductRows ? `<div class="chart-card"><h3>${agency.referralProductsHeading}</h3>
      <p class="meta">${agency.referralProductsNote}</p>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${productHeader}</th><th class="numeric">${productSessionsHeader}</th><th class="numeric">${landingPathCountHeader}</th></tr></thead>
        <tbody>${referralProductRows}</tbody>
      </table></div>
    </div>` : ''}
    ${referralLandingRows ? `<div class="chart-card"><h3>${agency.referralLandingHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${landingPathHeader}</th><th class="numeric">${landingSessionsHeader}</th><th class="numeric">${productCountHeader}</th></tr></thead>
        <tbody>${referralLandingRows}</tbody>
      </table></div>
    </div>` : ''}`,
  )
}

function renderIndexingHealth(report: ProjectReportDto): string {
  const ih = report.indexingHealth
  const copy = REPORT_SECTION_COPY['indexing-health']
  if (!ih) {
    return section(
      { id: ReportSectionIds['indexing-health'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  const segments = [
    { label: copy.segments.indexed, count: ih.indexed, color: COLORS.positive },
    { label: copy.segments.notIndexed, count: ih.notIndexed, color: COLORS.caution },
    { label: copy.segments.deindexed, count: ih.deindexed, color: COLORS.negative },
    { label: copy.segments.unknown, count: ih.unknown, color: COLORS.neutral },
  ].filter(s => s.count > 0)

  const total = segments.reduce((s, x) => s + x.count, 0) || 1
  const width = 600
  const height = 28

  let acc = 0
  const bars = segments.map(s => {
    const w = (s.count / total) * width
    const x = acc
    acc += w
    return `<rect x="${x}" y="0" width="${w}" height="${height}" fill="${s.color}" />`
  }).join('')

  const legend = segments.map(s => `<span><span class="legend-swatch" style="background:${s.color}"></span>${escapeHtml(reportIndexingLegendLabel(s.label, s.count))}</span>`).join('')

  return section(
    { id: ReportSectionIds['indexing-health'], eyebrow: copy.eyebrow, title: copy.title, intro: reportIndexingIntro(ih.provider) },
    `<div class="metric-grid">
      <div class="metric"><div class="label">${copy.tiles.indexed}</div><div class="value tone-positive">${formatNumber(ih.indexed)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.total}</div><div class="value">${formatNumber(ih.total)}</div></div>
      <div class="metric"><div class="label">${copy.tiles.share}</div><div class="value">${ih.indexedPct}%</div></div>
    </div>
    <div class="chart-card">
      <h3>${copy.coverageHeading}</h3>
      <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${copy.coverageLabel}">${bars}</svg>
      <div class="legend">${legend}</div>
    </div>`,
  )
}

function renderCitationsTrend(report: ProjectReportDto): string {
  const trend = report.citationsTrend
  const copy = REPORT_SECTION_COPY['citations-trend']
  if (trend.length === 0) {
    return section(
      { id: ReportSectionIds['citations-trend'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  if (isTrendBaseline(trend)) {
    return section(
      { id: ReportSectionIds['citations-trend'], eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(reportCitationsTrendBaseline(trend.length)),
    )
  }

  const chart = renderLineChart(
    trend.map(t => ({ x: t.date, y: t.citationRate, label: formatDate(t.date) })),
    COLORS.positive,
    copy.chartTitle,
    220,
  )

  const rows = trend.map((t: CitationsTrendPoint) => `
    <tr>
      <td>${formatDate(t.date)}</td>
      <td class="numeric">${t.citationRate}% <span class="cell-pending">(${t.citedQueryCount}/${t.totalQueryCount})</span></td>
      <td>${escapeHtml(reportTrendProviderRates(t.providerRates))}</td>
    </tr>`).join('')

  const [checkHeader, citedQueriesHeader, engineRatesHeader] = copy.breakdownHeaders

  return section(
    { id: ReportSectionIds['citations-trend'], eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    `${chart}
    <div class="chart-card"><h3>${copy.breakdownHeading}</h3>
      <div class="table-scroll"><table class="report-table">
        <thead><tr><th>${checkHeader}</th><th class="numeric">${citedQueriesHeader}</th><th>${engineRatesHeader}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`,
  )
}

function renderInsights(report: ProjectReportDto): string {
  const list = report.insights
  const copy = REPORT_SECTION_COPY.insights
  if (list.length === 0) {
    return section(
      { id: ReportSectionIds.insights, eyebrow: copy.eyebrow, title: copy.title },
      renderEmpty(copy.empty),
    )
  }

  // The API has already deduped by (query, provider, type); use the per-row
  // `instanceCount` instead of regrouping client-side. Older fixtures without
  // the field fall back to a defensive group pass.
  const haveDeduped = list.every((i) => typeof i.instanceCount === 'number')
  const rows = (haveDeduped ? list.map((i) => ({ rep: i, count: i.instanceCount })) : groupInsights(list).map((g) => ({ rep: g.representative, count: g.count })))
    .map(({ rep: i, count }) => {
      const tone = reportInsightTone(i)
      const countChip = count > 1
        ? ` <span class="badge tone-neutral">${reportInstanceCountLabel(count)}</span>`
        : ''
      return `<tr>
        <td class="col-severity"><span class="badge tone-${tone}">${escapeHtml(reportSeverityLabel(i.severity))}</span></td>
        <td class="col-title">${escapeHtml(i.title)}${countChip}</td>
        <td class="col-query">${escapeHtml(i.query)}</td>
        <td class="col-provider">${escapeHtml(i.provider)}</td>
        <td class="col-recommendation">${i.recommendation ? escapeHtml(i.recommendation) : `<span class="cell-pending">${copy.noRecommendation}</span>`}</td>
      </tr>`
    }).join('')

  const [severityHeader, titleHeader, queryHeader, providerHeader, recommendationHeader] = copy.headers

  return section(
    { id: ReportSectionIds.insights, eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    `<div class="table-scroll"><table class="report-table insights-table">
      <thead><tr>
        <th class="col-severity">${severityHeader}</th>
        <th class="col-title">${titleHeader}</th>
        <th class="col-query">${queryHeader}</th>
        <th class="col-provider">${providerHeader}</th>
        <th class="col-recommendation">${recommendationHeader}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  )
}

function renderOpportunities(report: ProjectReportDto): string {
  const opps = dedupeReportOpportunities(report)
  if (opps.length === 0) return ''

  const canonical = report.meta.project.canonicalDomain
  const copy = REPORT_SECTION_COPY['content-opportunities']
  const highlights = `<div class="opportunity-grid">
    ${opps.slice(0, 3).map(o => `<article class="opportunity-card">
      <div class="opportunity-score" title="${copy.scoreCardTooltip}">${Math.round(o.score)}<span class="opportunity-score-suffix">${copy.scoreSuffix}</span></div>
      <h3>${escapeHtml(o.query)}</h3>
      <p>${escapeHtml(reportOpportunityActionLine(o))}</p>
      ${renderProofChips(o.drivers, 2)}
    </article>`).join('')}
  </div>`
  const rows = opps.slice(0, 10).map((o) => {
    const ourPage = o.ourBestPage
      ? `<a href="${safeHref(absolutizeProjectUrl(o.ourBestPage.url, canonical))}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.ourBestPage.url)}</a>`
      : `<span class="cell-not-cited">${copy.noPage}</span>`
    const winning = o.winningCompetitor
      ? `<a href="${safeHref(o.winningCompetitor.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.winningCompetitor.domain)}</a>`
      : `<span class="cell-not-cited">${copy.noWinningCompetitor}</span>`
    const drivers = o.drivers.length > 0
      ? `<ul class="driver-list">${o.drivers.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
      : `<span class="cell-not-cited">${copy.noDriverSignal}</span>`
    const surfaceTone = o.winnabilityClass === 'ceded' ? 'tone-caution' : 'tone-neutral'
    return `<tr>
      <td>${escapeHtml(o.query)}</td>
      <td><span class="badge tone-neutral">${escapeHtml(contentActionLabel(o.action))}</span></td>
      <td><span class="badge ${surfaceTone}">${escapeHtml(winnabilityClassLabel(o.winnabilityClass))}</span></td>
      <td class="numeric" title="${copy.scoreHeaderTooltip}">${Math.round(o.score)}</td>
      <td>${drivers}</td>
      <td>${ourPage}</td>
      <td>${winning}</td>
      <td><span class="badge tone-neutral">${escapeHtml(actionConfidenceLabel(o.actionConfidence))}</span></td>
    </tr>`
  }).join('')

  const [queryHeader, actionHeader, winnabilityHeader, scoreHeader, whyHeader, ourPageHeader, winningHeader, confidenceHeader] = copy.headers

  return section(
    {
      id: ReportSectionIds['content-opportunities'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    `${highlights}<div class="table-scroll"><table class="report-table">
      <thead><tr><th>${queryHeader}</th><th>${actionHeader}</th><th>${winnabilityHeader}</th><th class="numeric" title="${copy.scoreHeaderTooltip}">${scoreHeader}</th><th>${whyHeader}</th><th>${ourPageHeader}</th><th>${winningHeader}</th><th>${confidenceHeader}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  )
}

function renderContentGaps(report: ProjectReportDto): string {
  const gaps = report.contentGaps
  if (gaps.length === 0) return ''
  const copy = REPORT_SECTION_COPY['content-gaps']
  const rows = gaps.slice(0, 10).map(g => {
    return `<tr>
      <td>${escapeHtml(g.query)}</td>
      <td class="numeric">${g.competitorCount}</td>
      <td>${escapeHtml(reportCompactList(g.competitorDomains, 5))}</td>
      <td class="numeric">${reportMissRateLabel(g.missRate)}</td>
    </tr>`
  }).join('')
  const [queryHeader, competitorsHeader, domainsHeader, missRateHeader] = copy.headers
  return section(
    {
      id: ReportSectionIds['content-gaps'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    `<div class="table-scroll"><table class="report-table">
      <thead><tr><th>${queryHeader}</th><th class="numeric">${competitorsHeader}</th><th>${domainsHeader}</th><th class="numeric">${missRateHeader}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  )
}

function renderRecommendedNextSteps(report: ProjectReportDto): string {
  // The API already merges insight-driven and opportunity-driven steps via
  // `mapOpportunitiesToNextSteps`; consume the result directly per the
  // UI/CLI parity rule (no UI-only calculations).
  const steps = report.recommendedNextSteps
  const copy = REPORT_SECTION_COPY['recommended-next-steps']
  const heading = { id: ReportSectionIds['recommended-next-steps'], eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro }
  if (steps.length === 0) {
    return section(heading, renderEmpty(copy.empty))
  }

  const items = steps.map(s => `
    <div class="step">
      <span class="horizon">${escapeHtml(s.horizon)}</span>
      <span class="title">${escapeHtml(s.title)}</span>
      <span class="rationale">${escapeHtml(s.rationale)}</span>
    </div>`).join('')

  return section(heading, `<div class="steps">${items}</div>`)
}

function renderActionCards(actions: readonly ReportActionPlanItem[], audience: ReportAudience): string {
  const isClient = audience === 'client'
  const copy = isClient ? REPORT_SECTION_COPY['client-action-plan'] : REPORT_SECTION_COPY['agency-action-plan']
  if (actions.length === 0) return renderEmpty(copy.empty)
  return `<div class="action-card-grid">
    ${actions.map((action, idx) => {
      const tone = reportActionTone(action)
      const why = action.why.length > 0
        ? `<ul>${action.why.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : ''
      const evidence = action.evidence.length > 0
        ? `<ul>${action.evidence.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : ''
      const proof = renderProofChips(action.evidence.length > 0 ? action.evidence : action.why, 3)
      const details = why || evidence
        ? `<details class="action-details">
            <summary>${copy.detailsSummary}</summary>
            ${why ? `<div><strong>${copy.whyLabel}</strong>${why}</div>` : ''}
            ${evidence ? `<div><strong>${copy.evidenceLabel}</strong>${evidence}</div>` : ''}
          </details>`
        : ''
      const horizonLabel = reportActionHorizonBadge(audience, action.horizon)
      const confidenceLabel = reportActionConfidenceBadge(audience, action.confidence)
      const categoryBadge = isClient ? '' : `<span class="badge tone-neutral">${escapeHtml(reportActionCategoryLabel(action.category))}</span>`
      const successLabel = copy.successLabel
      return `<article class="action-card">
        <div class="action-head">
          <div class="action-rank" title="${copy.rankTitle}">${idx + 1}</div>
          <div>
            <div class="action-meta">
              <span class="badge tone-${tone}">${escapeHtml(horizonLabel)}</span>
              ${categoryBadge}
              <span class="badge tone-neutral">${escapeHtml(confidenceLabel)}</span>
            </div>
            <h3>${escapeHtml(action.title)}</h3>
          </div>
        </div>
        <p>${escapeHtml(action.action)}</p>
        ${proof}
        ${details}
        <div class="success-metric"><strong>${successLabel}</strong> ${escapeHtml(action.successMetric)}</div>
      </article>`
    }).join('')}
  </div>`
}

function renderAudienceActionPlan(report: ProjectReportDto, audience: ReportAudience): string {
  const id = audience === 'client' ? ReportSectionIds['client-action-plan'] : ReportSectionIds['agency-action-plan']
  const copy = REPORT_SECTION_COPY[id]
  return section(
    { id, eyebrow: copy.eyebrow, title: copy.title, intro: copy.intro },
    renderActionCards(reportAudienceActions(report, audience), audience),
  )
}

function renderClientSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const sc = report.citationScorecard
  const copy = REPORT_SECTION_COPY['client-summary']
  const totalQ = s.totalQueryCount ?? 0
  const heroNumber = totalQ > 0 ? `${s.mentionRate}%` : '—'
  const heroSentence = reportClientHeroSentence(totalQ, s.mentionedQueryCount)
  const trend = reportClientTrendCopy(report.whatsChanged.mentionRate)
  const heroTrend = trend
    ? `<p class="client-hero-trend tone-${trend.tone}"><span style="margin-right:6px;">${trend.arrow}</span>${escapeHtml(trend.text)}</p>`
    : ''
  const hero = `<div class="client-hero">
    <div class="client-hero-eyebrow">${copy.heroEyebrow}</div>
    <div class="client-hero-number">${heroNumber}</div>
    <p class="client-hero-sentence">${escapeHtml(heroSentence)}</p>
    ${heroTrend}
  </div>`

  const providerSubtitle = reportClientProvidersSubtitle(sc.providers, s.queryCount)

  const tiles = `<div class="client-metric-grid">
    <div class="client-metric-tile">
      <div class="label">${copy.tiles.mentioned}</div>
      <div class="value">${s.mentionRate}%</div>
      <div class="subtitle">${reportClientMentionedSubtitle(s.mentionedQueryCount, totalQ)}</div>
    </div>
    <div class="client-metric-tile">
      <div class="label">${copy.tiles.cited}</div>
      <div class="value">${s.citationRate}%</div>
      <div class="subtitle">${reportClientCitedSubtitle(s.citedQueryCount, totalQ)}</div>
    </div>
    <div class="client-metric-tile">
      <div class="label">${copy.tiles.providers}</div>
      <div class="value">${formatNumber(s.providerCount)}</div>
      <div class="subtitle">${escapeHtml(providerSubtitle)}</div>
    </div>
  </div>`

  const { lead, mention, link, closing } = copy.explainer
  const explainer = `<div class="client-explainer">
    <strong>${lead}</strong>
    ${mention.article} <span class="term">${mention.term}</span> ${mention.definition}
    ${link.article} <span class="term">${link.term}</span> ${link.definition}
    ${closing}
  </div>`

  const questions = sc.queries.length > 0
    ? `<div class="client-card">
        <h3>${copy.queriesHeading}</h3>
        <p class="card-subtitle">${reportClientQueriesSubtitle(sc.queries.length)}</p>
        <ol class="client-questions-list">
          ${sc.queries.map((q, i) => `<li><span class="qnum">${String(i + 1).padStart(2, '0')}</span><span>"${escapeHtml(q)}"</span></li>`).join('')}
        </ol>
      </div>`
    : ''

  const providerBars = sc.providerRates.length > 0
    ? `<div class="client-card">
        <h3>${copy.providerBarsHeading}</h3>
        <p class="card-subtitle">${copy.providerBarsSubtitle}</p>
        <div class="client-bar-list">
          ${sc.providerRates.map(r => {
            const pct = Math.max(r.mentionRate, 1.5)
            return `<div class="client-bar-row">
              <span class="bar-label">${escapeHtml(reportProviderDisplayName(r.provider))}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${r.mentionRate}% <span class="bar-value-sub">(${r.mentionedCount}/${r.totalCount})</span></span>
            </div>`
          }).join('')}
        </div>
      </div>`
    : ''

  const notes = report.clientSummary.confidenceNotes.length > 0
    ? `<div>${report.clientSummary.confidenceNotes.map(note => `<div class="client-confidence-note">${escapeHtml(note)}</div>`).join('')}</div>`
    : ''

  return `<section class="report-section" id="client-summary">${hero}${tiles}${explainer}${questions}${providerBars}${notes}</section>`
}

function renderClientEvidenceSummary(report: ProjectReportDto): string {
  const ai = report.aiSourceOrigin.topDomains.slice(0, 5)
  const gsc = report.gsc
  const indexing = report.indexingHealth
  const opportunities = dedupeReportOpportunities(report).slice(0, 5)

  const aiMax = ai.length > 0 ? Math.max(...ai.map(d => d.count)) : 0
  const gscMax = gsc ? Math.max(...gsc.topQueries.slice(0, 5).map(q => q.impressions), 1) : 0

  const copy = REPORT_SECTION_COPY['client-evidence-summary']
  const cards: string[] = []

  if (ai.length > 0) {
    cards.push(`<div class="client-card">
      <h3>${copy.sources.heading}</h3>
      <p class="card-subtitle">${copy.sources.subtitle}</p>
      <div class="client-bar-list">
        ${ai.map(d => {
          const pct = aiMax > 0 ? Math.max((d.count / aiMax) * 100, 1.5) : 0
          const label = escapeHtml(d.domain) + (d.isCompetitor ? ` <span style="color:${COLORS.textFaint};font-size:11px;">${copy.sources.competitorTag}</span>` : '')
          return `<div class="client-bar-row">
            <span class="bar-label">${label}</span>
            <div class="bar-track"><div class="bar-fill bar-fill-neutral" style="width:${pct}%"></div></div>
            <span class="bar-value">${reportClientSourceCount(d.count)}</span>
          </div>`
        }).join('')}
      </div>
    </div>`)
  }

  if (indexing) {
    const tone = reportClientIndexingTone(indexing.indexedPct)
    const fillPct = Math.max(indexing.indexedPct, 1.5)
    cards.push(`<div class="client-card">
      <h3>${copy.indexing.heading}</h3>
      <p class="card-subtitle">${copy.indexing.subtitle}</p>
      <div class="client-progress-number tone-${tone}">${indexing.indexedPct}%</div>
      <div style="font-size:12px;color:${COLORS.textMuted};">${reportClientIndexedPages(indexing.indexed, indexing.total)}</div>
      <div class="client-progress-bar"><div class="client-progress-fill tone-${tone}" style="width:${fillPct}%"></div></div>
      <p style="margin:0;font-size:12px;color:${COLORS.textMuted};"><strong style="color:${COLORS.text};">${formatNumber(indexing.notIndexed)}</strong> ${reportClientNotIndexedTail(indexing.notIndexed)}</p>
    </div>`)
  }

  if (gsc) {
    const queries = gsc.topQueries.slice(0, 5)
    const queryRows = queries.length > 0
      ? `<div class="client-bar-list">
          ${queries.map(q => {
            const pct = gscMax > 0 ? Math.max((q.impressions / gscMax) * 100, 1.5) : 0
            return `<div class="client-bar-row">
              <span class="bar-label">${escapeHtml(q.query)}</span>
              <div class="bar-track"><div class="bar-fill bar-fill-sky" style="width:${pct}%"></div></div>
              <span class="bar-value">${reportClientSearchCount(q.impressions)}</span>
            </div>`
          }).join('')}
        </div>`
      : ''
    cards.push(`<div class="client-card">
      <h3>${copy.search.heading}</h3>
      <p class="card-subtitle">${copy.search.subtitleLead} <strong style="color:${COLORS.text};">${formatNumber(gsc.totalImpressions)}</strong> ${copy.search.subtitleMiddle} <strong style="color:${COLORS.text};">${formatNumber(gsc.totalClicks)}</strong> ${reportClientClicksNoun(gsc.totalClicks)} ${copy.search.subtitleTail}</p>
      ${queryRows}
    </div>`)
  }

  if (opportunities.length > 0) {
    cards.push(`<div class="client-card">
      <h3>${copy.opportunities.heading}</h3>
      <p class="card-subtitle">${copy.opportunities.subtitle}</p>
      <ul class="client-opportunity-list">
        ${opportunities.map(o => `<li>
          <div class="op-query">${escapeHtml(o.query)}</div>
          <div class="op-action">${escapeHtml(contentActionLabel(o.action))}${o.winnabilityClass === 'ceded' ? ` <span class="badge tone-caution">${copy.opportunities.cededTag}</span>` : ''}</div>
        </li>`).join('')}
      </ul>
    </div>`)
  }

  return section(
    {
      id: ReportSectionIds['client-evidence-summary'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    cards.length > 0
      ? `<div class="client-evidence-grid">${cards.join('')}</div>`
      : renderEmpty(copy.empty),
  )
}

function renderAgencyDiagnostics(report: ProjectReportDto): string {
  const copy = REPORT_SECTION_COPY['agency-diagnostics']
  const diagnostics = report.agencyDiagnostics.diagnostics
    .filter(d => d.title !== copy.hiddenTitle)
  const body = diagnostics.length > 0
    ? `<div class="diagnostics-grid">
        ${diagnostics.map(d => `<div class="diagnostic-card tone-${d.severity}">
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.detail)}</p>
          ${renderProofChips(d.evidence, 3)}
        </div>`).join('')}
      </div>`
    : renderEmpty(copy.empty)
  return section(
    {
      id: ReportSectionIds['agency-diagnostics'],
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: copy.intro,
    },
    body,
  )
}

function escapeJsonForScript(json: string): string {
  // Avoid breaking out of the </script> tag — both JSON literally as `</`
  // and unicode escapes need handling.
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export interface RenderReportHtmlOptions {
  /** Override <title>. Default: `Canonry report — <project displayName>`. */
  title?: string
  /** Audience render mode. JSON payload stays canonical either way. Default: agency. */
  audience?: ReportAudience
}

export function renderReportHtml(report: ProjectReportDto, opts: RenderReportHtmlOptions = {}): string {
  const audience = opts.audience ?? 'agency'
  const title = opts.title ?? `Canonry ${audience} report — ${report.meta.project.displayName}`
  const sections = audience === 'client'
    ? [
        report.visibility ? renderReportVisibility(report.visibility) : renderClientSummary(report),
        report.visibility?.selection.mode === 'advanced' ? '' : renderReportShareOfVoice(report),
        report.visibility ? '' : renderWhatsChanged(report, 'client'),
        // Server-side AI visibility runs between WhatsChanged and the action
        // plan in BOTH the SPA and HTML so clients see the same ordered set
        // of sections in either surface (per the report-parity rule).
        renderServerActivity(report, 'client'),
        renderAudienceActionPlan(report, 'client'),
        renderClientEvidenceSummary(report),
      ].join('\n')
    : [
        report.visibility ? renderReportVisibility(report.visibility) : renderExecutiveSummary(report),
        report.visibility?.selection.mode === 'advanced' ? '' : renderReportShareOfVoice(report),
        report.visibility ? '' : renderWhatsChanged(report, 'agency'),
        renderAudienceActionPlan(report, 'agency'),
        report.visibility?.selection.mode === 'advanced' ? '' : renderAgencyDiagnostics(report),
        report.visibility?.selection.mode === 'advanced' ? '' : renderCitationScorecard(report),
        report.visibility?.selection.mode === 'advanced' ? '' : renderCompetitorLandscape(report),
        renderAiSourceOrigin(report),
        renderGsc(report),
        renderGa(report),
        renderSocial(report),
        renderAiReferrals(report),
        renderServerActivity(report, 'agency'),
        renderIndexingHealth(report),
        report.visibility?.selection.mode === 'advanced' ? '' : renderCitationsTrend(report),
        renderInsights(report),
        renderOpportunities(report),
        renderContentGaps(report),
        renderRecommendedNextSteps(report),
      ].join('\n')

  const json = escapeJsonForScript(JSON.stringify(report))

  // Strict CSP. The report bundles the full DTO inside a
  // `<script type="application/json">` island (non-executable by spec, so
  // `script-src 'none'` does not block it). `style-src 'unsafe-inline'` is
  // required for the inline `<style>` block and inline SVG attributes;
  // `connect-src 'none'` prevents any exfil even if a script slipped past
  // `script-src` — defense in depth for the client-facing download.
  const csp =
    "default-src 'none'; " +
    "style-src 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data: https:; " +
    "connect-src 'none'; " +
    "script-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'none'; " +
    "frame-ancestors 'none'"

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="container">
  <header class="header">
    <div class="eyebrow">${REPORT_HEADER_COPY.eyebrow}</div>
    <h1>${escapeHtml(report.meta.project.displayName)}</h1>
    <div class="subtitle">${escapeHtml(report.meta.project.canonicalDomain)} · ${escapeHtml(report.meta.project.country)} / ${escapeHtml(report.meta.project.language.toUpperCase())}${report.visibility?.selection.mode === 'advanced' ? ` · ${escapeHtml(reportVisibilityLocationLabel(report.visibility))}` : renderHeaderLocationFragment(report.meta.location)} · ${reportHeaderPeriodLabel(report.meta.periodDays)} · ${REPORT_HEADER_COPY.generated} ${formatDate(report.meta.generatedAt)}</div>
  </header>
  ${sections}
  <footer class="footer">Generated by <a href="https://canonry.ai">canonry</a> · ${escapeHtml(formatIsoDate(report.meta.generatedAt))}</footer>
</div>
<script type="application/json" id="canonry-report-data">${json}</script>
</body>
</html>`
}


export function renderReportVisibility(visibility: ReportVisibility): string {
  const populations = visibility.populations.filter(population => population.queryClass !== 'unknown' || population.summary.answerCount > 0)
  const historyPopulations = visibility.populations.filter(population => population.queryClass !== 'unknown' || population.trend.some(point => point.answerCount > 0))
  const rateCell = (rate: ReportVisibility['populations'][number]['summary']['mentionCoverage']) => `<td><strong>${escapeHtml(reportVisibilityRate(rate))}</strong><p class="muted">${escapeHtml(reportVisibilityEvidence(rate))}</p></td>`
  const headers = (labels: string[]) => `<thead><tr>${labels.map(label => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>`
  const summary = `<table class="report-table">${headers([visibilityCopy.queryType, visibilityCopy.queries, visibilityCopy.answers, visibilityCopy.mentioned, visibilityCopy.cited])}<tbody>${populations.map(population => `<tr><td>${escapeHtml(reportQueryClassLabel(population.queryClass))}</td><td>${population.summary.queryCount}</td><td>${population.summary.answerCount}</td>${rateCell(population.summary.mentionCoverage)}${rateCell(population.summary.citationCoverage)}</tr>`).join('')}</tbody></table>`
  const trend = `<details><summary>${escapeHtml(reportVisibilityHistoryLabel(visibility))}</summary><div class="table-scroll"><table class="report-table">${headers([visibilityCopy.date, visibilityCopy.queryType, visibilityCopy.mentioned, visibilityCopy.cited, visibilityCopy.comparison])}<tbody>${historyPopulations.flatMap(population => population.trend.map(point => `<tr><td><time datetime="${escapeHtml(point.createdAt)}">${escapeHtml(point.createdAt.slice(0, 10))}</time></td><td>${escapeHtml(reportQueryClassLabel(population.queryClass))}</td>${rateCell(point.mentionCoverage)}${rateCell(point.citationCoverage)}<td>${escapeHtml(reportVisibilityComparison(point.continuity.state, point.continuity.comparedRunId !== null && !population.trend.some(previous => previous.runId === point.continuity.comparedRunId)))}</td></tr>`)).join('')}</tbody></table></div></details>`
  return `<section id="client-summary" class="report-section" aria-label="${escapeHtml(visibilityCopy.title)}"><h2>${escapeHtml(visibilityCopy.title)}</h2><p>${escapeHtml(visibility.selection.mode === 'advanced' ? visibilityCopy.description : visibilityCopy.simpleDescription)}</p><p>${escapeHtml(reportVisibilityMeasurementLabel(visibility))}</p><div class="table-scroll">${summary}</div>${trend}</section>`
}
