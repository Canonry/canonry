import type {
  AiSourceCategoryBucket,
  CitationsTrendPoint,
  CompetitorRow,
  GscQueryRow,
  ProjectReportDto,
  ReportInsight,
} from '@ainyc/canonry-contracts'

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

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
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
  letter-spacing: -0.02em;
}
.header .subtitle {
  color: ${COLORS.textMuted};
  font-size: 14px;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
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
  letter-spacing: -0.01em;
}
section.report-section .section-intro {
  color: ${COLORS.textMuted};
  margin-bottom: 24px;
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
  letter-spacing: 0.08em;
  font-size: 10px;
  color: ${COLORS.textFaint};
  font-weight: 600;
  margin-bottom: 8px;
}
.metric .value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
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
table.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
table.report-table th, table.report-table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid ${COLORS.border};
}
table.report-table th {
  font-weight: 600;
  color: ${COLORS.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
}
table.report-table td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
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
  letter-spacing: 0.08em;
  color: ${COLORS.textFaint};
  font-weight: 600;
}
.step .title { font-weight: 600; }
.step .rationale { color: ${COLORS.textMuted}; font-size: 13px; }
.footer {
  margin-top: 96px;
  padding-top: 24px;
  border-top: 1px solid ${COLORS.border};
  text-align: center;
  color: ${COLORS.textFaint};
  font-size: 12px;
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

function renderExecutiveSummary(report: ProjectReportDto): string {
  const s = report.executiveSummary
  const trendLabel = s.trend === 'up' ? '↑ Up' : s.trend === 'down' ? '↓ Down' : s.trend === 'flat' ? '→ Flat' : '—'
  const trendTone = s.trend === 'up' ? 'positive' : s.trend === 'down' ? 'negative' : 'neutral'

  const metrics = [
    {
      label: 'Citation rate',
      value: `${s.citationRate}%`,
      delta: `<span class="tone-${trendTone}">${trendLabel}</span> · ${s.providerCount} provider${s.providerCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Keywords tracked',
      value: formatNumber(s.keywordCount),
      delta: `${s.competitorCount} competitor${s.competitorCount === 1 ? '' : 's'} tracked`,
    },
  ]
  if (s.gsc) {
    metrics.push({
      label: 'GSC clicks',
      value: formatNumber(s.gsc.clicks),
      delta: `${formatNumber(s.gsc.impressions)} imp · ${formatRatio(s.gsc.ctr)} CTR`,
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

  return section(
    { id: 'executive-summary', eyebrow: 'Section 1', title: 'Executive Summary' },
    metricsHtml + findingsHtml,
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
  if (scorecard.keywords.length === 0 || scorecard.providers.length === 0) {
    return renderEmpty('Run a visibility sweep to populate the citation matrix.')
  }
  const headers = scorecard.providers.map(p => `<th>${escapeHtml(p)}</th>`).join('')
  const rows = scorecard.keywords.map((kw, ki) => {
    const cells = scorecard.providers.map((_, pi) => {
      const cell = scorecard.matrix[ki]?.[pi]
      if (!cell) {
        return '<td><span class="cell-pending">—</span></td>'
      }
      if (cell.citationState === 'cited') {
        return '<td><span class="cell-cited">Cited</span></td>'
      }
      return '<td><span class="cell-not-cited">Not cited</span></td>'
    }).join('')
    return `<tr><td>${escapeHtml(kw)}</td>${cells}</tr>`
  }).join('')

  return `<table class="report-table">
    <thead><tr><th>Keyword</th>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function renderCitationScorecard(report: ProjectReportDto): string {
  const body = `
    ${renderProviderBars(report.citationScorecard.providerRates)}
    ${renderCitationMatrix(report.citationScorecard)}
  `
  return section(
    { id: 'citation-scorecard', eyebrow: 'Section 2', title: 'Citation Scorecard', intro: 'Per-keyword × per-provider citation matrix from the latest visibility sweep.' },
    body,
  )
}

function renderCompetitorBars(landscape: ProjectReportDto['competitorLandscape'], canonical: string): string {
  const data = [
    { label: canonical, count: landscape.projectCitationCount, isProject: true },
    ...landscape.competitors.map(c => ({ label: c.domain, count: c.citationCount, isProject: false })),
  ]
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
    <h3>Citations per domain</h3>
    <svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Citations per domain bar chart">
      ${bars}
    </svg>
  </div>`
}

function renderCompetitorLandscape(report: ProjectReportDto): string {
  const competitors = report.competitorLandscape.competitors
  if (competitors.length === 0 && report.competitorLandscape.projectCitationCount === 0) {
    return section(
      { id: 'competitor-landscape', eyebrow: 'Section 3', title: 'Competitor Landscape' },
      renderEmpty('No competitor data yet. Add competitors and run a visibility sweep.'),
    )
  }

  const rows = competitors.map(c => {
    const tone = pressureTone(c.pressureLabel)
    return `<tr>
      <td>${escapeHtml(c.domain)}</td>
      <td><span class="badge tone-${tone}">${escapeHtml(c.pressureLabel)}</span></td>
      <td class="numeric">${c.citationCount} / ${c.totalCount}</td>
      <td>${escapeHtml(c.citedKeywords.slice(0, 5).join(', '))}${c.citedKeywords.length > 5 ? '…' : ''}</td>
    </tr>`
  }).join('')

  const table = competitors.length > 0
    ? `<table class="report-table">
        <thead><tr><th>Domain</th><th>Pressure</th><th>Citations</th><th>Cited keywords</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : renderEmpty('No competitors configured.')

  return section(
    { id: 'competitor-landscape', eyebrow: 'Section 3', title: 'Competitor Landscape', intro: 'Where tracked competitors appear in AI answers compared to your domain.' },
    `${renderCompetitorBars(report.competitorLandscape, report.meta.project.canonicalDomain)}${table}`,
  )
}

function renderDonut(buckets: AiSourceCategoryBucket[]): string {
  if (buckets.length === 0) return ''
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return ''
  const cx = 110
  const cy = 110
  const r = 80
  const innerR = 48

  let cumulative = 0
  const slices: string[] = []
  const legend: string[] = []
  buckets.forEach((b, i) => {
    const startAngle = (cumulative / total) * Math.PI * 2 - Math.PI / 2
    const endAngle = ((cumulative + b.count) / total) * Math.PI * 2 - Math.PI / 2
    cumulative += b.count
    const x1 = cx + Math.cos(startAngle) * r
    const y1 = cy + Math.sin(startAngle) * r
    const x2 = cx + Math.cos(endAngle) * r
    const y2 = cy + Math.sin(endAngle) * r
    const ix1 = cx + Math.cos(endAngle) * innerR
    const iy1 = cy + Math.sin(endAngle) * innerR
    const ix2 = cx + Math.cos(startAngle) * innerR
    const iy2 = cy + Math.sin(startAngle) * innerR
    const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0
    const color = COLORS.series[i % COLORS.series.length]
    if (b.count > 0) {
      slices.push(`<path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2} Z" fill="${color}" />`)
      legend.push(`<span><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(b.label)} (${b.count})</span>`)
    }
  })

  return `<div class="chart-card">
    <h3>AI source categories</h3>
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
      <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="AI source category donut chart">
        ${slices.join('')}
      </svg>
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:6px;">${legend.join('')}</div>
    </div>
  </div>`
}

function renderAiSourceOrigin(report: ProjectReportDto): string {
  const origin = report.aiSourceOrigin
  if (origin.categories.length === 0 && origin.topDomains.length === 0) {
    return section(
      { id: 'ai-source-origin', eyebrow: 'Section 4', title: 'AI Source Origin' },
      renderEmpty('No source data yet. Run a visibility sweep first.'),
    )
  }

  const rows = origin.topDomains.map(d => `
    <tr>
      <td>${escapeHtml(d.domain)}</td>
      <td class="numeric">${d.count}</td>
      <td>${d.isCompetitor ? '<span class="badge tone-negative">Competitor</span>' : '<span class="badge tone-neutral">External</span>'}</td>
    </tr>`).join('')

  const table = origin.topDomains.length > 0
    ? `<table class="report-table">
        <thead><tr><th>Domain</th><th>Citations</th><th>Tag</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : ''

  return section(
    { id: 'ai-source-origin', eyebrow: 'Section 4', title: 'AI Source Origin', intro: 'Where AI answers pull from, aggregated across the latest sweep.' },
    `${renderDonut(origin.categories)}${table}`,
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

  const breakdownRows = gsc.categoryBreakdown.map(c => `
    <tr>
      <td>${escapeHtml(c.category)}</td>
      <td class="numeric">${formatNumber(c.clicks)}</td>
      <td class="numeric">${formatNumber(c.impressions)}</td>
      <td class="numeric">${c.sharePct}%</td>
    </tr>`).join('')

  const trendChart = renderLineChart(
    gsc.trend.map(t => ({ x: t.date, y: t.clicks, label: t.date.slice(5) })),
    COLORS.accent,
    'Clicks over time',
  )

  return section(
    { id: 'gsc', eyebrow: 'Section 5', title: 'GSC Performance', intro: 'Top queries, category breakdown, and traffic trend from Google Search Console.' },
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
    <div class="chart-card"><h3>Category breakdown</h3>
      <table class="report-table">
        <thead><tr><th>Category</th><th class="numeric">Clicks</th><th class="numeric">Imp.</th><th class="numeric">Share</th></tr></thead>
        <tbody>${breakdownRows}</tbody>
      </table>
    </div>`,
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
      <td>${escapeHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
      <td class="numeric">${formatNumber(p.users)}</td>
      <td class="numeric">${formatNumber(p.organicSessions)}</td>
    </tr>`).join('')

  const channelRows = ga.channelBreakdown.map(c => `
    <tr>
      <td>${escapeHtml(c.channel)}</td>
      <td class="numeric">${formatNumber(c.sessions)}</td>
      <td class="numeric">${c.sharePct}%</td>
    </tr>`).join('')

  return section(
    { id: 'ga', eyebrow: 'Section 6', title: 'GA4 Traffic', intro: `Sessions and users for ${formatDate(ga.periodStart)} → ${formatDate(ga.periodEnd)}.` },
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
    <div class="chart-card"><h3>Channel breakdown</h3>
      <table class="report-table">
        <thead><tr><th>Channel</th><th class="numeric">Sessions</th><th class="numeric">Share</th></tr></thead>
        <tbody>${channelRows}</tbody>
      </table>
    </div>`,
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

  const channelRows = social.channels.map(c => `
    <tr>
      <td>${escapeHtml(c.channelGroup)}</td>
      <td class="numeric">${formatNumber(c.sessions)}</td>
      <td class="numeric">${c.sharePct}%</td>
    </tr>`).join('')

  const campaignRows = social.topCampaigns.map(c => `
    <tr>
      <td>${escapeHtml(c.source)}</td>
      <td>${escapeHtml(c.medium)}</td>
      <td class="numeric">${formatNumber(c.sessions)}</td>
    </tr>`).join('')

  return section(
    { id: 'social-referrals', eyebrow: 'Section 7', title: 'Social Referrals', intro: 'Paid vs organic split with top campaigns.' },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total sessions</div><div class="value">${formatNumber(social.totalSessions)}</div></div>
      <div class="metric"><div class="label">Organic social</div><div class="value">${formatNumber(social.organicSessions)}</div></div>
      <div class="metric"><div class="label">Paid social</div><div class="value">${formatNumber(social.paidSessions)}</div></div>
    </div>
    <div class="chart-card"><h3>Channel groups</h3>
      <table class="report-table">
        <thead><tr><th>Channel</th><th class="numeric">Sessions</th><th class="numeric">Share</th></tr></thead>
        <tbody>${channelRows}</tbody>
      </table>
    </div>
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

  const sourceRows = ai.bySource.map(s => `
    <tr>
      <td>${escapeHtml(s.source)}</td>
      <td class="numeric">${formatNumber(s.sessions)}</td>
      <td class="numeric">${formatNumber(s.users)}</td>
      <td class="numeric">${s.sharePct}%</td>
    </tr>`).join('')

  const pageRows = ai.topLandingPages.map(p => `
    <tr>
      <td>${escapeHtml(p.page)}</td>
      <td class="numeric">${formatNumber(p.sessions)}</td>
      <td class="numeric">${formatNumber(p.users)}</td>
    </tr>`).join('')

  const trendChart = renderLineChart(
    ai.trend.map(t => ({ x: t.date, y: t.sessions, label: t.date.slice(5) })),
    COLORS.series[2]!,
    'AI referral sessions over time',
  )

  return section(
    { id: 'ai-referrals', eyebrow: 'Section 8', title: 'AI Referral Traffic', intro: 'Sessions sent from AI answer engines.' },
    `<div class="metric-grid">
      <div class="metric"><div class="label">Total sessions</div><div class="value">${formatNumber(ai.totalSessions)}</div></div>
      <div class="metric"><div class="label">Total users</div><div class="value">${formatNumber(ai.totalUsers)}</div></div>
    </div>
    ${trendChart}
    <div class="chart-card"><h3>Sessions by source</h3>
      <table class="report-table">
        <thead><tr><th>Source</th><th class="numeric">Sessions</th><th class="numeric">Users</th><th class="numeric">Share</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>
    </div>
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
    { id: 'indexing-health', eyebrow: 'Section 9', title: 'Indexing Health', intro: `Source: ${ih.provider === 'google' ? 'Google Search Console' : 'Bing Webmaster Tools'}.` },
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

  const chart = renderLineChart(
    trend.map(t => ({ x: t.date, y: t.citationRate, label: formatDate(t.date) })),
    COLORS.positive,
    'Overall citation rate',
    220,
  )

  const rows = trend.map((t: CitationsTrendPoint) => `
    <tr>
      <td>${formatDate(t.date)}</td>
      <td class="numeric">${t.citationRate}%</td>
      <td>${t.providerRates.map(r => `${escapeHtml(r.provider)}: ${r.citationRate}%`).join(' · ')}</td>
    </tr>`).join('')

  return section(
    { id: 'citations-trend', eyebrow: 'Section 10', title: 'Citations Over Time', intro: 'Per-run citation rate across the project history.' },
    `${chart}
    <div class="chart-card"><h3>Run-by-run breakdown</h3>
      <table class="report-table">
        <thead><tr><th>Run</th><th class="numeric">Overall rate</th><th>Per-provider rates</th></tr></thead>
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

  const rows = list.map((i: ReportInsight) => {
    const tone = severityTone(i.severity)
    return `<tr>
      <td><span class="badge tone-${tone}">${escapeHtml(i.severity)}</span></td>
      <td>${escapeHtml(i.title)}</td>
      <td>${escapeHtml(i.keyword)}</td>
      <td>${escapeHtml(i.provider)}</td>
      <td>${i.recommendation ? escapeHtml(i.recommendation) : '<span class="cell-pending">—</span>'}</td>
    </tr>`
  }).join('')

  return section(
    { id: 'insights', eyebrow: 'Section 11', title: 'Insights & Alerts', intro: 'Priority-ordered findings from the most recent runs.' },
    `<table class="report-table">
      <thead><tr><th>Severity</th><th>Title</th><th>Keyword</th><th>Provider</th><th>Recommendation</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  )
}

function renderRecommendedNextSteps(report: ProjectReportDto): string {
  const steps = report.recommendedNextSteps
  if (steps.length === 0) {
    return section(
      { id: 'recommended-next-steps', eyebrow: 'Section 12', title: 'Recommended Next Steps' },
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
    { id: 'recommended-next-steps', eyebrow: 'Section 12', title: 'Recommended Next Steps' },
    `<div class="steps">${items}</div>`,
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
}

export function renderReportHtml(report: ProjectReportDto, opts: RenderReportHtmlOptions = {}): string {
  const title = opts.title ?? `Canonry report — ${report.meta.project.displayName}`
  const sections = [
    renderExecutiveSummary(report),
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
    <div class="eyebrow">AEO Report</div>
    <h1>${escapeHtml(report.meta.project.displayName)}</h1>
    <div class="subtitle">${escapeHtml(report.meta.project.canonicalDomain)} · ${escapeHtml(report.meta.project.country)} / ${escapeHtml(report.meta.project.language.toUpperCase())} · Generated ${formatDate(report.meta.generatedAt)}</div>
  </header>
  ${sections}
  <footer class="footer">Generated by canonry · ${escapeHtml(report.meta.generatedAt)}</footer>
</div>
<script type="application/json" id="canonry-report-data">${json}</script>
</body>
</html>`
}
