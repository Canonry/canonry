import { formatPercent } from '@ainyc/canonry-contracts'
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

    // Mention leads, cited second — both signals are independent and shown
    // side by side (never one in place of the other).
    console.log('Date                      Mention Rate  Mentioned/Total   Cited Rate   Cited/Total')
    console.log('─'.repeat(86))
    for (const snap of snapshots) {
      const mRate = formatPercent(snap.overallMentionRate).padStart(6)
      const mRatio = `${snap.mentionedPairs}/${snap.totalPairs}`.padEnd(15)
      const cRate = formatPercent(snap.overallCitedRate).padStart(6)
      const cRatio = `${snap.citedPairs}/${snap.totalPairs}`
      const date = snap.createdAt.slice(0, 19).padEnd(25)
      console.log(`${date} ${mRate}        ${mRatio}   ${cRate}        ${cRatio}`)
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

  // Mention leads, cited second — two independent signals, both surfaced.
  console.log(`Health: ${formatPercent(health.overallMentionRate)} mentioned (${health.mentionedPairs}/${health.totalPairs} pairs)`)
  console.log(`        ${formatPercent(health.overallCitedRate)} cited (${health.citedPairs}/${health.totalPairs} pairs)`)
  console.log('')

  if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
    console.log('Provider Breakdown:')
    for (const [provider, stats] of Object.entries(health.providerBreakdown)) {
      console.log(`  ${provider.padEnd(15)} ${formatPercent(stats.mentionRate)} mentioned (${stats.mentioned}/${stats.total})   ${formatPercent(stats.citedRate)} cited (${stats.cited}/${stats.total})`)
    }
  }
}
