import { formatRatio, type VisibilityStatsDto, type VisibilityStatsCounts } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'

export interface VisibilityStatsOptions {
  since?: string
  until?: string
  lastRuns?: number
  byProvider?: boolean
  format?: string
}

/** `canonry visibility-stats <project>` — per-query mention/citation rates with sample size. Collection → supports jsonl. */
export async function showVisibilityStats(project: string, opts: VisibilityStatsOptions): Promise<void> {
  const client = createApiClient()
  const data = await client.getVisibilityStats(project, {
    since: opts.since,
    until: opts.until,
    lastRuns: opts.lastRuns,
    groupBy: opts.byProvider ? 'provider' : undefined,
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
}
