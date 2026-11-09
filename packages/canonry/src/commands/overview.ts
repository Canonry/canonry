import {
  describeError,
  formatPercent,
  portfolioWhatChangedItems,
  RatioUnits,
  WHAT_CHANGED_ALL_CLEAR_DETAIL,
  type MentionShareDto,
  type OverviewWhatChangedQueryDto,
  type OverviewWhatChangedSignalDto,
  type ProjectDto,
  type ProjectOverviewDto,
  type ProjectOverviewWhatChangedDto,
  type ScoreSummaryDto,
  type VisibilityReportRate,
} from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, EXIT_SYSTEM_ERROR, EXIT_USER_ERROR, isMachineFormat } from '../cli-error.js'
import { citedBase } from '../snapshot-cell.js'
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
 * `--all --format json` puts this in a project's place when its overview
 * couldn't be read, so every project keeps its place in the array.
 */
export interface UnreadProjectOverview {
  project: ProjectDto
  error: { code: string; message: string }
}

interface ReadFailure {
  code: string
  message: string
  /** A network, server or internal failure, which a retry may clear. */
  system: boolean
}

type PortfolioRead =
  | { project: ProjectDto; overview: ProjectOverviewDto }
  | { project: ProjectDto; failure: ReadFailure }

function readFailure(err: unknown): ReadFailure {
  return err instanceof CliError
    ? { code: err.code, message: err.message, system: err.exitCode === EXIT_SYSTEM_ERROR }
    : { code: 'CLI_ERROR', message: describeError(err), system: true }
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
 *
 * One project's failed read never hides the others. As on the dashboard, the
 * project is named as couldn't be loaded (an `UnreadProjectOverview` in its
 * place in JSON), never counted as clear. Once everything is printed the
 * command fails with `OVERVIEW_INCOMPLETE`, so exit 0 still means every
 * element is a full overview.
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

  const settled = await Promise.allSettled(
    projects.map(p =>
      client.getProjectOverview(p.name, { location: opts.location, since: opts.since }),
    ),
  )
  const reads = projects.map((project, index): PortfolioRead => {
    const outcome = settled[index]!
    return outcome.status === 'fulfilled'
      ? { project, overview: outcome.value }
      : { project, failure: readFailure(outcome.reason) }
  })

  if (isMachineFormat(opts.format)) {
    const entries = reads.map((read): ProjectOverviewDto | UnreadProjectOverview => 'overview' in read
      ? read.overview
      : { project: read.project, error: { code: read.failure.code, message: read.failure.message } })
    console.log(JSON.stringify(entries, null, 2))
  } else {
    renderPortfolio(reads)
  }
  throwIfAnyUnread(reads)
}

function renderPortfolio(reads: readonly PortfolioRead[]): void {
  // Compact table: one row per project. Picks the headline numbers
  // operators usually want to scan at portfolio level. Each cell is
  // truncated to its column width so multi-word score values like
  // "Add competitors" or "No data" don't bleed into adjacent columns.
  console.log(`\nOverviews (${reads.length} project${reads.length === 1 ? '' : 's'}):\n`)
  const cols = { project: 20, mention: 30, branded: 30, cited: 22, share: 42, queries: 22 }
  console.log(`  ${cell('Project', cols.project)}${cell('Mention · non-brand', cols.mention)}${cell('Mention · branded', cols.branded)}${cell('Cited · all queries', cols.cited)}${cell('Mention share · scope', cols.share)}${cell('Queries cited · all', cols.queries)}Latest run`)
  for (const read of reads) {
    const project = read.project.displayName || read.project.name
    if (!('overview' in read)) {
      console.log(`  ${cell(project, cols.project)}Couldn't be loaded: ${read.failure.message}`)
      continue
    }
    const ov = read.overview
    // Cited out of the queries some answer's sources were checked for.
    const queries = `${ov.queryCounts.citedQueries}/${citedBase(ov.queryCounts.totalQueries, ov.queryCounts.citationNotMeasuredQueries)}`
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

  // The dashboard's "What changed": every project's rows, then one naming the
  // projects that couldn't be loaded, or one status row. A server too old to
  // report it has nothing to list.
  const overviews = reads.flatMap(read => 'overview' in read ? [read.overview] : [])
  if (overviews.length === 0 || overviews.some(ov => ov.whatChanged !== undefined)) {
    console.log('\nWhat changed:')
    const entries = reads.map(read => ({
      project: read.project,
      whatChanged: 'overview' in read ? read.overview.whatChanged ?? null : null,
    }))
    for (const item of portfolioWhatChangedItems(entries)) {
      console.log(`  ${item.title}: ${item.detail}`)
    }
  }
  console.log()
}

/** Exit 1, or 2 when a retry may help, once the readable overviews are printed. */
function throwIfAnyUnread(reads: readonly PortfolioRead[]): void {
  const unread = reads.flatMap(read => 'failure' in read ? [read] : [])
  if (unread.length === 0) return
  const names = unread.map(read => read.project.name)
  throw new CliError({
    code: 'OVERVIEW_INCOMPLETE',
    message: `${unread.length} of ${reads.length} project overviews couldn't be loaded: ${names.join(', ')}`,
    details: { projects: names },
    exitCode: unread.some(read => read.failure.system) ? EXIT_SYSTEM_ERROR : EXIT_USER_ERROR,
  })
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

  // Cited is out of the queries with an answer whose sources were checked;
  // an engine that returns no sources is not measured, never a miss.
  const notMeasuredQueries = queryCounts.citationNotMeasuredQueries
  const notMeasuredNote = notMeasuredQueries > 0 ? `, ${notMeasuredQueries} not measured (no sources)` : ''
  console.log(queryCounts.citedRate === null
    ? `\n  Queries cited:     not measured (${notMeasuredQueries} queries, no answer carries sources)`
    : `\n  Queries cited:     ${queryCounts.citedQueries}/${citedBase(queryCounts.totalQueries, notMeasuredQueries)} (${formatPercent(queryCounts.citedRate)})${notMeasuredNote}`)
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
      console.log(p.citedRate === null
        ? `    ${p.provider.padEnd(12)} not measured (${p.total} answers without sources)`
        : `    ${p.provider.padEnd(12)} ${p.cited}/${citedBase(p.total, p.citationNotMeasured)} (${formatPercent(p.citedRate)})`)
    }
  }

  if (providerScores.length > 0) {
    console.log('\n  Models:')
    for (const m of providerScores) {
      const label = `${m.provider}/${m.model ?? 'unknown'}`.padEnd(28)
      console.log(m.score === null
        ? `    ${label} not measured (${m.total} answers without sources)`
        : `    ${label} ${m.cited}/${citedBase(m.total, m.citationNotMeasured)} (${formatPercent(m.score, 'percent')})`)
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
    console.log(health.overallCitedRate === null
      ? '\n  Health: citations not measured (no answer carries sources)'
      : `\n  Health: ${formatPercent(health.overallCitedRate)} cited (${health.citedPairs}/${citedBase(health.totalPairs, health.citationNotMeasuredPairs)} pairs)`)
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
      if (point.citationRate === null) {
        console.log(`    ${point.createdAt.slice(0, 10)} citations not measured (no answer carries sources)`)
        continue
      }
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
