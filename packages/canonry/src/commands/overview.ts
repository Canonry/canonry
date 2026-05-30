import type { MentionShareDto, ProjectOverviewDto, ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

export interface ShowOverviewOpts {
  format?: string
  location?: string
  since?: string
}

export async function showOverview(project: string, opts: ShowOverviewOpts): Promise<void> {
  const client = createApiClient()
  const overview = await client.getProjectOverview(project, {
    location: opts.location,
    since: opts.since,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(overview, null, 2))
    return
  }

  renderHuman(overview)
}

/**
 * `canonry overview --all` — one call to render or emit every project's
 * overview. Fans out to the existing per-project endpoint in parallel so
 * an agent doing portfolio-level work doesn't have to chain N invocations
 * (the dominant CLI ergonomic complaint per the agent-experience review).
 *
 * Human output is a compact one-line-per-project table — the full
 * per-project rendering belongs in `canonry overview <project>` where
 * the operator has zoomed in on purpose. JSON output is an array of
 * `ProjectOverviewDto` in stable project-list order so downstream tooling
 * can rely on it.
 */
export async function showAllOverviews(opts: ShowOverviewOpts): Promise<void> {
  const client = createApiClient()
  const projects = await client.listProjects()
  if (projects.length === 0) {
    if (isMachineFormat(opts.format)) {
      console.log('[]')
      return
    }
    console.log('No projects configured. Add one with `canonry project create`.')
    return
  }

  const overviews = await Promise.all(
    projects.map(p =>
      client.getProjectOverview(p.name, { location: opts.location, since: opts.since }),
    ),
  )

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(overviews, null, 2))
    return
  }

  // Compact table: one row per project. Picks the headline numbers
  // operators usually want to scan at portfolio level. Each cell is
  // truncated to its column width so multi-word score values like
  // "Add competitors" or "No data" don't bleed into adjacent columns.
  console.log(`\nOverviews (${overviews.length} project${overviews.length === 1 ? '' : 's'}):\n`)
  const cols = { project: 20, mention: 10, cited: 10, share: 18, queries: 10 }
  console.log(`  ${cell('Project', cols.project)}${cell('Mention', cols.mention)}${cell('Cited', cols.cited)}${cell('Share', cols.share)}${cell('Queries', cols.queries)}Latest run`)
  for (const ov of overviews) {
    const project = ov.project.displayName || ov.project.name
    const queries = `${ov.queryCounts.citedQueries}/${ov.queryCounts.totalQueries}`
    const latest = ov.latestRun.run?.finishedAt ?? ov.latestRun.run?.createdAt ?? '—'
    console.log(
      `  ${cell(project, cols.project)}`
      + `${cell(ov.scores.mention.value, cols.mention)}`
      + `${cell(ov.scores.visibility.value, cols.cited)}`
      + `${cell(ov.scores.mentionShare.value, cols.share)}`
      + `${cell(queries, cols.queries)}`
      + `${latest}`,
    )
  }
  console.log()
}

/** Pad-or-truncate a cell to fit its column without bleeding. Leaves at
 *  least one trailing space when truncated so columns stay visually
 *  separated even on long cells (matches what humans expect from a
 *  fixed-width table). */
function cell(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, width - 1)} `
  return value.padEnd(width)
}

/** Exported so unit tests can capture stdout shape without spinning up the
 *  real client. Format change is contract-y enough that agents parsing it
 *  via grep need protection. */
export function renderHuman(overview: ProjectOverviewDto): void {
  const {
    project: meta,
    latestRun,
    health,
    topInsights,
    queryCounts,
    providers,
    transitions,
    scores,
    movementSummary,
    competitors,
    providerScores,
    attentionItems,
    runHistory,
    suggestedQueries,
    dateRangeLabel,
    contextLabel,
  } = overview

  console.log(`Overview: ${meta.displayName ?? meta.name} (${meta.name})`)
  console.log(`  Domain:   ${meta.canonicalDomain}`)
  console.log(`  Context:  ${contextLabel} · ${dateRangeLabel}`)

  if (latestRun.run) {
    const finished = latestRun.run.finishedAt ?? '—'
    console.log(`\n  Latest run: ${latestRun.run.id} (${latestRun.run.status}, ${finished})`)
    console.log(`  Total runs: ${latestRun.totalRuns}`)
  } else {
    console.log('\n  No runs yet.')
  }

  console.log('\nScores:')
  // Order matches the dashboard hero (Mention → Cited → Mention share)
  // so an operator alt-tabbing between SPA and CLI sees the same lineup.
  printScore('Mention          ', scores.mention)
  printScore('Visibility       ', scores.visibility)
  printScore('Mention share    ', scores.mentionShare)
  printMentionShareBreakdown(scores.mentionShare)
  printScore('Mention gaps     ', scores.mentionGaps)
  printScore('Gap queries      ', scores.gapQueries)
  printScore('Index coverage   ', scores.indexCoverage)
  printScore('Competitor press.', scores.competitorPressure)
  printScore('Run status       ', scores.runStatus)

  console.log(`\n  Queries cited: ${queryCounts.citedQueries}/${queryCounts.totalQueries} (${pct(queryCounts.citedRate)})`)

  if (movementSummary.hasPreviousRun) {
    console.log(`  Movement: +${movementSummary.gained} gained, -${movementSummary.lost} lost (${movementSummary.tone})`)
  } else if (movementSummary.gained > 0) {
    console.log(`  Movement: ${movementSummary.gained} cited in first run`)
  }

  if (providers.length > 0) {
    console.log('\n  Providers:')
    for (const p of providers) {
      console.log(`    ${p.provider.padEnd(12)} ${p.cited}/${p.total} (${pct(p.citedRate)})`)
    }
  }

  if (providerScores.length > 0) {
    console.log('\n  Models:')
    for (const m of providerScores) {
      const label = `${m.provider}/${m.model ?? 'unknown'}`.padEnd(28)
      console.log(`    ${label} ${m.cited}/${m.total} (${m.score}%)`)
    }
  }

  if (transitions.since) {
    console.log(`\n  Transitions since ${transitions.since}: +${transitions.gained} gained, -${transitions.lost} lost, ${transitions.emerging} emerging`)
  }

  if (competitors.length > 0) {
    console.log('\n  Competitors:')
    for (const c of competitors) {
      console.log(`    ${c.domain.padEnd(28)} ${c.citationCount}/${c.totalQueries} ${c.pressureLabel}`)
    }
  }

  if (attentionItems.length > 0) {
    console.log('\n  Attention:')
    for (const item of attentionItems) {
      console.log(`    [${item.actionLabel}] ${item.title}`)
      if (item.detail) console.log(`        ${item.detail}`)
    }
  }

  if (health) {
    console.log(`\n  Health: ${pct(health.overallCitedRate)} cited (${health.citedPairs}/${health.totalPairs} pairs)`)
  }

  if (topInsights.length > 0) {
    console.log('\n  Top insights:')
    for (const insight of topInsights) {
      console.log(`    [${insight.severity.toUpperCase()}] ${insight.type} — ${insight.title}`)
    }
  }

  if (runHistory.length > 0) {
    console.log(`\n  Run history (last ${runHistory.length}):`)
    for (const point of runHistory) {
      const bar = '█'.repeat(Math.round(point.citationRate / 10))
      console.log(`    ${point.createdAt.slice(0, 10)} ${String(point.citationRate).padStart(3)}% ${bar}`)
    }
  }

  if (suggestedQueries.rows.length > 0) {
    const moreLabel = suggestedQueries.totalCandidates > suggestedQueries.rows.length
      ? ` (showing ${suggestedQueries.rows.length} of ${suggestedQueries.totalCandidates})`
      : ''
    console.log(`\n  Suggested queries to track${moreLabel}:`)
    for (const s of suggestedQueries.rows) {
      console.log(`    + ${s.query}`)
      console.log(`        ${s.reason}`)
    }
    console.log(`    (add via: canonry query add ${meta.name} "<query>")`)
  }
}

function printScore(prefix: string, score: ScoreSummaryDto): void {
  const tone = `[${score.tone}]`.padEnd(11)
  const value = score.value.padEnd(8)
  console.log(`  ${prefix} ${tone} ${value} ${score.delta}`)
}

/** Per-competitor split of Mention Share — the same data the dashboard
 *  hero renders inline beneath the gauge. Top 3 competitors keeps the CLI
 *  output tight; the full breakdown is in the `--format json` payload. */
function printMentionShareBreakdown(mentionShare: MentionShareDto): void {
  const { breakdown } = mentionShare
  if (breakdown.perCompetitor.length === 0) return
  const total = breakdown.projectMentionSnapshots + breakdown.competitorMentionSnapshots
  if (total === 0) return
  const youPct = ((breakdown.projectMentionSnapshots / total) * 100).toFixed(1)
  console.log(`      you${' '.repeat(28)} ${breakdown.projectMentionSnapshots} mentions (${youPct}% of combined)`)
  for (const row of breakdown.perCompetitor.slice(0, 3)) {
    const pct = ((row.mentionSnapshots / total) * 100).toFixed(1)
    console.log(`      ${row.domain.padEnd(30)} ${row.mentionSnapshots} mentions (${pct}% of combined)`)
  }
  if (breakdown.perCompetitor.length > 3) {
    console.log(`      + ${breakdown.perCompetitor.length - 3} more competitor${breakdown.perCompetitor.length - 3 === 1 ? '' : 's'} (--format json for full breakdown)`)
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
