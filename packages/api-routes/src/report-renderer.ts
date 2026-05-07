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

function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
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

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    const d = dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
      : new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', dateOnly ? { ...options, timeZone: 'UTC' } : options)
  } catch {
    return iso
  }
}

function formatDateRange(start: string, end: string): string {
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} → ${formatDate(end)}`
  return formatDate(start || end)
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
@media (max-width: 760px) {
  .container { padding: 32px 16px 72px; }
  .executive-hero { grid-template-columns: 1fr; }
  .headline-card .hero-title { font-size: 34px; }
  .source-bar-row { grid-template-columns: 1fr; gap: 6px; }
  .source-bar-value { text-align: left; }
  .chart-grid { grid-template-columns: 1fr; }
}
@media print {
  body { background: white; color: black; }
  section.report-section { break-inside: avoid; }
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

const REPORT_INTENT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'in',
  'near',
  'of',
  'on',
  'or',
  'the',
  'to',
])

function reportIntentModifiers(report: ProjectReportDto): Set<string> {
  const location = report.meta.location
  if (!location) return new Set()
  return new Set(
    [location.label, location.city, location.region, location.country]
      .flatMap(tokenizeReportIntent)
      .map(normalizeReportIntentToken)
      .filter(Boolean),
  )
}

function dedupeReportActions(
  report: ProjectReportDto,
  actions: readonly ReportActionPlanItem[],
): ReportActionPlanItem[] {
  const modifiers = reportIntentModifiers(report)
  if (actions.length <= 1 || modifiers.size === 0) return [...actions]

  const seen = new Set<string>()
  const result: ReportActionPlanItem[] = []
  for (const action of actions) {
    if (action.category !== 'content') {
      result.push(action)
      continue
    }
    const key = reportIntentKey(extractActionQuery(action), modifiers)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(action)
  }
  return result
}

function dedupeReportOpportunities(
  report: ProjectReportDto,
): ProjectReportDto['contentOpportunities'] {
  const modifiers = reportIntentModifiers(report)
  const opportunities = report.contentOpportunities
  if (opportunities.length <= 1 || modifiers.size === 0) return opportunities

  const seen = new Set<string>()
  return opportunities.filter((opportunity) => {
    const key = reportIntentKey(opportunity.query, modifiers)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractActionQuery(action: ReportActionPlanItem): string {
  return action.title.match(/"([^"]+)"/)?.[1]
    ?? action.successMetric.match(/"([^"]+)"/)?.[1]
    ?? action.title
}

function reportIntentKey(value: string, modifiers: ReadonlySet<string>): string {
  const tokens = tokenizeReportIntent(value)
    .map(normalizeReportIntentToken)
    .filter(Boolean)
    .filter(token => !REPORT_INTENT_STOPWORDS.has(token))
    .filter(token => !modifiers.has(token))
  return [...new Set(tokens)].sort().join(' ')
}

function tokenizeReportIntent(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function normalizeReportIntentToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
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
      ? `${otherLocations.length} configured ${pluralize(otherLocations.length, 'market')} still ${otherLocations.length === 1 ? 'needs' : 'need'} a matching sweep before cross-market recommendations.`
      : 'Single-market report; findings can be read as the current market view.'
    : 'No geographic hint was attached to this sweep; read findings as default-market or national results.'

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
        <div class="scope-label">Current sweep</div>
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
    : 'Run a visibility sweep to populate the first citation and mention baseline.'
  const priorityActions = report.agencyDiagnostics.priorities.length > 0
    ? report.agencyDiagnostics.priorities
    : report.actionPlan
  const actionCount = dedupeReportActions(report, priorityActions).length
  const heroHtml = `<div class="executive-hero">
    <div class="headline-card">
      <div>
        <div class="hero-kicker">Latest AI visibility sweep</div>
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
    return renderEmpty('Run a visibility sweep to populate the citation matrix.')
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
    { id: 'citation-scorecard', eyebrow: 'Section 2', title: 'Citation Scorecard', intro: 'Provider-by-provider citation and mention coverage for the latest sweep.' },
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
      { id: 'competitor-landscape', eyebrow: 'Section 3', title: 'Competitor Landscape' },
      renderEmpty('No competitor data yet. Add competitors and run a visibility sweep.'),
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
          <ul>${c.theirCitedPages.map(p => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a> <span class="cited-for">${escapeHtml(p.citedFor.join(', '))}</span></li>`).join('')}</ul>
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
        <thead><tr><th>Domain</th><th>Pressure</th><th>Citations</th><th class="numeric">Mentions</th><th class="numeric">SOV</th><th>Cited queries</th></tr></thead>
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
      eyebrow: 'Section 3',
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
      { id: 'ai-source-origin', eyebrow: 'Section 4', title: 'AI Citation Sources' },
      renderEmpty('No source data yet. Run a visibility sweep first.'),
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
      eyebrow: 'Section 4',
      title: 'AI Citation Sources',
      intro: 'External domains AI engines trusted most in the latest sweep.',
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
      { id: 'gsc', eyebrow: 'Section 5', title: 'GSC Performance' },
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
    { id: 'gsc', eyebrow: 'Section 5', title: 'GSC Performance', intro: `Search demand signals to compare against AI visibility${dateRange ? ` for ${dateRange}` : ''}.` },
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
      { id: 'ga', eyebrow: 'Section 6', title: 'GA4 Traffic' },
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
    { id: 'ga', eyebrow: 'Section 6', title: 'GA4 Traffic', intro: `Site traffic from ${formatDate(ga.periodStart)} to ${formatDate(ga.periodEnd)}.` },
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
      { id: 'social-referrals', eyebrow: 'Section 7', title: 'Social Referrals' },
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
    { id: 'social-referrals', eyebrow: 'Section 7', title: 'Social Referrals', intro: 'Social traffic split by channel and campaign.' },
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
      { id: 'ai-referrals', eyebrow: 'Section 8', title: 'AI Referral Traffic' },
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
    { id: 'ai-referrals', eyebrow: 'Section 8', title: 'AI Referral Traffic', intro: 'Traffic arriving from AI answer engines.' },
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

function renderIndexingHealth(report: ProjectReportDto): string {
  const ih = report.indexingHealth
  if (!ih) {
    return section(
      { id: 'indexing-health', eyebrow: 'Section 9', title: 'Indexing Health' },
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
    { id: 'indexing-health', eyebrow: 'Section 9', title: 'Indexing Health', intro: `Pages absent from ${ih.provider === 'google' ? 'Google' : 'Bing'} are harder for AI engines to retrieve.` },
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
      { id: 'citations-trend', eyebrow: 'Section 10', title: 'Citations Over Time' },
      renderEmpty('Run multiple visibility sweeps to see a trend.'),
    )
  }

  if (isTrendBaseline(trend)) {
    return section(
      { id: 'citations-trend', eyebrow: 'Section 10', title: 'Citations Over Time' },
      renderEmpty(`Establishing baseline (${trend.length} of ${MIN_TREND_POINTS} runs collected). Trend will appear once more sweeps are recorded.`),
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
    { id: 'citations-trend', eyebrow: 'Section 10', title: 'Citations Over Time', intro: 'Citation coverage across completed visibility sweeps.' },
    `${chart}
    <div class="chart-card"><h3>Run-by-run breakdown</h3>
      <table class="report-table">
        <thead><tr><th>Run</th><th class="numeric">Cited queries</th><th>Per-provider rates</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`,
  )
}

function renderInsights(report: ProjectReportDto): string {
  const list = report.insights
  if (list.length === 0) {
    return section(
      { id: 'insights', eyebrow: 'Section 11', title: 'Insights & Alerts' },
      renderEmpty('No insights yet — run a visibility sweep to generate alerts.'),
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
    { id: 'insights', eyebrow: 'Section 11', title: 'Insights & Alerts', intro: 'Regressions, gains, and recurring alerts ordered by severity.' },
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
      ? `<a href="${escapeHtml(absolutizeProjectUrl(o.ourBestPage.url, canonical))}">${escapeHtml(o.ourBestPage.url)}</a>`
      : '<span class="cell-not-cited">No page yet</span>'
    const winning = o.winningCompetitor
      ? `<a href="${escapeHtml(o.winningCompetitor.url)}">${escapeHtml(o.winningCompetitor.domain)}</a>`
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
      eyebrow: 'Section 12',
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
      eyebrow: 'Section 13',
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
      { id: 'recommended-next-steps', eyebrow: 'Section 14', title: 'Recommended Next Steps', intro: 'Action items bucketed by timing.' },
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
    { id: 'recommended-next-steps', eyebrow: 'Section 14', title: 'Recommended Next Steps', intro: 'Action items bucketed by timing.' },
    `<div class="steps">${items}</div>`,
  )
}

function actionAudienceMatches(action: ReportActionPlanItem, audience: ReportAudience): boolean {
  return action.audience === 'both' || action.audience === audience
}

function renderActionCards(actions: readonly ReportActionPlanItem[]): string {
  if (actions.length === 0) return renderEmpty('No prioritized actions yet.')
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
            <summary>Evidence details</summary>
            ${why ? `<div><strong>Why</strong>${why}</div>` : ''}
            ${evidence ? `<div><strong>Evidence</strong>${evidence}</div>` : ''}
          </details>`
        : ''
      return `<article class="action-card">
        <div class="action-head">
          <div class="action-rank" title="Impact rank — 1 is the highest-leverage action">${idx + 1}</div>
          <div>
            <div class="action-meta">
              <span class="badge tone-${tone}">${escapeHtml(reportHorizonLabel(action.horizon))}</span>
              <span class="badge tone-neutral">${escapeHtml(reportActionCategoryLabel(action.category))}</span>
              <span class="badge tone-neutral">${escapeHtml(reportConfidenceLabel(action.confidence))} confidence</span>
            </div>
            <h3>${escapeHtml(action.title)}</h3>
          </div>
        </div>
        <p>${escapeHtml(action.action)}</p>
        ${proof}
        ${details}
        <div class="success-metric"><strong>Win condition:</strong> ${escapeHtml(action.successMetric)}</div>
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
      eyebrow: audience === 'client' ? 'Client actions' : 'Agency actions',
      title: audience === 'client' ? 'What We Recommend Next' : 'Agency Action Plan',
      intro: audience === 'client'
        ? 'The short list to approve and execute.'
        : 'The highest-leverage work, sorted by urgency and evidence strength.',
    },
    renderActionCards(actions),
  )
}

function renderClientSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const metrics = `<div class="metric-grid">
    <div class="metric"><div class="label">Citation coverage</div><div class="value">${s.citationRate}%</div><div class="delta">${s.citedQueryCount}/${s.totalQueryCount} tracked queries cited</div></div>
    <div class="metric"><div class="label">Mention coverage</div><div class="value">${s.mentionRate}%</div><div class="delta">${s.mentionedQueryCount}/${s.totalQueryCount} tracked queries mentioned</div></div>
    <div class="metric"><div class="label">Providers checked</div><div class="value">${formatNumber(s.providerCount)}</div><div class="delta">${formatNumber(s.queryCount)} tracked queries</div></div>
  </div>`
  const notes = report.clientSummary.confidenceNotes.length > 0
    ? `<div class="client-notes">${report.clientSummary.confidenceNotes.map(note => `<div class="client-note">${escapeHtml(note)}</div>`).join('')}</div>`
    : ''
  return section(
    {
      id: 'client-summary',
      eyebrow: 'Client summary',
      title: "How You're Appearing",
      intro: report.clientSummary.overview,
    },
    `<div class="chart-card">
      <h3>${escapeHtml(report.clientSummary.headline)}</h3>
      <p class="source-origin-headline">${escapeHtml(report.clientSummary.overview)}</p>
    </div>
    ${metrics}
    ${notes}`,
  )
}

function renderClientEvidenceSummary(report: ProjectReportDto): string {
  const evidenceCards: string[] = []
  if (report.aiSourceOrigin.topDomains.length > 0) {
    evidenceCards.push(`<div class="diagnostic-card tone-neutral">
      <h3>Sources AI engines trust</h3>
      <p>These domains appeared most often as cited sources outside your owned domain.</p>
      <ul>${report.aiSourceOrigin.topDomains.slice(0, 5).map(d => `<li>${escapeHtml(d.domain)}: ${formatNumber(d.count)} citation${d.count === 1 ? '' : 's'}</li>`).join('')}</ul>
    </div>`)
  }
  if (report.gsc) {
    evidenceCards.push(`<div class="diagnostic-card tone-neutral">
      <h3>Search demand</h3>
      <p>Search Console shows ${formatNumber(report.gsc.totalImpressions)} impressions and ${formatNumber(report.gsc.totalClicks)} clicks in the report window.</p>
      <ul>${report.gsc.topQueries.slice(0, 5).map(q => `<li>${escapeHtml(q.query)}: ${formatNumber(q.impressions)} impressions</li>`).join('')}</ul>
    </div>`)
  }
  if (report.indexingHealth) {
    const tone = report.indexingHealth.indexedPct >= 90 ? 'positive' : report.indexingHealth.indexedPct >= 70 ? 'caution' : 'negative'
    evidenceCards.push(`<div class="diagnostic-card tone-${tone}">
      <h3>Indexing readiness</h3>
      <p>${report.indexingHealth.indexedPct}% of inspected URLs are indexed.</p>
      <ul><li>${formatNumber(report.indexingHealth.indexed)} indexed</li><li>${formatNumber(report.indexingHealth.notIndexed)} not indexed</li></ul>
    </div>`)
  }
  const opportunities = dedupeReportOpportunities(report)
  if (opportunities.length > 0) {
    evidenceCards.push(`<div class="diagnostic-card tone-caution">
      <h3>Content opportunities</h3>
      <p>Canonry found topics where better content could improve AI citations.</p>
      <ul>${opportunities.slice(0, 5).map(o => `<li>${escapeHtml(o.query)}: ${escapeHtml(o.action)} (${Math.round(o.score)})</li>`).join('')}</ul>
    </div>`)
  }
  return section(
    {
      id: 'client-evidence-summary',
      eyebrow: 'Evidence',
      title: 'Why This Is The Plan',
      intro: 'A concise evidence view for the client summary. The agency report keeps the full matrices and detailed tables.',
    },
    evidenceCards.length > 0 ? `<div class="diagnostics-grid">${evidenceCards.join('')}</div>` : renderEmpty('No supporting evidence sections are populated yet.'),
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
        renderAudienceActionPlan(report, 'client'),
        renderClientEvidenceSummary(report),
      ].join('\n')
    : [
        renderExecutiveSummary(report),
        renderAudienceActionPlan(report, 'agency'),
        renderAgencyDiagnostics(report),
        renderCitationScorecard(report),
        renderCompetitorLandscape(report),
        renderAiSourceOrigin(report),
        renderGsc(report),
        renderGa(report),
        renderSocial(report),
        renderAiReferrals(report),
        renderIndexingHealth(report),
        renderCitationsTrend(report),
        renderInsights(report),
        renderOpportunities(report),
        renderContentGaps(report),
        renderRecommendedNextSteps(report),
      ].join('\n')

  const json = escapeJsonForScript(JSON.stringify(report))

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="container">
  <header class="header">
    <div class="eyebrow">${audience === 'client' ? 'AEO Client Summary' : 'AEO Agency Report'}</div>
    <h1>${escapeHtml(report.meta.project.displayName)}</h1>
    <div class="subtitle">${escapeHtml(report.meta.project.canonicalDomain)} · ${escapeHtml(report.meta.project.country)} / ${escapeHtml(report.meta.project.language.toUpperCase())}${renderHeaderLocationFragment(report.meta.location)} · Generated ${formatDate(report.meta.generatedAt)}</div>
  </header>
  ${sections}
  <footer class="footer">Generated by canonry · ${escapeHtml(report.meta.generatedAt)}</footer>
</div>
<script type="application/json" id="canonry-report-data">${json}</script>
</body>
</html>`
}
