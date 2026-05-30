import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'

export async function showHealth(
  project: string,
  opts: { history?: boolean; limit?: number; format?: string },
): Promise<void> {
  const client = createApiClient()

  if (opts.history) {
    const snapshots = await client.getHealthHistory(project, opts.limit)

    if (opts.format === 'json') {
      console.log(JSON.stringify(snapshots, null, 2))
      return
    } else if (opts.format === 'jsonl') {
      // Stream one self-contained snapshot per line. Prepend `project` (which
      // the snapshot itself doesn't name) so a line lifted out of the history
      // envelope still says which project it describes.
      emitJsonl(snapshots.map(snap => ({ project, ...snap })))
      return
    }

    if (snapshots.length === 0) {
      console.log('No health history available.')
      return
    }

    console.log('Date                      Cited Rate   Cited/Total')
    console.log('─'.repeat(55))
    for (const snap of snapshots) {
      const rate = (snap.overallCitedRate * 100).toFixed(1).padStart(5) + '%'
      const ratio = `${snap.citedPairs}/${snap.totalPairs}`
      const date = snap.createdAt.slice(0, 19).padEnd(25)
      console.log(`${date} ${rate}        ${ratio}`)
    }
    return
  }

  const health = await client.getHealth(project)

  // The default path returns a single health object, not a list. jsonl maps
  // onto json here (one machine object, same bytes) rather than falling
  // through to human text.
  if (opts.format === 'json' || opts.format === 'jsonl') {
    console.log(JSON.stringify(health, null, 2))
    return
  }

  if (health.status === 'no-data') {
    console.log('No health data yet — run a sweep first (canonry run <project>).')
    return
  }

  const rate = (health.overallCitedRate * 100).toFixed(1)
  console.log(`Health: ${rate}% cited (${health.citedPairs}/${health.totalPairs} pairs)`)
  console.log('')

  if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
    console.log('Provider Breakdown:')
    for (const [provider, stats] of Object.entries(health.providerBreakdown)) {
      const pRate = (stats.citedRate * 100).toFixed(1)
      console.log(`  ${provider.padEnd(15)} ${pRate}% (${stats.cited}/${stats.total})`)
    }
  }
}
