import {
  formatRatio,
  type VisibilityStatsDto,
  type VisibilityStatsCounts,
  type VisibilityCompareDto,
  type VisibilityCompareMetric,
  type VisibilityCompareMetricPeriod,
} from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

export interface VisibilityStatsOptions {
  since?: string
  until?: string
  month?: string
  lastRuns?: number
  byProvider?: boolean
  shareOfVoice?: boolean
  format?: string
}

/** `canonry visibility-stats <project>` — per-query mention/citation rates with sample size. Collection → supports jsonl. */
export async function showVisibilityStats(project: string, opts: VisibilityStatsOptions): Promise<void> {
  const client = createApiClient()
  const data = await client.getVisibilityStats(project, {
    since: opts.since,
    until: opts.until,
    month: opts.month,
    lastRuns: opts.lastRuns,
    groupBy: opts.byProvider ? 'provider' : undefined,
    shareOfVoice: opts.shareOfVoice,
  })

  if (opts.format === 'jsonl') {
    // Primary collection = per-query rows. Stamp the project + window context
    // each row loses by leaving the envelope.
    emitJsonl(data.queries.map((q) => ({ project: data.project, runCount: data.window.runCount, ...q })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  printVisibilityStats(data)
}

function pct(rate: number | null): string {
  return rate === null ? '—' : formatRatio(rate)
}

// ── visibility-compare (month over month) ────────────────────────────────────

export interface VisibilityCompareOptions {
  from?: string
  to?: string
  format?: string
}

/** `canonry visibility-compare <project> --from <YYYY-MM> --to <YYYY-MM>` — object command; jsonl degrades to json. */
export async function showVisibilityCompare(project: string, opts: VisibilityCompareOptions): Promise<void> {
  if (!opts.from || !opts.to) throw new Error('visibility-compare requires --from <YYYY-MM> and --to <YYYY-MM>')
  const client = createApiClient()
  const data = await client.getVisibilityCompare(project, opts.from, opts.to)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  printVisibilityCompare(data)
}

/** A metric period as `"2.1% [1.3, 3.5]"`, or `"no data"` when the sample was empty. */
function periodCell(p: VisibilityCompareMetricPeriod): string {
  if (p.point === null || p.ciLow === null || p.ciHigh === null) return 'no data'
  const p1 = (v: number) => formatRatio(v)
  return `${p1(p.point)} [${p1(p.ciLow)}, ${p1(p.ciHigh)}]`
}

function verdictCell(m: VisibilityCompareMetric): string {
  switch (m.verdict) {
    case 'within-noise':
      return 'within noise'
    case 'insufficient-data':
      return 'no data'
    case 'moved':
      return `moved ${m.direction === 'down' ? 'down' : m.direction === 'up' ? 'up' : ''}`.trim()
  }
}

function printVisibilityCompare(data: VisibilityCompareDto): void {
  console.log(`AEO month over month: ${data.project}   ${data.from.month} -> ${data.to.month}`)
  const b = data.basket
  const excl: string[] = []
  if (b.excludedFromOnly > 0) excl.push(`${b.excludedFromOnly} only in ${data.from.month}`)
  if (b.excludedToOnly > 0) excl.push(`${b.excludedToOnly} only in ${data.to.month}`)
  if (b.excludedProviders.length > 0) excl.push(`engines dropped: ${b.excludedProviders.join(', ')}`)
  console.log(`Basket: ${b.queryCount} quer${b.queryCount === 1 ? 'y' : 'ies'}, ${b.providers.length} engine(s)${excl.length ? ` (excluded: ${excl.join('; ')})` : ''}`)
  const sweeps = `Sweeps: ${data.from.month} ${data.from.runCount}, ${data.to.month} ${data.to.runCount}`
  const low = data.from.lowRunCount || data.to.lowRunCount
  console.log(low ? `${sweeps}  (below the 5-sweep floor — intervals are wide, a "moved" verdict is unlikely to be reachable)` : sweeps)
  console.log('')

  // Column widths.
  const rows = data.metrics.map((m) => ({
    label: `${m.label}${m.driftRobust ? ' *' : ''}`,
    to: periodCell(m.to),
    from: periodCell(m.from),
    verdict: verdictCell(m),
  }))
  rows.push({
    label: 'Queries named (count)',
    to: `${data.queriesMentioned.to.count} of ${data.queriesMentioned.to.of}`,
    from: `${data.queriesMentioned.from.count} of ${data.queriesMentioned.from.of}`,
    verdict: '',
  })
  const w = (sel: (r: (typeof rows)[number]) => string, head: string) =>
    Math.max(head.length, ...rows.map((r) => sel(r).length))
  const lw = w((r) => r.label, 'Metric')
  const tw = w((r) => r.to, data.to.month)
  const fw = w((r) => r.from, data.from.month)
  console.log(`  ${'Metric'.padEnd(lw)}  ${data.to.month.padEnd(tw)}  ${data.from.month.padEnd(fw)}  Verdict`)
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(lw)}  ${r.to.padEnd(tw)}  ${r.from.padEnd(fw)}  ${r.verdict}`)
  }
  console.log('')
  console.log('  * share of voice is drift-robust (cancels model changes); it carries the directional call.')
  if (data.modelChanges.length > 0) {
    for (const mc of data.modelChanges) {
      console.log(`  Model changed: ${mc.provider} (${mc.fromModels.join('/') || '?'} -> ${mc.toModels.join('/') || '?'}) — absolute rate moves are not attributable to the site.`)
    }
  }
}

/** Cited = cited/total; Mentioned = mentioned/checked (checked excludes "not checked"). */
function citedCell(c: VisibilityStatsCounts): string {
  return `${c.cited}/${c.total}`
}
function mentionedCell(c: VisibilityStatsCounts): string {
  return `${c.mentioned}/${c.checked}`
}

function printVisibilityStats(data: VisibilityStatsDto): void {
  const w = data.window
  const windowParts: string[] = [`${w.runCount} run(s)`]
  if (w.lastRuns !== null) windowParts.push(`last ${w.lastRuns}`)
  if (w.since !== null) windowParts.push(`since ${w.since}`)
  if (w.until !== null) windowParts.push(`until ${w.until}`)

  console.log('Visibility stats (cited = source list, mentioned = answer text)')
  console.log(`Window: ${windowParts.join(' · ')}`)
  console.log('Cited = cited/total snapshots · Mentioned = mentioned/checked (checked excludes "not checked")')
  console.log('')

  if (data.queries.length === 0) {
    console.log('No answer-visibility snapshots in this window — run a sweep first (canonry run <project>).')
    return
  }

  const rows = data.queries.map((q) => ({
    label: q.query,
    cited: citedCell(q),
    citedPct: pct(q.citedRate),
    ment: mentionedCell(q),
    mentPct: pct(q.mentionRate),
  }))

  const queryWidth = Math.max(7, ...rows.map((r) => r.label.length))
  const citedWidth = Math.max(7, ...rows.map((r) => r.cited.length))
  const mentWidth = Math.max(9, ...rows.map((r) => r.ment.length))

  const header = [
    'Query'.padEnd(queryWidth),
    'Cited'.padEnd(citedWidth),
    'Cited%'.padStart(7),
    'Mentioned'.padEnd(mentWidth),
    'Ment%'.padStart(7),
  ].join('  ')
  console.log(header)
  console.log('─'.repeat(header.length))
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(queryWidth),
        r.cited.padEnd(citedWidth),
        r.citedPct.padStart(7),
        r.ment.padEnd(mentWidth),
        r.mentPct.padStart(7),
      ].join('  '),
    )
  }
  console.log('─'.repeat(header.length))
  console.log(
    [
      'TOTAL'.padEnd(queryWidth),
      citedCell(data.totals).padEnd(citedWidth),
      pct(data.totals.citedRate).padStart(7),
      mentionedCell(data.totals).padEnd(mentWidth),
      pct(data.totals.mentionRate).padStart(7),
    ].join('  '),
  )

  if (data.groupBy === 'provider' && data.byProvider && data.byProvider.length > 0) {
    console.log('')
    console.log('By provider (pooled across queries):')
    const provWidth = Math.max(8, ...data.byProvider.map((p) => p.provider.length))
    for (const p of data.byProvider) {
      console.log(
        [
          `  ${p.provider}`.padEnd(provWidth + 2),
          citedCell(p).padEnd(citedWidth),
          pct(p.citedRate).padStart(7),
          mentionedCell(p).padEnd(mentWidth),
          pct(p.mentionRate).padStart(7),
        ].join('  '),
      )
    }
  }

  const sov = data.shareOfVoice
  if (sov) {
    console.log('')
    const pctStr = sov.percent === null ? '— (no competitors configured)' : `${sov.percent}%`
    console.log(
      `Share of voice: ${pctStr}  (you ${sov.projectMentions} vs competitors ${sov.competitorMentions} brand mentions across ${sov.snapshotsWithAnswerText} answers)`,
    )
    for (const c of sov.perCompetitor.slice(0, 8)) {
      console.log(`  ${c.domain}: ${c.mentions}`)
    }
  }
}
