import type { PortfolioDto, PortfolioProjectRowDto, PortfolioRunDto, MetricTone } from '@ainyc/canonry-contracts'
import { formatRelativeTime } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

export interface ShowPortfolioOpts {
  format?: string
}

/**
 * `canonry portfolio` — one call for the whole instance: what changed across
 * projects since each one's last comparable sweep, a timestamped recent-runs
 * log with both result signals, and a per-project state table. Mirrors the
 * dashboard Portfolio page (UI/CLI parity). `--format json` returns the
 * `PortfolioDto` verbatim; `--format jsonl` streams one change row per line.
 */
export async function showPortfolio(opts: ShowPortfolioOpts): Promise<void> {
  const client = createApiClient()
  const portfolio = await client.getPortfolio()

  if (isMachineFormat(opts.format)) {
    if (opts.format === 'jsonl') {
      // Primary collection: the change feed. Each row self-identifies (projectSlug).
      emitJsonl(portfolio.changeFeed)
      return
    }
    console.log(JSON.stringify(portfolio, null, 2))
    return
  }

  renderHuman(portfolio)
}

/** Exported so tests can assert the human output shape without a live client. */
export function renderHuman(p: PortfolioDto): void {
  const now = p.generatedAt
  const sweep = p.lastSweepAt ? formatRelativeTime(p.lastSweepAt, now) : 'never'
  console.log(`\nPortfolio · ${p.projectCount} project${p.projectCount === 1 ? '' : 's'} · last sweep ${sweep}\n`)

  const moreLabel = p.changeFeedTotal > p.changeFeed.length
    ? ` (showing ${p.changeFeed.length} of ${p.changeFeedTotal})`
    : ''
  console.log(`What changed${moreLabel}:`)
  if (p.changeFeed.length === 0) {
    const empty = p.feedEmptyState
    console.log(`  ${empty ? `${empty.title} — ${empty.detail}` : 'No changes.'}`)
  } else {
    for (const c of p.changeFeed) {
      console.log(`  ${changeGlyph(c.tone)} ${c.title}  (${formatRelativeTime(c.occurredAt, now)})`)
      if (c.detail) console.log(`        ${c.detail}`)
    }
  }

  console.log('\nRecent runs (M mentioned in answer · C cited in sources):')
  if (p.recentRuns.length === 0) {
    console.log('  Run history appears here after the first sweep.')
  } else {
    for (const r of p.recentRuns) {
      console.log(
        `  ${pad(r.projectName, 20)} ${pad(runResult(r), 20)} ${pad(runWhen(r, now), 20)} ${runDuration(r)}`,
      )
    }
  }

  console.log('\nProjects:')
  for (const proj of p.projects) {
    const mentioned = `M ${proj.mentionedOfTotal.mentioned}/${proj.mentionedOfTotal.total}`
    const cited = `C ${proj.citedOfTotal.cited}/${proj.citedOfTotal.total}`
    console.log(
      `  ${pad(proj.projectSlug, 20)} ${String(proj.mentionScore).padStart(3)}  ${pad(mentioned, 10)} ${pad(cited, 10)} ${projectDelta(proj)}`,
    )
  }
  console.log()
}

function changeGlyph(tone: MetricTone): string {
  switch (tone) {
    case 'negative': return 'v'
    case 'positive': return '^'
    case 'caution': return '!'
    case 'neutral': return '.'
  }
}

function runResult(r: PortfolioRunDto): string {
  if (r.status === 'failed') return r.errorSummary ?? 'failed'
  if (r.mentionedCount == null || r.citedCount == null || r.totalCount == null) return '—'
  return `M ${r.mentionedCount}/${r.totalCount} · C ${r.citedCount}/${r.totalCount}`
}

function runWhen(r: PortfolioRunDto, now: string): string {
  const ts = r.finishedAt ?? r.startedAt ?? r.createdAt
  const rel = formatRelativeTime(ts, now)
  if (r.status === 'running') return `started ${rel}`
  if (r.status === 'queued') return `queued ${rel}`
  return `finished ${rel}`
}

function runDuration(r: PortfolioRunDto): string {
  if (r.durationMs == null) {
    return r.status === 'running' ? 'running' : r.status === 'queued' ? 'waiting' : '—'
  }
  const seconds = Math.floor(r.durationMs / 1000)
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function projectDelta(proj: PortfolioProjectRowDto): string {
  if (!proj.hasEverRun) return 'never run'
  const parts: string[] = []
  if (proj.mentionDelta.gained > 0) parts.push(`+${proj.mentionDelta.gained}`)
  if (proj.mentionDelta.lost > 0) parts.push(`-${proj.mentionDelta.lost}`)
  if (parts.length === 0) return proj.mentionDelta.comparable ? 'no change' : 'first sweep'
  return `${parts.join(' ')} mentioned${proj.mentionDelta.comparable ? '' : '*'}`
}

/** Pad or truncate to a fixed width without bleeding into the next column. */
function pad(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, width - 1)} `
  return value.padEnd(width)
}
