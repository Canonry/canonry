import type { ProjectOverviewDto, ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

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

  if (opts.format === 'json') {
    console.log(JSON.stringify(overview, null, 2))
    return
  }

  renderHuman(overview)
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
    movementSummary,
    competitors,
    providerScores,
    attentionItems,
    runHistory,
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
  printScore('Visibility       ', scores.visibility)
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
}

function printScore(prefix: string, score: ScoreSummaryDto): void {
  const tone = `[${score.tone}]`.padEnd(11)
  const value = score.value.padEnd(8)
  console.log(`  ${prefix} ${tone} ${value} ${score.delta}`)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
