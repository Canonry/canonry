import {
  formatPercent,
  portfolioWhatChangedItems,
  RatioUnits,
  WHAT_CHANGED_ALL_CLEAR_DETAIL,
  type MentionShareDto,
  type OverviewWhatChangedQueryDto,
  type OverviewWhatChangedSignalDto,
  type ProjectOverviewDto,
  type ProjectOverviewWhatChangedDto,
  type ScoreSummaryDto,
  type VisibilityReportRate,
} from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { runAdmissionLines } from './run.js'

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
  const cols = { project: 20, mention: 30, branded: 30, cited: 22, share: 42, queries: 22 }
  console.log(`  ${cell('Project', cols.project)}${cell('Mention · non-brand', cols.mention)}${cell('Mention · branded', cols.branded)}${cell('Cited · all queries', cols.cited)}${cell('Mention share · scope', cols.share)}${cell('Queries cited · all', cols.queries)}Latest run`)
  for (const ov of overviews) {
    const project = ov.project.displayName || ov.project.name
    const queries = `${ov.queryCounts.citedQueries}/${ov.queryCounts.totalQueries}`
    const latest = ov.latestRun.run?.finishedAt ?? ov.latestRun.run?.createdAt ?? '—'
    console.log(
      `  ${cell(project, cols.project)}`
      + `${cell(mentionCoverageText(ov.mentionCoverage?.populations.find(population => population.queryClass === 'non-brand')?.mentionCoverage), cols.mention)}`
      + `${cell(mentionCoverageText(ov.mentionCoverage?.populations.find(population => population.queryClass === 'branded')?.mentionCoverage), cols.branded)}`
      + `${cell(ov.scores.visibility.value, cols.cited)}`
      + `${cell(`${ov.scores.mentionShare.value} · ${ov.scores.mentionShare.scope} queries`, cols.share)}`
      + `${cell(queries, cols.queries)}`
      + `${latest}`,
    )
  }

  // The dashboard's "What changed": every project's rows, or one status row.
  // A server too old to report it has nothing to list.
  if (overviews.some(ov => ov.whatChanged !== undefined)) {
    console.log('\nWhat changed:')
    const entries = overviews.map(ov => ({ project: ov.project, whatChanged: ov.whatChanged ?? null }))
    for (const item of portfolioWhatChangedItems(entries)) {
      console.log(`  ${item.title}: ${item.detail}`)
    }
  }
  console.log()
}

const COMPARISON_UNAVAILABLE_TEXT: Record<Extract<ProjectOverviewWhatChangedDto['comparison'], { state: 'unavailable' }>['reason'], string> = {
  'not-measured': 'not measured yet.',
  'no-previous-check': 'nothing earlier to compare the latest check with.',
  'definition-changed': 'not compared: the previous sweep measured another plan definition.',
  'model-changed': 'not compared: the previous sweep asked other engines or models.',
  'partial-run': 'not compared: the latest or previous sweep is partial.',
  'legacy-plan': 'not compared: a schema v1 plan freezes no Property definition. Republish setup.',
  'unreadable': 'not compared: the previous sweep could not be read.',
}

/** One lost query: its class, then where it was lost (engines, locations, and for Advanced the Properties and markets). */
function lostQueryLine(row: OverviewWhatChangedQueryDto): string {
  const where = [row.providers.join(', ')]
  const locations = row.locations.filter((location): location is string => location !== null)
  if (locations.length > 0) where.push(`at ${locations.join(', ')}`)
  if (row.properties.length > 0) where.push(`Properties: ${row.properties.map(property => property.label).join(', ')}`)
  if (row.markets.length > 0) where.push(`markets: ${row.markets.map(market => market.label).join(', ')}`)
  const queryClass = row.queryClass === null ? '' : ` (${row.queryClass})`
  return `      - ${row.query}${queryClass} — ${where.join(' · ')}`
}

function printLostQueries(label: string, signal: OverviewWhatChangedSignalDto): void {
  if (signal.queryCount === 0) return
  console.log(`    ${label}:`)
  for (const row of signal.queries) console.log(lostQueryLine(row))
  if (signal.truncated) console.log(`      … ${signal.queryCount - signal.queries.length} more not listed`)
}

/** The project's "What changed" rows as the dashboard lists them, then the queries behind each count. */
function printWhatChanged(whatChanged: ProjectOverviewWhatChangedDto): void {
  const { comparison, items } = whatChanged
  const status = comparison.state === 'unavailable'
    ? COMPARISON_UNAVAILABLE_TEXT[comparison.reason]
    : items.length === 0 ? WHAT_CHANGED_ALL_CLEAR_DETAIL : null
  console.log(status === null ? '\n  What changed:' : `\n  What changed: ${status}`)
  for (const item of items) console.log(`    ${item.title}: ${item.detail}`)
  printLostQueries('Lost mentions', whatChanged.lostMentions)
  printLostQueries('Lost citations', whatChanged.lostCitations)
}

/** Pad-or-truncate a cell to fit its column without bleeding. Leaves at
 *  least one trailing space when truncated so columns stay visually
 *  separated even on long cells (matches what humans expect from a
 *  fixed-width table). */
function cell(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, width - 1)} `
  return value.padEnd(width)
}

function mentionCoverageText(value: VisibilityReportRate | undefined): string {
  if (value?.rate === undefined || value.rate === null) return 'Not measured'
  return `${formatPercent(value.rate, RatioUnits.fraction)} (${value.numerator}/${value.denominator} answers)`
}

function renderHuman(overview: ProjectOverviewDto): void {
  const {
    project: meta,
    latestRun,
    health,
    topInsights,
    queryCounts,
    providers,
    transitions,
    scores,
    citationMovement,
    mentionMovement,
    movementComparison,
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
  const admission = runAdmissionLines(meta.name, latestRun.admission, latestRun.manualAdmission)
  if (admission.length > 0) console.log(`\n${admission.map(line => `  ${line}`).join('\n')}`)
  if (overview.whatChanged) printWhatChanged(overview.whatChanged)

  console.log('\nScores:')
  const coverage = overview.mentionCoverage
  const nonBrand = coverage?.populations.find(population => population.queryClass === 'non-brand')
  console.log(`  Mention · non-brand queries: ${mentionCoverageText(nonBrand?.mentionCoverage)}`)
  for (const population of coverage?.populations ?? []) {
    if (population.queryClass === 'non-brand' || population.queryCount === 0) continue
    console.log(`  Mention · ${population.queryClass === 'unknown' ? 'unclassified' : population.queryClass} queries: ${mentionCoverageText(population.mentionCoverage)}`)
  }
  if (coverage?.selection.measurement.state === 'partial') console.log('    Incomplete sweep; missing answers are not negative results.')
  printScore('Cited · all queries', scores.visibility)
  printScore('Mention share    ', scores.mentionShare)
  printMentionShareBreakdown(scores.mentionShare)
  printScore('Mention gaps     ', scores.mentionGaps)
  printScore('Gap queries      ', scores.gapQueries)
  printScore('Index coverage   ', scores.indexCoverage)
  printScore('Competitor press.', scores.competitorPressure)
  printScore('Run status       ', scores.runStatus)

  // Sentiment is a branded figure, as on the dashboard: non-brand answers name the
  // brand almost only to recommend it. JSON keeps branded, nonBrand and overall.
  const brandedSentiment = overview.sentiment?.branded
  if (overview.sentiment?.configured && brandedSentiment && brandedSentiment.coverage.judged > 0 && brandedSentiment.score.favorableRate !== null) {
    console.log(`\n  Sentiment: ${brandedSentiment.score.favorableDisplay} favorable · branded queries`)
    console.log(`    ${brandedSentiment.coverage.counts.favorable} favorable / ${brandedSentiment.coverage.judged} judged${brandedSentiment.provisional ? ' · provisional' : ''}`)
  }

  console.log(`\n  Queries cited:     ${queryCounts.citedQueries}/${queryCounts.totalQueries} (${formatPercent(queryCounts.citedRate)})`)
  console.log(`  Queries mentioned: ${queryCounts.mentionedQueries}/${queryCounts.totalQueries} (${formatPercent(queryCounts.mentionRate)})`)

  if (movementComparison.hasPreviousRun) {
    const comparisonLabel = movementComparison.querySetChanged
      ? `changed (+${movementComparison.addedQueryCount} added, -${movementComparison.removedQueryCount} removed); movement compares ${movementComparison.comparableQueryCount} shared`
      : `unchanged; ${movementComparison.comparableQueryCount} comparable`
    console.log(`  Query basket:       ${comparisonLabel}`)
    console.log(`  Citation movement: +${citationMovement.gained} gained, -${citationMovement.lost} lost (${citationMovement.tone})`)
    console.log(`  Mention movement:  +${mentionMovement.gained} gained, -${mentionMovement.lost} lost (${mentionMovement.tone})`)
  } else {
    console.log('  Movement: first sweep; no comparison yet')
  }

  if (providers.length > 0) {
    console.log('\n  Providers:')
    for (const p of providers) {
      console.log(`    ${p.provider.padEnd(12)} ${p.cited}/${p.total} (${formatPercent(p.citedRate)})`)
    }
  }

  if (providerScores.length > 0) {
    console.log('\n  Models:')
    for (const m of providerScores) {
      const label = `${m.provider}/${m.model ?? 'unknown'}`.padEnd(28)
      console.log(`    ${label} ${m.cited}/${m.total} (${formatPercent(m.score, 'percent')})`)
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
    console.log(`\n  Health: ${formatPercent(health.overallCitedRate)} cited (${health.citedPairs}/${health.totalPairs} pairs)`)
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
      console.log(`    ${point.createdAt.slice(0, 10)} ${formatPercent(point.citationRate, 'percent').padStart(6)} ${bar}`)
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

/** The Mention Share head-to-head — the same server `ranking` the dashboard
 *  table renders beneath the figure, each share as the server computed it.
 *  The project's row always prints; the top 3 competitors keep the CLI output
 *  tight, and the full ranking is in the `--format json` payload. */
function printMentionShareBreakdown(mentionShare: MentionShareDto): void {
  // A newer CLI can be pointed at an older server that predates `ranking`.
  const legacyCompatible = mentionShare.breakdown as { ranking?: MentionShareDto['breakdown']['ranking'] }
  const ranking = legacyCompatible.ranking ?? []
  const project = ranking.find(row => row.kind === 'project')
  if (!project) return
  const competitors = ranking.filter(row => row.kind === 'competitor')
  console.log(`      you${' '.repeat(28)} ${project.mentionSnapshots} mentions (${formatPercent(project.share)} of combined)`)
  for (const row of competitors.slice(0, 3)) {
    console.log(`      ${(row.domain ?? '').padEnd(30)} ${row.mentionSnapshots} mentions (${formatPercent(row.share)} of combined)`)
  }
  if (competitors.length > 3) {
    console.log(`      + ${competitors.length - 3} more competitor${competitors.length - 3 === 1 ? '' : 's'} (--format json for full breakdown)`)
  }
}
