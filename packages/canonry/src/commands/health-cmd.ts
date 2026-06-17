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
      const mRate = (snap.overallMentionRate * 100).toFixed(1).padStart(5) + '%'
      const mRatio = `${snap.mentionedPairs}/${snap.totalPairs}`.padEnd(15)
      const cRate = (snap.overallCitedRate * 100).toFixed(1).padStart(5) + '%'
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
  const mentionRate = (health.overallMentionRate * 100).toFixed(1)
  const citedRate = (health.overallCitedRate * 100).toFixed(1)
  console.log(`Health: ${mentionRate}% mentioned (${health.mentionedPairs}/${health.totalPairs} pairs)`)
  console.log(`        ${citedRate}% cited (${health.citedPairs}/${health.totalPairs} pairs)`)
  console.log('')

  if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
    console.log('Provider Breakdown:')
    for (const [provider, stats] of Object.entries(health.providerBreakdown)) {
      const pMention = (stats.mentionRate * 100).toFixed(1)
      const pCited = (stats.citedRate * 100).toFixed(1)
      console.log(`  ${provider.padEnd(15)} ${pMention}% mentioned (${stats.mentioned}/${stats.total})   ${pCited}% cited (${stats.cited}/${stats.total})`)
    }
  }
}
