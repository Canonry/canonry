import type {
  AiSourceCategoryBucket,
  CitationsTrendPoint,
  CompetitorRow,
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
  dedupeReportActions,
  dedupeReportOpportunities,
  deltaPercent,
  deltaTone,
  formatDate,
  formatDateRange,
  formatDeltaCopy,
  formatIsoDate,
  formatNumber,
  formatRatio,
  reportActionCategoryLabel,
  reportActionTone,
  reportConfidenceLabel,
  reportHorizonLabel,
  reportSeverityLabel,
} from '@ainyc/canonry-contracts'
import {
  groupInsights,
  isTrendBaseline,
  MIN_TREND_POINTS,
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
 * Safe `href` value for anchor tags. Citation and competitor URLs in the
 * report come from LLM grounding sources — attackers who plant `javascript:`
 * or `data:` URIs in cited content (or on their own pages) would otherwise
 * smuggle them through `escapeHtml` (which only escapes HTML metacharacters,
 * not URL schemes) and detonate when an operator clicks the link in the
 * downloaded file. Returns `#` for any non-http(s)/mailto value.
 */
function safeHref(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return '#'
  // Permit absolute paths so HTML the SPA also emits stays usable; the
  // renderer's other sites still resolve relative URLs upstream.
  if (trimmed.startsWith('/')) return escapeHtml(trimmed)
  if (/^https?:\/\//i.test(trimmed)) return escapeHtml(trimmed)
  if (/^mailto:/i.test(trimmed)) return escapeHtml(trimmed)
  return '#'
}

function summarizeQueryParams(params: URLSearchParams): string {
  const keys = Array.from(params.keys())
  const total = keys.length
  if (total === 0) return ''
  const noun = total === 1 ? 'param' : 'params'
  const tag = inferAdSource(params)
  return tag ? `${tag} · ${total} ${noun}` : `${total} tracking ${noun}`
}

function inferAdSource(params: URLSearchParams): string | null {
  if (params.has('fbclid')) return 'Facebook Ad'
  if (params.has('gclid') || params.has('gbraid') || params.has('wbraid')) return 'Google Ad'
  if (params.has('msclkid')) return 'Microsoft Ad'
  if (params.has('ttclid')) return 'TikTok Ad'
  if (params.has('li_fat_id')) return 'LinkedIn Ad'
  if (params.has('twclid')) return 'X / Twitter Ad'
  if (params.has('epik')) return 'Pinterest Ad'
  for (const k of params.keys()) {
    if (k.startsWith('hsa_')) return 'Search Ad'
  }
  const src = params.get('utm_source')
  const med = params.get('utm_medium')
  if (src && med) return `${src} / ${med}`
  if (src) return `Source: ${src}`
  if (med) return `Medium: ${med}`
  return null
}

export function formatLandingPageHtml(raw: string): string {
  const value = raw ?? ''
  const queryIdx = value.indexOf('?')
  const path = queryIdx === -1 ? value : value.slice(0, queryIdx)
  const query = queryIdx === -1 ? '' : value.slice(queryIdx + 1)
  const pathHtml = `<span class="page-path">${escapeHtml(path || '/')}</span>`
  if (!query) return pathHtml
  let summary = ''
  try {
    summary = summarizeQueryParams(new URLSearchParams(query))
  } catch {
    summary = 'tracking params'
  }
  if (!summary) return pathHtml
  return `${pathHtml}<span class="page-query" title="${escapeHtml(value)}">${escapeHtml(summary)}</span>`
}

function gscDateRange(report: ProjectReportDto): string {
  const summary = report.executiveSummary.gsc
  const gsc = report.gsc
  const start = summary?.periodStart || gsc?.periodStart || gsc?.trend[0]?.date || ''
  const end = summary?.periodEnd || gsc?.periodEnd || gsc?.trend.at(-1)?.date || ''
  return formatDateRange(start, end)
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  local: 'Local model',
  'cdp:chatgpt': 'ChatGPT (browser)',
}

function providerDisplayName(name: string): string {
  return PROVIDER_DISPLAY_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

function clientHorizonLabel(horizon: ReportActionPlanItem['horizon']): string {
  switch (horizon) {
    case 'immediate': return 'Do now'
    case 'short-term': return 'This month'
    case 'medium-term': return 'Next quarter'
  }
}

function clientConfidenceLabel(confidence: ReportActionPlanItem['confidence']): string {
  switch (confidence) {
    case 'high': return 'Strong evidence'
    case 'medium': return 'Some evidence'
    case 'low': return 'Worth trying'
  }
}

function clientTrendCopy(delta: ProjectReportDto['whatsChanged']['citationRate']): { text: string; tone: 'positive' | 'negative' | 'neutral'; arrow: string } | null {
  if (!delta) return null
  if (delta.direction === 'up') {
    return { text: `Up ${delta.deltaAbs.toFixed(1)} points ${compareCopy(delta)}`, tone: 'positive', arrow: '↑' }
  }
  if (delta.direction === 'down') {
    return { text: `Down ${Math.abs(delta.deltaAbs).toFixed(1)} points ${compareCopy(delta)}`, tone: 'negative', arrow: '↓' }
  }
  return { text: `Holding steady ${compareCopy(delta)}`, tone: 'neutral', arrow: '→' }
}

/** When `window` is ≥ 2 the prior/current values are rolling averages
 *  — label them as such so a reader doesn't misread an averaged number
 *  as a single-check snapshot. Mirrored verbatim in the SPA renderer
 *  per the "Report parity" rule. */
function compareCopy(delta: { prior: number; window?: number }): string {
  const window = delta.window ?? 1
  return window >= 2
    ? `vs prior ${window} checks (avg ${delta.prior}%)`
    : `since last check (was ${delta.prior}%)`
}

function compactInlineList(items: readonly string[], limit = 3): string {
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  return `${visible.join(', ')}${more > 0 ? `, +${more} more` : ''}`
}

function renderProofChips(items: readonly string[], limit = 3): string {
  if (items.length === 0) return ''
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  const chips = visible.map(item => `<span class="proof-chip">${escapeHtml(item)}</span>`)
  if (more > 0) chips.push(`<span class="proof-chip">+${more} more</span>`)
  return `<div class="proof-chips">${chips.join('')}</div>`
}

function pressureTone(label: CompetitorRow['pressureLabel']): 'positive' | 'caution' | 'negative' | 'neutral' {
  if (label === 'High') return 'negative'
  if (label === 'Moderate') return 'caution'
  if (label === 'Low') return 'positive'
  return 'neutral'
}

function severityTone(severity: ReportInsight['severity']): 'positive' | 'caution' | 'negative' | 'neutral' {
  switch (severity) {
    case 'critical': return 'negative'
    case 'high': return 'negative'
    case 'medium': return 'caution'
    case 'low': return 'neutral'
  }
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
table.insights-table { table-layout: fixed; }
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
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
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
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
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

function locationDisplay(location: ProjectReportDto['meta']['location']): string {
  if (!location) return ''
  const place = [location.city, location.region, location.country].filter(Boolean).join(', ')
  return place ? `${location.label} (${place})` : location.label
}

function renderHeaderLocationFragment(location: ProjectReportDto['meta']['location']): string {
  if (!location) return ' · No market set'
  return ` · Market: ${escapeHtml(locationDisplay(location))}`
}


function renderLocationCard(report: ProjectReportDto): string {
  const location = report.meta.location
  const handling = report.meta.providerLocationHandling
  if (!location && handling.length === 0) return ''

  const otherLocations = location?.otherConfiguredLabels ?? []
  const weakLocationProviders = handling
    .filter(h => h.treatment === 'ignored' || h.treatment === 'browser-geo')
    .map(h => h.provider)

  const marketValue = location ? locationDisplay(location) : 'No market set'
  const notIncluded = otherLocations.length > 0 ? compactInlineList(otherLocations, 4) : 'None'
  const interpretation = location
    ? otherLocations.length > 0
      ? `${otherLocations.length} configured ${pluralize(otherLocations.length, 'market')} still ${otherLocations.length === 1 ? 'needs' : 'need'} a matching check before cross-market recommendations.`
      : 'Single-market report; findings can be read as the current market view.'
    : 'No geographic hint was attached to this check; read findings as default-market or national results.'

  const providerCopy = handling.length > 0
    ? weakLocationProviders.length > 0
      ? `${weakLocationProviders.length} ${pluralize(weakLocationProviders.length, 'provider')} need a closer location check.`
      : `${handling.length} ${pluralize(handling.length, 'provider')} received the market context.`
    : 'No provider-level location metadata is available for this report.'

  const warning = weakLocationProviders.length > 0
    ? `<div class="scope-warning">
        <strong>Location handling needs review</strong>
        ${escapeHtml(compactInlineList(weakLocationProviders, 4))} used weak or indirect market handling. Treat provider-level differences cautiously.
      </div>`
    : ''

  return `<div class="chart-card market-scope-card">
    <h3>Market Scope</h3>
    <div class="market-scope-grid">
      <div class="scope-tile">
        <div class="scope-label">Current check</div>
        <div class="scope-value">${escapeHtml(marketValue)}</div>
        <div class="scope-copy">All findings below are scoped to this run.</div>
      </div>
      <div class="scope-tile">
        <div class="scope-label">Not included</div>
        <div class="scope-value">${escapeHtml(notIncluded)}</div>
        <div class="scope-copy">${escapeHtml(interpretation)}</div>
      </div>
      <div class="scope-tile">
        <div class="scope-label">Provider context</div>
        <div class="scope-value">${handling.length > 0 ? formatNumber(handling.length) : '—'}</div>
        <div class="scope-copy">${escapeHtml(providerCopy)}</div>
      </div>
    </div>
    ${warning}
  </div>`
}

function renderExecutiveSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const trendLabel = s.trend === 'up' ? '↑ Up' : s.trend === 'down' ? '↓ Down' : s.trend === 'flat' ? '→ Flat' : '—'
  const trendTone = s.trend === 'up' ? 'positive' : s.trend === 'down' ? 'negative' : 'neutral'

  const queryNoun = s.totalQueryCount === 1 ? 'query' : 'queries'
  const citedFragment = s.totalQueryCount > 0
    ? `${s.citedQueryCount}/${s.totalQueryCount} ${queryNoun} cited`
    : 'no queries'
  const mentionedFragment = s.totalQueryCount > 0
    ? `${s.mentionedQueryCount}/${s.totalQueryCount} ${queryNoun} mentioned`
    : 'no queries'
  const headlineTitle = s.totalQueryCount > 0
    ? `${s.citedQueryCount} of ${s.totalQueryCount} tracked ${queryNoun} cite ${report.meta.project.displayName}`
    : 'No AI citation data yet'
  const headlineSubtitle = s.totalQueryCount > 0
    ? `${s.citationRate}% citation coverage and ${s.mentionRate}% mention coverage across ${s.providerCount} ${pluralize(s.providerCount, 'provider')}.`
    : 'Run a check to populate the first citation and mention baseline.'
  const priorityActions = report.agencyDiagnostics.priorities.length > 0
    ? report.agencyDiagnostics.priorities
    : report.actionPlan
  const actionCount = dedupeReportActions(report, priorityActions).length
  const heroHtml = `<div class="executive-hero">
    <div class="headline-card">
      <div>
        <div class="hero-kicker">Latest AI visibility check</div>
        <div class="hero-title">${escapeHtml(headlineTitle)}</div>
      </div>
      <div class="hero-subtitle">${escapeHtml(headlineSubtitle)}</div>
    </div>
    <div class="hero-proof-grid">
      <div class="hero-proof">
        <div class="mini-label">Citation trend</div>
        <div class="mini-value tone-${trendTone}">${escapeHtml(trendLabel)}</div>
        <div class="mini-copy">${escapeHtml(citedFragment)}</div>
      </div>
      <div class="hero-proof">
        <div class="mini-label">Mention coverage</div>
        <div class="mini-value">${s.mentionRate}%</div>
        <div class="mini-copy">${escapeHtml(mentionedFragment)}</div>
      </div>
      <div class="hero-proof">
        <div class="mini-label">Prioritized actions</div>
        <div class="mini-value">${formatNumber(actionCount)}</div>
        <div class="mini-copy">Sorted for agency follow-up.</div>
      </div>
    </div>
  </div>`
  const metrics = [
    {
      label: 'Citation rate',
      value: `${s.citationRate}%`,
      delta: `<span class="tone-${trendTone}">${trendLabel}</span> · ${citedFragment} · ${s.providerCount} provider${s.providerCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Mention rate',
      value: `${s.mentionRate}%`,
      delta: mentionedFragment,
    },
    {
      label: 'Queries tracked',
      value: formatNumber(s.queryCount),
      delta: `${s.competitorCount} competitor${s.competitorCount === 1 ? '' : 's'} tracked`,
    },
  ]
  if (s.gsc) {
    const dateRange = gscDateRange(report)
    metrics.push({
      label: 'GSC clicks',
      value: formatNumber(s.gsc.clicks),
      delta: `${formatNumber(s.gsc.impressions)} imp · ${formatRatio(s.gsc.ctr)} CTR${dateRange ? ` · ${escapeHtml(dateRange)}` : ''}`,
    })
  }
  if (s.ga) {
    metrics.push({
      label: 'GA sessions',
      value: formatNumber(s.ga.sessions),
      delta: `${formatNumber(s.ga.users)} users · ${formatDate(s.ga.periodStart)} → ${formatDate(s.ga.periodEnd)}`,
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
      id: 'executive-summary',
      eyebrow: 'Section 1',
      title: 'Executive Summary',
      intro: 'Citation = source list. Mention = answer text. They are independent signals.',
    },
    heroHtml + metricsHtml + findingsHtml + locationHtml,
  )
}

function deltaToneClass(direction: 'up' | 'down' | 'flat'): string {
  if (direction === 'up') return 'tone-positive'
  if (direction === 'down') return 'tone-negative'
  return ''
}

function deltaArrow(direction: 'up' | 'down' | 'flat'): string {
  if (direction === 'up') return '↑'
  if (direction === 'down') return '↓'
  return '→'
}

function renderRateDeltaTile(
  label: string,
  delta: ProjectReportDto['whatsChanged']['citationRate'],
  unit: '%' | 'count',
): string {
  if (!delta) {
    return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">—</div><div class="delta">No prior data</div></div>`
  }
  const valueSuffix = unit === '%' ? '%' : ''
  const deltaSign = delta.deltaAbs > 0 ? '+' : ''
  const deltaText = `${deltaSign}${delta.deltaAbs.toFixed(unit === '%' ? 1 : 0)}${valueSuffix} vs ${delta.prior}${valueSuffix}`
  return `<div class="metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${deltaToneClass(delta.direction)}">${delta.current}${valueSuffix} <span style="font-size:14px;font-weight:500;">${deltaArrow(delta.direction)}</span></div>
    <div class="delta">${deltaText}</div>
  </div>`
}

function renderTrafficDeltaTile(
  label: string,
  delta: ProjectReportDto['whatsChanged']['gscClicksDelta'],
  countLabel: string,
): string {
  if (!delta) {
    return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">—</div><div class="delta">Not enough trend data</div></div>`
  }
  const deltaSign = delta.deltaAbs > 0 ? '+' : ''
  const deltaText = `${deltaSign}${formatNumber(delta.deltaAbs)} ${countLabel} vs prior ${WHATS_CHANGED_PERIOD_DAYS} days`
  return `<div class="metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value ${deltaToneClass(delta.direction)}">${formatNumber(delta.current)} <span style="font-size:14px;font-weight:500;">${deltaArrow(delta.direction)}</span></div>
    <div class="delta">${deltaText}</div>
  </div>`
}

const WHATS_CHANGED_PERIOD_DAYS = 14

function renderProviderMovements(
  movements: ProjectReportDto['whatsChanged']['providerMovements'],
  audience: ReportAudience,
): string {
  const meaningful = movements.filter(m => m.direction !== 'flat')
  if (meaningful.length === 0) return ''
  const isClient = audience === 'client'
  const rows = meaningful.map(m => {
    const sign = m.deltaAbs > 0 ? '+' : ''
    return `<tr>
      <td>${escapeHtml(isClient ? providerDisplayName(m.provider) : m.provider)}</td>
      <td class="numeric">${m.prior}%</td>
      <td class="numeric">${m.current}%</td>
      <td class="numeric ${deltaToneClass(m.direction)}">${sign}${m.deltaAbs.toFixed(1)}% ${deltaArrow(m.direction)}</td>
    </tr>`
  }).join('')
  const heading = isClient ? 'How each AI tool changed' : 'AI engine movements'
  const colA = isClient ? 'AI tool' : 'Engine'
  const colB = isClient ? 'Was' : 'Prior'
  const colC = isClient ? 'Now' : 'Current'
  return `<div class="chart-card"><h3>${heading}</h3>
    <table class="report-table">
      <thead><tr><th>${colA}</th><th class="numeric">${colB}</th><th class="numeric">${colC}</th><th class="numeric">Change</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
    const tone = severityTone(i.severity)
    const countChip = i.instanceCount > 1 ? ` <span class="badge tone-neutral">× ${i.instanceCount}</span>` : ''
    const severityCell = isClient ? '' : `<td><span class="badge tone-${tone}">${escapeHtml(reportSeverityLabel(i.severity))}</span></td>`
    return `<tr>
      ${severityCell}
      <td>${escapeHtml(i.title)}${countChip}</td>
      <td>${escapeHtml(i.query)}</td>
      <td>${escapeHtml(isClient ? providerDisplayName(i.provider) : i.provider)}</td>
    </tr>`
  }).join('')
  const headers = isClient
    ? `<tr><th>What changed</th><th>Customer question</th><th>AI tool</th></tr>`
    : `<tr><th>Severity</th><th>Title</th><th>Query</th><th>Provider</th></tr>`
  return `<div class="chart-card"><h3>${escapeHtml(heading)}</h3>
    <table class="report-table">
      <thead>${headers}</thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function renderWhatsChanged(report: ProjectReportDto, audience: ReportAudience): string {
  const w = report.whatsChanged
  const isClient = audience === 'client'
  const eyebrow = isClient ? 'Since last check' : 'Section 2'
  const title = isClient ? "What's different since last check" : "What's Changed"
  const intro = isClient ? '' : w.headline
  if (!w.enoughHistory && !w.gscClicksDelta && !w.aiReferralsDelta && w.wins.length === 0 && w.regressions.length === 0) {
    return section(
      { id: 'whats-changed', eyebrow, title, intro },
      renderEmpty(isClient ? 'No comparison yet — trends will appear after a few more checks.' : 'Trends will appear after a few more checks.'),
    )
  }
  const rateTiles = `<div class="metric-grid">
    ${renderRateDeltaTile(isClient ? 'AI links to your website' : 'Citation rate', w.citationRate, '%')}
    ${renderRateDeltaTile(isClient ? 'AI mentions your name' : 'Mention rate', w.mentionRate, '%')}
    ${renderRateDeltaTile(isClient ? 'Questions AI answered with you' : 'Cited queries', w.citedQueryCount, 'count')}
    ${renderTrafficDeltaTile(isClient ? 'Visitors from Google' : 'GSC clicks', w.gscClicksDelta, isClient ? 'visits' : 'clicks')}
    ${renderTrafficDeltaTile(isClient ? 'Visitors from AI tools' : 'AI referral sessions', w.aiReferralsDelta, isClient ? 'visits' : 'sessions')}
  </div>`
  const movements = renderProviderMovements(w.providerMovements, audience)
  const winsHeading = isClient ? 'What got better' : 'Wins'
  const lossesHeading = isClient ? 'What got worse' : 'Regressions'
  const wins = renderWinsLosses(w.wins, winsHeading, isClient ? 'No new wins this period.' : 'No new gains in the latest check.', audience)
  const regressions = renderWinsLosses(w.regressions, lossesHeading, isClient ? 'Nothing got worse this period.' : 'No new regressions in the latest check.', audience)
  return section(
    { id: 'whats-changed', eyebrow, title, intro },
    `${rateTiles}${movements}${wins}${regressions}`,
  )
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
      <text x="${labelWidth + w + 6}" y="${y + 16}" fill="${COLORS.text}" font-size="11">${r.citationRate}% (${r.citedCount}/${r.totalCount})</text>`
  }).join('')

  return `<div class="chart-card">
    <h3>Provider citation rate</h3>
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Provider citation rate bar chart">
      ${bars}
    </svg>
  </div>`
}

function renderCitationMatrix(scorecard: ProjectReportDto['citationScorecard']): string {
  if (scorecard.queries.length === 0 || scorecard.providers.length === 0) {
    return renderEmpty('Run a check to populate the citation matrix.')
  }
  const headers = scorecard.providers.map(p => `<th>${escapeHtml(p)}</th>`).join('')
  const rows = scorecard.queries.map((q, qi) => {
    const cells = scorecard.providers.map((_, pi) => {
      const cell = scorecard.matrix[qi]?.[pi]
      if (!cell) {
        return '<td><span class="cell-pending">— —</span></td>'
      }
      // Two-glyph cell — citation flag then mention flag — per the AGENTS.md
      // vocabulary rules. A query can be cited without being mentioned and
      // vice versa, so a single label would conflate independent signals.
      const citedGlyph = cell.citationState === CitationStates.cited
        ? '<span class="cell-cited">C</span>'
        : '<span class="cell-not-cited">c</span>'
      const mentionedGlyph = cell.answerMentioned === true
        ? '<span class="cell-cited">M</span>'
        : cell.answerMentioned === false
          ? '<span class="cell-not-cited">m</span>'
          : '<span class="cell-pending">–</span>'
      return `<td>${citedGlyph} ${mentionedGlyph}</td>`
    }).join('')
    return `<tr><td>${escapeHtml(q)}</td>${cells}</tr>`
  }).join('')

  const legend = '<p class="section-intro" style="margin-top:0;font-size:11px;">Legend: <span class="cell-cited">C</span>/<span class="cell-not-cited">c</span> = cited/not, <span class="cell-cited">M</span>/<span class="cell-not-cited">m</span> = mentioned/not, <span class="cell-pending">–</span> = no data.</p>'

  return `${legend}<table class="report-table">
    <thead><tr><th>Query</th>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function renderCitationScorecard(report: ProjectReportDto): string {
  const body = `
    ${renderProviderBars(report.citationScorecard.providerRates)}
    ${renderCitationMatrix(report.citationScorecard)}
  `
  return section(
    { id: 'citation-scorecard', eyebrow: 'Section 3', title: 'Citation Scorecard', intro: 'Per-engine citation and mention coverage from the latest check.' },
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
  return renderLandscapeBars(data, 'Citations per domain', 'Citations per domain bar chart')
}

function renderMentionBars(landscape: ProjectReportDto['mentionLandscape'], canonical: string): string {
  const data: LandscapeBar[] = [
    { label: canonical, count: landscape.projectMentionCount, isProject: true },
    ...landscape.competitors.map(c => ({ label: c.domain, count: c.mentionCount, isProject: false })),
  ]
  return renderLandscapeBars(data, 'Mentions per domain', 'Mentions per domain bar chart')
}

function renderCompetitorLandscape(report: ProjectReportDto): string {
  const competitors = report.competitorLandscape.competitors
  const mentionLandscape = report.mentionLandscape
  const noCitationData = competitors.length === 0 && report.competitorLandscape.projectCitationCount === 0
  const noMentionData = mentionLandscape.competitors.length === 0 && mentionLandscape.projectMentionCount === 0
  if (noCitationData && noMentionData) {
    return section(
      { id: 'competitor-landscape', eyebrow: 'Section 4', title: 'Competitor Landscape' },
      renderEmpty('No competitor data yet. Add competitors and run a check.'),
    )
  }

  const mentionByDomain = new Map(mentionLandscape.competitors.map(m => [m.domain, m]))
  const rows = competitors.map(c => {
    const tone = pressureTone(c.pressureLabel)
    const mention = mentionByDomain.get(c.domain)
    const mentionCount = mention?.mentionCount ?? 0
    const mentionTotal = mention?.totalCount ?? mentionLandscape.totalAnswerSnapshots
    const pagesDisclosure = c.theirCitedPages.length > 0
      ? `<details class="cited-pages"><summary>${c.theirCitedPages.length} cited URL${c.theirCitedPages.length > 1 ? 's' : ''}</summary>
          <ul>${c.theirCitedPages.map(p => `<li><a href="${safeHref(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a> <span class="cited-for">${escapeHtml(p.citedFor.join(', '))}</span></li>`).join('')}</ul>
        </details>`
      : ''
    return `<tr>
      <td>${escapeHtml(c.domain)}</td>
      <td><span class="badge tone-${tone}">${escapeHtml(c.pressureLabel)}</span></td>
      <td class="numeric">${c.citationCount} / ${c.totalCount}</td>
      <td class="numeric">${mentionCount} / ${mentionTotal}</td>
      <td class="numeric">${c.sharePct}%</td>
      <td>${escapeHtml(c.citedQueries.slice(0, 5).join(', '))}${c.citedQueries.length > 5 ? '…' : ''}${pagesDisclosure}</td>
    </tr>`
  }).join('')

  const table = competitors.length > 0
    ? `<table class="report-table">
        <thead><tr><th>Domain</th><th>Pressure</th><th>Citations</th><th class="numeric">Mentions</th><th class="numeric" title="Citation share — % of cited-source slots that went to this competitor across tracked queries. Distinct from Mention Share.">Citation share</th><th>Cited queries</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : renderEmpty('No competitors configured.')

  const citationBars = renderCompetitorBars(report.competitorLandscape, report.meta.project.canonicalDomain)
  const mentionBars = renderMentionBars(mentionLandscape, report.meta.project.canonicalDomain)
  const charts = citationBars && mentionBars
    ? `<div class="chart-grid">${citationBars}${mentionBars}</div>`
    : `${citationBars}${mentionBars}`

  return section(
    {
      id: 'competitor-landscape',
      eyebrow: 'Section 4',
      title: 'Competitor Landscape',
      intro: 'Who AI engines cite and mention instead of the client.',
    },
    `${charts}${table}`,
  )
}

const SOURCE_CATEGORY_TONE: Record<string, 'positive' | 'caution' | 'negative' | 'neutral'> = {
  competitor: 'negative',
  directory: 'caution',
  forum: 'caution',
  news: 'neutral',
  reference: 'neutral',
  blog: 'neutral',
  social: 'neutral',
  video: 'neutral',
  ecommerce: 'neutral',
  academic: 'neutral',
  other: 'neutral',
}

function renderCategoryBars(buckets: AiSourceCategoryBucket[]): string {
  if (buckets.length === 0) return ''
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return ''
  const max = Math.max(...buckets.map(b => b.count), 1)

  const rows = buckets.map((b) => {
    const pct = (b.count / max) * 100
    const tone = SOURCE_CATEGORY_TONE[b.category] ?? 'neutral'
    const color = tone === 'negative' ? COLORS.negative
      : tone === 'caution' ? COLORS.caution
      : COLORS.accent
    return `
      <div class="source-bar-row">
        <div class="source-bar-label">${escapeHtml(b.label)}</div>
        <div class="source-bar-track">
          <div class="source-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
        </div>
        <div class="source-bar-value">${b.count} <span class="source-bar-pct">(${b.sharePct}%)</span></div>
      </div>`
  }).join('')

  return `<div class="chart-card">
    <h3>By source type</h3>
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
        <div class="source-bar-value">${formatNumber(r.count)} <span class="source-bar-pct">${escapeHtml(countLabel)} · ${r.sharePct}%</span></div>
      </div>`
  }).join('')

  return `<div class="chart-card">
    <h3>${escapeHtml(heading)}</h3>
    <div class="source-bars">${bars}</div>
  </div>`
}

function renderAiSourceOrigin(report: ProjectReportDto): string {
  const origin = report.aiSourceOrigin
  if (origin.categories.length === 0 && origin.topDomains.length === 0) {
    return section(
      { id: 'ai-source-origin', eyebrow: 'Section 5', title: 'AI Citation Sources' },
      renderEmpty('No source data yet. Run a check first.'),
    )
  }

  const competitorBucket = origin.categories.find(c => c.category === 'competitor')
  const headlineFragment = competitorBucket
    ? `<p class="source-origin-headline"><strong>${competitorBucket.sharePct}%</strong> of citations went to tracked competitors (${competitorBucket.count} of ${origin.categories.reduce((s, c) => s + c.count, 0)}).</p>`
    : ''

  const rows = origin.topDomains.map(d => `
    <tr>
      <td>${escapeHtml(d.domain)}</td>
      <td class="numeric">${d.count}</td>
      <td>${d.isCompetitor ? '<span class="badge tone-negative">Tracked competitor</span>' : '<span class="badge tone-neutral">External</span>'}</td>
    </tr>`).join('')

  const table = origin.topDomains.length > 0
    ? `<div class="chart-card"><h3>Top sources</h3>
        <table class="report-table">
          <thead><tr><th>Domain</th><th class="numeric">Citations</th><th>Tag</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    : ''

  return section(
    {
      id: 'ai-source-origin',
      eyebrow: 'Section 5',
      title: 'AI Citation Sources',
      intro: 'External domains AI engines cited most in the latest check.',
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
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapeHtml(title)} line chart">
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
  if (!gsc) {
    return section(
      { id: 'gsc', eyebrow: 'Section 6', title: 'GSC Performance' },
      renderEmpty('Connect Google Search Console to populate this section.'),
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
    'Search demand by intent',
    gsc.categoryBreakdown.map((c, index) => ({
      label: c.category,
      count: c.clicks,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    'clicks',
  )

  const trendChart = renderLineChart(
    gsc.trend.map(t => ({ x: t.date, y: t.clicks, label: t.date.slice(5) })),
    COLORS.accent,
    'Clicks over time',
  )

  const crossoverBlocks: string[] = []
  if (gsc.trackedButNoGsc.length > 0) {
    crossoverBlocks.push(`<div class="chart-card"><h3>AEO queries without search demand</h3>
      <p class="section-intro">Review whether these still belong in the tracking set.</p>
      ${renderProofChips(gsc.trackedButNoGsc, 6)}
    </div>`)
  }
  if (gsc.gscButNotTracked.length > 0) {
    crossoverBlocks.push(`<div class="chart-card"><h3>Search queries you should track</h3>
      <p class="section-intro">High-impression candidates to add to AEO tracking.</p>
      ${renderProofChips(gsc.gscButNotTracked, 6)}
    </div>`)
  }

  const dateRange = gscDateRange(report)

  return section(
    { id: 'gsc', eyebrow: 'Section 6', title: 'GSC Performance', intro: `Search demand signals to compare against AI visibility${dateRange ? ` for ${dateRange}` : ''}.` },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total clicks</div><div class="value">${formatNumber(gsc.totalClicks)}</div></div>
      <div class="metric"><div class="label">Total impressions</div><div class="value">${formatNumber(gsc.totalImpressions)}</div></div>
      <div class="metric"><div class="label">Avg CTR</div><div class="value">${formatRatio(gsc.ctr)}</div></div>
      <div class="metric"><div class="label">Avg position</div><div class="value">${gsc.avgPosition.toFixed(1)}</div></div>
    </div>
    ${trendChart}
    <div class="chart-card"><h3>Top queries</h3>
      <table class="report-table">
        <thead><tr><th>Query</th><th class="numeric">Clicks</th><th class="numeric">Imp.</th><th class="numeric">CTR</th><th class="numeric">Pos.</th><th>Category</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${categoryBars}
    ${crossoverBlocks.join('\n')}`,
  )
}

function renderGa(report: ProjectReportDto): string {
  const ga = report.ga
  if (!ga) {
    return section(
      { id: 'ga', eyebrow: 'Section 7', title: 'GA4 Traffic' },
      renderEmpty('Connect Google Analytics 4 to populate this section.'),
    )
  }

  const pageRows = ga.topLandingPages.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
      <td class="numeric">${formatNumber(p.users)}</td>
      <td class="numeric">${formatNumber(p.organicSessions)}</td>
    </tr>`).join('')

  const channelBars = renderShareBars(
    'Channel mix',
    ga.channelBreakdown.map((c, index) => ({
      label: c.channel,
      count: c.sessions,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    'sessions',
  )

  return section(
    { id: 'ga', eyebrow: 'Section 7', title: 'GA4 Traffic', intro: `Site traffic from ${formatDate(ga.periodStart)} to ${formatDate(ga.periodEnd)}.` },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total sessions</div><div class="value">${formatNumber(ga.totalSessions)}</div></div>
      <div class="metric"><div class="label">Total users</div><div class="value">${formatNumber(ga.totalUsers)}</div></div>
      <div class="metric"><div class="label">Organic sessions</div><div class="value">${formatNumber(ga.totalOrganicSessions)}</div></div>
    </div>
    <div class="chart-card"><h3>Top landing pages</h3>
      <table class="report-table">
        <thead><tr><th>Page</th><th class="numeric">Sessions</th><th class="numeric">Users</th><th class="numeric">Organic</th></tr></thead>
        <tbody>${pageRows}</tbody>
      </table>
    </div>
    ${channelBars}`,
  )
}

function renderSocial(report: ProjectReportDto): string {
  const social = report.socialReferrals
  if (!social) {
    return section(
      { id: 'social-referrals', eyebrow: 'Section 8', title: 'Social Referrals' },
      renderEmpty('No social referral data yet.'),
    )
  }

  const channelBars = renderShareBars(
    'Social channel mix',
    social.channels.map((c, index) => ({
      label: c.channelGroup,
      count: c.sessions,
      sharePct: c.sharePct,
      color: COLORS.series[index % COLORS.series.length],
    })),
    'sessions',
  )

  const campaignRows = social.topCampaigns.map(c => `
    <tr>
      <td>${escapeHtml(c.source)}</td>
      <td>${escapeHtml(c.medium)}</td>
      <td class="numeric">${formatNumber(c.sessions)}</td>
    </tr>`).join('')

  return section(
    { id: 'social-referrals', eyebrow: 'Section 8', title: 'Social Referrals', intro: 'Social traffic split by channel and campaign.' },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total sessions</div><div class="value">${formatNumber(social.totalSessions)}</div></div>
      <div class="metric"><div class="label">Organic social</div><div class="value">${formatNumber(social.organicSessions)}</div></div>
      <div class="metric"><div class="label">Paid social</div><div class="value">${formatNumber(social.paidSessions)}</div></div>
    </div>
    ${channelBars}
    <div class="chart-card"><h3>Top campaigns</h3>
      <table class="report-table">
        <thead><tr><th>Source</th><th>Medium</th><th class="numeric">Sessions</th></tr></thead>
        <tbody>${campaignRows}</tbody>
      </table>
    </div>`,
  )
}

function renderAiReferrals(report: ProjectReportDto): string {
  const ai = report.aiReferrals
  if (!ai) {
    return section(
      { id: 'ai-referrals', eyebrow: 'Section 9', title: 'AI Referral Traffic' },
      renderEmpty('No AI referral traffic detected yet.'),
    )
  }

  const sourceBars = renderShareBars(
    'AI sessions by source',
    ai.bySource.map((s, index) => ({
      label: s.source,
      count: s.sessions,
      sharePct: s.sharePct,
      color: COLORS.series[(index + 2) % COLORS.series.length],
    })),
    'sessions',
  )

  const pageRows = ai.topLandingPages.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
      <td class="numeric">${formatNumber(p.users)}</td>
    </tr>`).join('')

  const trendChart = renderLineChart(
    ai.trend.map(t => ({ x: t.date, y: t.sessions, label: t.date.slice(5) })),
    COLORS.series[2]!,
    'AI referral sessions over time',
  )

  return section(
    { id: 'ai-referrals', eyebrow: 'Section 9', title: 'AI Referral Traffic', intro: 'Traffic arriving from AI answer engines.' },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total sessions</div><div class="value">${formatNumber(ai.totalSessions)}</div></div>
      <div class="metric"><div class="label">Total users</div><div class="value">${formatNumber(ai.totalUsers)}</div></div>
    </div>
    ${trendChart}
    ${sourceBars}
    <div class="chart-card"><h3>Top AI landing pages</h3>
      <table class="report-table">
        <thead><tr><th>Page</th><th class="numeric">Sessions</th><th class="numeric">Users</th></tr></thead>
        <tbody>${pageRows}</tbody>
      </table>
    </div>`,
  )
}

// Section heading metadata for "AI Visibility — Server-Side". The SPA and
// HTML must render the SAME eyebrow/title/intro per audience — see the
// report-parity rule in `AGENTS.md`.
function serverActivityHeading(audience: ReportAudience, hasData: boolean): {
  id: string
  eyebrow: string
  title: string
  intro: string
} {
  const isClient = audience === 'client'
  return {
    id: 'server-activity',
    eyebrow: isClient ? 'AI engine attention' : 'Section 10',
    title: 'AI Visibility — Server-Side',
    intro: isClient
      ? hasData
        ? 'What AI engines actually do in your server logs over the last 7 days — the other half of citations.'
        : 'Live telemetry from your server logs.'
      : 'What AI engines actually do in your server logs — direct evidence, complementary to citations (which measure what they say).',
  }
}

function renderServerActivity(report: ProjectReportDto, audience: ReportAudience): string {
  const sa = report.serverActivity
  const isClient = audience === 'client'
  // Client view stays silent when no source is connected — surfacing a
  // "connect a Cloud Run source" call-to-action to a client who has no
  // technical access produces noise. Agency view shows the prompt because
  // the operator is the audience that can act on it.
  if (!sa) {
    if (isClient) return ''
    return section(
      serverActivityHeading('agency', false),
      renderEmpty('Connect a server-side traffic source to surface what AI engines do directly in your server logs — distinct from GA4 click-throughs.'),
    )
  }
  if (!sa.hasData) {
    return section(
      serverActivityHeading(audience, false),
      renderEmpty(isClient
        ? 'Your server-side traffic source is connected. Numbers will appear after the next sync.'
        : 'Source connected — collecting your first data. Numbers will appear after the next sync.'),
    )
  }

  const formatDelta = (d: { current: number; prior: number; deltaPct: number | null }, suffix: string) => {
    const copy = formatDeltaCopy(d, suffix)
    if (!copy) return ''
    return `<span class="tone-${deltaTone(d.deltaPct)}">${escapeHtml(copy)}</span>`
  }

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
    const crawlerTrustSummary = `${formatNumber(sa.verifiedCrawlerHits.current)} verified · ${formatNumber(sa.unverifiedCrawlerHits.current)} unverified`
    const crawlerDelta = formatDelta(crawlerRequests, 'requests')
    const crawlerSubtitle = crawlerDelta
      ? `${escapeHtml(crawlerTrustSummary)} · ${crawlerDelta}`
      : escapeHtml(crawlerTrustSummary)
    const userFetchDelta = formatDelta(sa.aiUserFetchHits, 'requests')
    const userFetchSubtitle = userFetchDelta
      || escapeHtml('ChatGPT-User, Perplexity-User, MistralAI-User')
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

    return section(
      serverActivityHeading('client', true),
      `<div class="metric-grid">
        <div class="metric">
          <div class="label">AI bot requests observed</div>
          <div class="value">${formatNumber(crawlerRequests.current)}</div>
          <div class="subtitle">${crawlerSubtitle}</div>
        </div>
        <div class="metric">
          <div class="label">AI user-fetch requests</div>
          <div class="value">${formatNumber(sa.aiUserFetchHits.current)}</div>
          <div class="subtitle">${userFetchSubtitle}</div>
        </div>
        <div class="metric">
          <div class="label">AI referral sessions</div>
          <div class="value">${formatNumber(sa.referralArrivals.current)}</div>
          <div class="subtitle">${formatDelta(sa.referralArrivals, 'sessions')}</div>
        </div>
      </div>
      ${clientOperatorRows ? `<div class="chart-card"><h3>By AI tool</h3>
        <table class="report-table">
          <thead><tr><th>AI tool</th><th class="numeric">Bot requests (7d)</th><th class="numeric">User fetches (7d)</th><th class="numeric">Referral sessions</th></tr></thead>
          <tbody>${clientOperatorRows}</tbody>
        </table>
        <p class="meta">Bot requests are bulk crawl (GPTBot, PerplexityBot, …). User fetches are on-demand reads triggered by real users inside an AI surface (ChatGPT-User, Perplexity-User, …). Verified requests are reverse-DNS confirmed; unverified requests are UA claims shown separately in agency diagnostics.</p>
      </div>` : ''}`,
    )
  }

  // ── Agency view (full forensic detail) ──
  const operatorRows = sa.byOperator.map(o => {
    const deltaText = o.deltaPct === null
      ? '—'
      : `${o.deltaPct > 0 ? '+' : ''}${o.deltaPct}%`
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

  const pathRows = sa.topCrawledPaths.map(p => `
    <tr>
      <td class="page-cell">${formatLandingPageHtml(p.path)}</td>
      <td class="numeric">${formatNumber(p.verifiedHits)}</td>
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
        'Verified crawler hits over time (last 14 days)',
      )
    : ''

  return section(
    serverActivityHeading('agency', true),
    `<div class="metric-grid">
      <div class="metric">
        <div class="label">Verified crawler hits (7d)</div>
        <div class="value">${formatNumber(sa.verifiedCrawlerHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.verifiedCrawlerHits, 'hits')}</div>
      </div>
      <div class="metric">
        <div class="label">Unverified crawler hits (7d)</div>
        <div class="value">${formatNumber(sa.unverifiedCrawlerHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.unverifiedCrawlerHits, 'hits')}</div>
      </div>
      <div class="metric">
        <div class="label">AI user-fetch hits (7d)</div>
        <div class="value">${formatNumber(sa.aiUserFetchHits.current)}</div>
        <div class="subtitle">${formatDelta(sa.aiUserFetchHits, 'hits')}</div>
      </div>
      <div class="metric">
        <div class="label">AI-referral sessions (7d)</div>
        <div class="value">${formatNumber(sa.referralArrivals.current)}</div>
        <div class="subtitle">${formatDelta(sa.referralArrivals, 'sessions')}</div>
      </div>
    </div>
    ${trendChart}
    ${operatorRows ? `<div class="chart-card"><h3>Per AI operator</h3>
      <p class="meta">Verified means rDNS-confirmed. Unverified bots claim the user-agent but couldn't be verified — could be the real bot or an imitator. User fetches are on-demand reads from an AI surface on behalf of a real user (ChatGPT-User, Perplexity-User, …) — disjoint from bulk crawl.</p>
      <table class="report-table">
        <thead><tr><th>Operator</th><th class="numeric">Verified hits</th><th class="numeric">Unverified</th><th class="numeric">User fetches</th><th class="numeric">Referral sessions</th><th class="numeric">7d delta</th></tr></thead>
        <tbody>${operatorRows}</tbody>
      </table>
    </div>` : ''}
    ${pathRows ? `<div class="chart-card"><h3>Top crawled paths</h3>
      <p class="meta">Pages AI bots fetched most often (verified only, last 7d).</p>
      <table class="report-table">
        <thead><tr><th>Path</th><th class="numeric">Verified hits</th><th class="numeric">Distinct operators</th></tr></thead>
        <tbody>${pathRows}</tbody>
      </table>
    </div>` : ''}
    ${referralProductRows ? `<div class="chart-card"><h3>AI-referral sessions by product</h3>
      <p class="meta">Where humans landed coming from each AI product (chatgpt.com, claude.ai, …).</p>
      <table class="report-table">
        <thead><tr><th>Product</th><th class="numeric">Sessions</th><th class="numeric">Distinct landing paths</th></tr></thead>
        <tbody>${referralProductRows}</tbody>
      </table>
    </div>` : ''}
    ${referralLandingRows ? `<div class="chart-card"><h3>Top AI-referral landing paths</h3>
      <table class="report-table">
        <thead><tr><th>Path</th><th class="numeric">Sessions</th><th class="numeric">Distinct products</th></tr></thead>
        <tbody>${referralLandingRows}</tbody>
      </table>
    </div>` : ''}`,
  )
}

function renderIndexingHealth(report: ProjectReportDto): string {
  const ih = report.indexingHealth
  if (!ih) {
    return section(
      { id: 'indexing-health', eyebrow: 'Section 11', title: 'Indexing Health' },
      renderEmpty('Connect Google Search Console or Bing Webmaster Tools and run a sitemap inspection.'),
    )
  }

  const segments = [
    { label: 'Indexed', count: ih.indexed, color: COLORS.positive },
    { label: 'Not indexed', count: ih.notIndexed, color: COLORS.caution },
    { label: 'Deindexed', count: ih.deindexed, color: COLORS.negative },
    { label: 'Unknown', count: ih.unknown, color: COLORS.neutral },
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

  const legend = segments.map(s => `<span><span class="legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}: ${s.count}</span>`).join('')

  return section(
    { id: 'indexing-health', eyebrow: 'Section 11', title: 'Indexing Health', intro: `Pages absent from ${ih.provider === 'google' ? 'Google' : 'Bing'} are harder for AI engines to retrieve.` },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Indexed</div><div class="value tone-positive">${formatNumber(ih.indexed)}</div></div>
      <div class="metric"><div class="label">Total inspected</div><div class="value">${formatNumber(ih.total)}</div></div>
      <div class="metric"><div class="label">Indexed share</div><div class="value">${ih.indexedPct}%</div></div>
    </div>
    <div class="chart-card">
      <h3>Coverage breakdown</h3>
      <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Coverage stacked bar">${bars}</svg>
      <div class="legend">${legend}</div>
    </div>`,
  )
}

function renderCitationsTrend(report: ProjectReportDto): string {
  const trend = report.citationsTrend
  if (trend.length === 0) {
    return section(
      { id: 'citations-trend', eyebrow: 'Section 12', title: 'Citations Over Time' },
      renderEmpty('Run multiple checks to see a trend.'),
    )
  }

  if (isTrendBaseline(trend)) {
    return section(
      { id: 'citations-trend', eyebrow: 'Section 12', title: 'Citations Over Time' },
      renderEmpty(`Building baseline (${trend.length} of ${MIN_TREND_POINTS} checks completed). Trend will appear once more checks are recorded.`),
    )
  }

  const chart = renderLineChart(
    trend.map(t => ({ x: t.date, y: t.citationRate, label: formatDate(t.date) })),
    COLORS.positive,
    'Overall citation rate',
    220,
  )

  const rows = trend.map((t: CitationsTrendPoint) => `
    <tr>
      <td>${formatDate(t.date)}</td>
      <td class="numeric">${t.citationRate}% <span class="cell-pending">(${t.citedQueryCount}/${t.totalQueryCount})</span></td>
      <td>${t.providerRates.map(r => `${escapeHtml(r.provider)}: ${r.citationRate}%`).join(' · ')}</td>
    </tr>`).join('')

  return section(
    { id: 'citations-trend', eyebrow: 'Section 12', title: 'Citations Over Time', intro: 'Citation coverage across recent checks.' },
    `${chart}
    <div class="chart-card"><h3>Check-by-check breakdown</h3>
      <table class="report-table">
        <thead><tr><th>Check</th><th class="numeric">Cited queries</th><th>Per-engine rates</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`,
  )
}

function renderInsights(report: ProjectReportDto): string {
  const list = report.insights
  if (list.length === 0) {
    return section(
      { id: 'insights', eyebrow: 'Section 13', title: 'Insights & Alerts' },
      renderEmpty('No insights yet — run a check to generate alerts.'),
    )
  }

  // The API has already deduped by (query, provider, type); use the per-row
  // `instanceCount` instead of regrouping client-side. Older fixtures without
  // the field fall back to a defensive group pass.
  const haveDeduped = list.every((i) => typeof i.instanceCount === 'number')
  const rows = (haveDeduped ? list.map((i) => ({ rep: i, count: i.instanceCount })) : groupInsights(list).map((g) => ({ rep: g.representative, count: g.count })))
    .map(({ rep: i, count }) => {
      const tone = severityTone(i.severity)
      const countChip = count > 1
        ? ` <span class="badge tone-neutral">× ${count}</span>`
        : ''
      return `<tr>
        <td class="col-severity"><span class="badge tone-${tone}">${escapeHtml(reportSeverityLabel(i.severity))}</span></td>
        <td class="col-title">${escapeHtml(i.title)}${countChip}</td>
        <td class="col-query">${escapeHtml(i.query)}</td>
        <td class="col-provider">${escapeHtml(i.provider)}</td>
        <td class="col-recommendation">${i.recommendation ? escapeHtml(i.recommendation) : '<span class="cell-pending">—</span>'}</td>
      </tr>`
    }).join('')

  return section(
    { id: 'insights', eyebrow: 'Section 13', title: 'Insights & Alerts', intro: 'Regressions, gains, and recurring alerts ordered by severity.' },
    `<table class="report-table insights-table">
      <thead><tr>
        <th class="col-severity">Severity</th>
        <th class="col-title">Title</th>
        <th class="col-query">Query</th>
        <th class="col-provider">Provider</th>
        <th class="col-recommendation">Recommendation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  )
}

function renderOpportunities(report: ProjectReportDto): string {
  const opps = dedupeReportOpportunities(report)
  if (opps.length === 0) return ''

  const canonical = report.meta.project.canonicalDomain
  const highlights = `<div class="opportunity-grid">
    ${opps.slice(0, 3).map(o => `<article class="opportunity-card">
      <div class="opportunity-score" title="Opportunity score (0–100, higher = stronger)">${Math.round(o.score)}<span class="opportunity-score-suffix">/100</span></div>
      <h3>${escapeHtml(o.query)}</h3>
      <p>${escapeHtml(contentActionLabel(o.action))} · ${escapeHtml(actionConfidenceLabel(o.actionConfidence))} confidence</p>
      ${renderProofChips(o.drivers, 2)}
    </article>`).join('')}
  </div>`
  const rows = opps.slice(0, 10).map((o) => {
    const ourPage = o.ourBestPage
      ? `<a href="${safeHref(absolutizeProjectUrl(o.ourBestPage.url, canonical))}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.ourBestPage.url)}</a>`
      : '<span class="cell-not-cited">No page yet</span>'
    const winning = o.winningCompetitor
      ? `<a href="${safeHref(o.winningCompetitor.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.winningCompetitor.domain)}</a>`
      : '<span class="cell-not-cited">—</span>'
    const drivers = o.drivers.length > 0
      ? `<ul class="driver-list">${o.drivers.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
      : '<span class="cell-not-cited">No driver signal yet</span>'
    return `<tr>
      <td>${escapeHtml(o.query)}</td>
      <td><span class="badge tone-neutral">${escapeHtml(contentActionLabel(o.action))}</span></td>
      <td class="numeric" title="Opportunity score (0–100)">${Math.round(o.score)}</td>
      <td>${drivers}</td>
      <td>${ourPage}</td>
      <td>${winning}</td>
      <td><span class="badge tone-neutral">${escapeHtml(actionConfidenceLabel(o.actionConfidence))}</span></td>
    </tr>`
  }).join('')

  return section(
    {
      id: 'content-opportunities',
      eyebrow: 'Section 14',
      title: 'Content Opportunities',
      intro: 'Queries where content work has the clearest path to more AI citations. Opportunity score is 0–100, higher = stronger.',
    },
    `${highlights}<table class="report-table">
      <thead><tr><th>Query</th><th>Action</th><th class="numeric" title="Opportunity score (0–100)">Score</th><th>Why</th><th>Our page</th><th>Winning competitor</th><th>Confidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  )
}

function renderContentGaps(report: ProjectReportDto): string {
  const gaps = report.contentGaps
  if (gaps.length === 0) return ''
  const rows = gaps.slice(0, 10).map(g => {
    const competitorList = g.competitorDomains.slice(0, 5).map(escapeHtml).join(', ')
    const more = g.competitorDomains.length > 5 ? `, +${g.competitorDomains.length - 5} more` : ''
    return `<tr>
      <td>${escapeHtml(g.query)}</td>
      <td class="numeric">${g.competitorCount}</td>
      <td>${competitorList}${more}</td>
      <td class="numeric">${Math.round(g.missRate * 100)}%</td>
    </tr>`
  }).join('')
  return section(
    {
      id: 'content-gaps',
      eyebrow: 'Section 15',
      title: 'Content Gaps',
      intro: 'Tracked queries where competitors are cited and the client is missing.',
    },
    `<table class="report-table">
      <thead><tr><th>Query</th><th class="numeric">Competitors cited</th><th>Domains</th><th class="numeric">Miss rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  )
}

function renderRecommendedNextSteps(report: ProjectReportDto): string {
  // The API already merges insight-driven and opportunity-driven steps via
  // `mapOpportunitiesToNextSteps`; consume the result directly per the
  // UI/CLI parity rule (no UI-only calculations).
  const steps = report.recommendedNextSteps
  if (steps.length === 0) {
    return section(
      { id: 'recommended-next-steps', eyebrow: 'Section 16', title: 'Recommended Next Steps', intro: 'Action items bucketed by timing.' },
      renderEmpty('No outstanding actions.'),
    )
  }

  const items = steps.map(s => `
    <div class="step">
      <span class="horizon">${escapeHtml(s.horizon)}</span>
      <span class="title">${escapeHtml(s.title)}</span>
      <span class="rationale">${escapeHtml(s.rationale)}</span>
    </div>`).join('')

  return section(
    { id: 'recommended-next-steps', eyebrow: 'Section 16', title: 'Recommended Next Steps', intro: 'Action items bucketed by timing.' },
    `<div class="steps">${items}</div>`,
  )
}

function actionAudienceMatches(action: ReportActionPlanItem, audience: ReportAudience): boolean {
  return action.audience === 'both' || action.audience === audience
}

function renderActionCards(actions: readonly ReportActionPlanItem[], audience: ReportAudience): string {
  const isClient = audience === 'client'
  if (actions.length === 0) return renderEmpty(isClient ? 'No recommendations yet — run an AI check to populate this.' : 'No prioritized actions yet.')
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
            <summary>${isClient ? 'See the data behind this' : 'Evidence details'}</summary>
            ${why ? `<div><strong>${isClient ? 'Why this matters' : 'Why'}</strong>${why}</div>` : ''}
            ${evidence ? `<div><strong>${isClient ? 'What we saw' : 'Evidence'}</strong>${evidence}</div>` : ''}
          </details>`
        : ''
      const horizonLabel = isClient ? clientHorizonLabel(action.horizon) : reportHorizonLabel(action.horizon)
      const confidenceLabel = isClient ? clientConfidenceLabel(action.confidence) : `${reportConfidenceLabel(action.confidence)} confidence`
      const categoryBadge = isClient ? '' : `<span class="badge tone-neutral">${escapeHtml(reportActionCategoryLabel(action.category))}</span>`
      const successLabel = isClient ? 'What success looks like:' : 'Win condition:'
      return `<article class="action-card">
        <div class="action-head">
          <div class="action-rank" title="${isClient ? 'Priority — 1 will move the needle fastest' : 'Impact rank — 1 is the highest-leverage action'}">${idx + 1}</div>
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
  const rawActions = audience === 'client'
    ? report.clientSummary.actionItems
    : report.agencyDiagnostics.priorities.length > 0
      ? report.agencyDiagnostics.priorities
      : report.actionPlan.filter(a => actionAudienceMatches(a, audience))
  const actions = dedupeReportActions(report, rawActions)
  return section(
    {
      id: audience === 'client' ? 'client-action-plan' : 'agency-action-plan',
      eyebrow: audience === 'client' ? 'Action plan' : 'Agency actions',
      title: audience === 'client' ? 'What to do next' : 'Agency Action Plan',
      intro: audience === 'client'
        ? 'Approve these in order. They are sorted by what will move the needle fastest.'
        : 'The highest-leverage work, sorted by urgency and evidence strength.',
    },
    renderActionCards(actions, audience),
  )
}

function renderClientSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const sc = report.citationScorecard
  const totalQ = s.totalQueryCount
  const heroNumber = totalQ > 0 ? `${s.citationRate}%` : '—'
  const heroSentence = totalQ > 0
    ? `When customers asked AI ${totalQ} ${pluralize(totalQ, 'question')} about your industry, AI linked to your website in ${s.citedQueryCount} of ${totalQ === 1 ? 'them' : 'those answers'}.`
    : 'No AI check has been run yet. Run a check to see how AI tools answer customer questions about your business.'
  const trend = clientTrendCopy(report.whatsChanged.citationRate)
  const heroTrend = trend
    ? `<p class="client-hero-trend tone-${trend.tone}"><span style="margin-right:6px;">${trend.arrow}</span>${escapeHtml(trend.text)}</p>`
    : ''
  const hero = `<div class="client-hero">
    <div class="client-hero-eyebrow">Overview</div>
    <div class="client-hero-number">${heroNumber}</div>
    <p class="client-hero-sentence">${escapeHtml(heroSentence)}</p>
    ${heroTrend}
  </div>`

  const providerSubtitle = sc.providers.length > 0
    ? sc.providers.map(providerDisplayName).join(', ')
    : `${formatNumber(s.queryCount)} ${pluralize(s.queryCount, 'question')} tested`

  const tiles = `<div class="client-metric-grid">
    <div class="client-metric-tile">
      <div class="label">AI mentions your name</div>
      <div class="value">${s.mentionRate}%</div>
      <div class="subtitle">${totalQ > 0 ? `Says your name in ${s.mentionedQueryCount} of ${totalQ} ${pluralize(totalQ, 'answer')}` : 'No data yet'}</div>
    </div>
    <div class="client-metric-tile">
      <div class="label">AI links to your website</div>
      <div class="value">${s.citationRate}%</div>
      <div class="subtitle">${totalQ > 0 ? `Cites your site as a source in ${s.citedQueryCount} of ${totalQ} ${pluralize(totalQ, 'answer')}` : 'No data yet'}</div>
    </div>
    <div class="client-metric-tile">
      <div class="label">AI tools tested</div>
      <div class="value">${formatNumber(s.providerCount)}</div>
      <div class="subtitle">${escapeHtml(providerSubtitle)}</div>
    </div>
  </div>`

  const explainer = `<div class="client-explainer">
    <strong>Mentions and links are different.</strong>
    A <span class="term">mention</span> is when AI says your name out loud in its answer.
    A <span class="term">link</span> is when AI lists your website as a source it used.
    AI can do either, both, or neither — that's why we track both.
  </div>`

  const questions = sc.queries.length > 0
    ? `<div class="client-card">
        <h3>Customer questions we tested</h3>
        <p class="card-subtitle">These are the ${sc.queries.length} ${pluralize(sc.queries.length, 'question we asked', 'questions we asked')} every AI tool. The numbers above measure how often you came up.</p>
        <ol class="client-questions-list">
          ${sc.queries.map((q, i) => `<li><span class="qnum">${String(i + 1).padStart(2, '0')}</span><span>"${escapeHtml(q)}"</span></li>`).join('')}
        </ol>
      </div>`
    : ''

  const providerBars = sc.providerRates.length > 0
    ? `<div class="client-card">
        <h3>How often each AI tool links to your website</h3>
        <p class="card-subtitle">Higher is better. Each bar shows the share of customer questions where the AI cited your site.</p>
        <div class="client-bar-list">
          ${sc.providerRates.map(r => {
            const pct = Math.max(r.citationRate, 1.5)
            return `<div class="client-bar-row">
              <span class="bar-label">${escapeHtml(providerDisplayName(r.provider))}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${r.citationRate}% <span class="bar-value-sub">(${r.citedCount}/${r.totalCount})</span></span>
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

  const cards: string[] = []

  if (ai.length > 0) {
    cards.push(`<div class="client-card">
      <h3>Where AI gets its answers</h3>
      <p class="card-subtitle">The websites AI tools cited most often when answering customer questions about your industry.</p>
      <div class="client-bar-list">
        ${ai.map(d => {
          const pct = aiMax > 0 ? Math.max((d.count / aiMax) * 100, 1.5) : 0
          const label = escapeHtml(d.domain) + (d.isCompetitor ? ' <span style="color:'+COLORS.textFaint+';font-size:11px;">(competitor)</span>' : '')
          return `<div class="client-bar-row">
            <span class="bar-label">${label}</span>
            <div class="bar-track"><div class="bar-fill bar-fill-neutral" style="width:${pct}%"></div></div>
            <span class="bar-value">${formatNumber(d.count)}×</span>
          </div>`
        }).join('')}
      </div>
    </div>`)
  }

  if (indexing) {
    const tone = indexing.indexedPct >= 90 ? 'positive' : indexing.indexedPct >= 70 ? 'caution' : 'negative'
    const fillPct = Math.max(indexing.indexedPct, 1.5)
    cards.push(`<div class="client-card">
      <h3>Pages Google can find on your site</h3>
      <p class="card-subtitle">Google indexing your site increases the chances of it appearing in AI search (especially Gemini).</p>
      <div class="client-progress-number tone-${tone}">${indexing.indexedPct}%</div>
      <div style="font-size:12px;color:${COLORS.textMuted};">${formatNumber(indexing.indexed)} of ${formatNumber(indexing.total)} pages indexed</div>
      <div class="client-progress-bar"><div class="client-progress-fill tone-${tone}" style="width:${fillPct}%"></div></div>
      <p style="margin:0;font-size:12px;color:${COLORS.textMuted};"><strong style="color:${COLORS.text};">${formatNumber(indexing.notIndexed)}</strong> ${pluralize(indexing.notIndexed, 'page is', 'pages are')} not indexed yet.</p>
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
              <span class="bar-value">${formatNumber(q.impressions)} ${pluralize(q.impressions, 'search', 'searches')}</span>
            </div>`
          }).join('')}
        </div>`
      : ''
    cards.push(`<div class="client-card">
      <h3>What people search Google for</h3>
      <p class="card-subtitle">You appeared in <strong style="color:${COLORS.text};">${formatNumber(gsc.totalImpressions)}</strong> Google searches and got <strong style="color:${COLORS.text};">${formatNumber(gsc.totalClicks)}</strong> ${pluralize(gsc.totalClicks, 'click')} this period.</p>
      ${queryRows}
    </div>`)
  }

  if (opportunities.length > 0) {
    cards.push(`<div class="client-card">
      <h3>Topics where you could improve</h3>
      <p class="card-subtitle">Customer questions where better content on your site would help AI cite you.</p>
      <ul class="client-opportunity-list">
        ${opportunities.map(o => `<li>
          <div class="op-query">${escapeHtml(o.query)}</div>
          <div class="op-action">${escapeHtml(contentActionLabel(o.action))}</div>
        </li>`).join('')}
      </ul>
    </div>`)
  }

  return section(
    {
      id: 'client-evidence-summary',
      eyebrow: 'What we based this on',
      title: 'The signals behind this plan',
      intro: 'The data behind the recommendations above. Switch to Agency for the full breakdowns.',
    },
    cards.length > 0
      ? `<div class="client-evidence-grid">${cards.join('')}</div>`
      : renderEmpty('No supporting evidence yet — this fills in after the first AI check.'),
  )
}

function renderAgencyDiagnostics(report: ProjectReportDto): string {
  const diagnostics = report.agencyDiagnostics.diagnostics
    .filter(d => d.title !== 'Location caveat')
  const body = diagnostics.length > 0
    ? `<div class="diagnostics-grid">
        ${diagnostics.map(d => `<div class="diagnostic-card tone-${d.severity}">
          <h3>${escapeHtml(d.title)}</h3>
          <p>${escapeHtml(d.detail)}</p>
          ${renderProofChips(d.evidence, 3)}
        </div>`).join('')}
      </div>`
    : renderEmpty('No agency diagnostics available yet.')
  return section(
    {
      id: 'agency-diagnostics',
      eyebrow: 'Agency diagnostics',
      title: 'Technical Diagnostics',
      intro: 'Fast-read operator flags behind the action plan.',
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
        renderClientSummary(report),
        renderWhatsChanged(report, 'client'),
        // Server-side AI visibility runs between WhatsChanged and the action
        // plan in BOTH the SPA and HTML so clients see the same ordered set
        // of sections in either surface (per the report-parity rule).
        renderServerActivity(report, 'client'),
        renderAudienceActionPlan(report, 'client'),
        renderClientEvidenceSummary(report),
      ].join('\n')
    : [
        renderExecutiveSummary(report),
        renderWhatsChanged(report, 'agency'),
        renderAudienceActionPlan(report, 'agency'),
        renderAgencyDiagnostics(report),
        renderCitationScorecard(report),
        renderCompetitorLandscape(report),
        renderAiSourceOrigin(report),
        renderGsc(report),
        renderGa(report),
        renderSocial(report),
        renderAiReferrals(report),
        renderServerActivity(report, 'agency'),
        renderIndexingHealth(report),
        renderCitationsTrend(report),
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
    <div class="eyebrow">AI Visibility Report</div>
    <h1>${escapeHtml(report.meta.project.displayName)}</h1>
    <div class="subtitle">${escapeHtml(report.meta.project.canonicalDomain)} · ${escapeHtml(report.meta.project.country)} / ${escapeHtml(report.meta.project.language.toUpperCase())}${renderHeaderLocationFragment(report.meta.location)} · Generated ${formatDate(report.meta.generatedAt)}</div>
  </header>
  ${sections}
  <footer class="footer">Generated by <a href="https://canonry.ai">canonry</a> · ${escapeHtml(formatIsoDate(report.meta.generatedAt))}</footer>
</div>
<script type="application/json" id="canonry-report-data">${json}</script>
</body>
</html>`
}
