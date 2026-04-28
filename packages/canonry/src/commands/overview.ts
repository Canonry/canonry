import { createApiClient } from '../client.js'

export async function showOverview(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  const overview = await client.getProjectOverview(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(overview, null, 2))
    return
  }

  const { project: meta, latestRun, health, topInsights, keywordCounts, providers, transitions } = overview
  console.log(`Overview: ${meta.displayName ?? meta.name} (${meta.name})\n`)
  console.log(`  Domain:   ${meta.canonicalDomain}`)
  console.log(`  Country:  ${meta.country}`)
  console.log(`  Language: ${meta.language}`)

  if (latestRun.run) {
    const finished = latestRun.run.finishedAt ?? '—'
    console.log(`\n  Latest run: ${latestRun.run.id} (${latestRun.run.status}, ${finished})`)
    console.log(`  Total runs: ${latestRun.totalRuns}`)
  } else {
    console.log('\n  No runs yet.')
  }

  console.log(`\n  Keywords cited: ${keywordCounts.citedKeywords}/${keywordCounts.totalKeywords} (${pct(keywordCounts.citedRate)})`)
  if (providers.length > 0) {
    console.log('  Providers:')
    for (const p of providers) {
      console.log(`    ${p.provider.padEnd(10)} ${p.cited}/${p.total} (${pct(p.citedRate)})`)
    }
  }

  if (transitions.since) {
    console.log(`\n  vs run at ${transitions.since}: +${transitions.gained} gained, -${transitions.lost} lost, ${transitions.emerging} emerging`)
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
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
