import { formatPercent } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'

/**
 * A cited rate and its base. The base is the pairs whose sources were
 * checked; a null rate means none were (the engines return no sources), which
 * reads "not measured", never 0%.
 */
function citedText(rate: number | null, cited: number, measured: number): string {
  return rate === null ? 'not measured' : `${formatPercent(rate)} cited (${cited}/${measured})`
}

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
    // Cited is out of the pairs whose sources were checked: an engine that
    // returns no sources is not measured for citation, never a miss.
    console.log('Date                      Mention Rate  Mentioned/Total   Cited Rate   Cited/Checked')
    console.log('─'.repeat(88))
    for (const snap of snapshots) {
      const mRate = formatPercent(snap.overallMentionRate).padStart(6)
      const mRatio = `${snap.mentionedPairs}/${snap.totalPairs}`.padEnd(15)
      const cRate = snap.overallCitedRate === null ? 'not measured' : formatPercent(snap.overallCitedRate).padStart(6)
      const cRatio = `${snap.citedPairs}/${snap.totalPairs - snap.citationNotMeasuredPairs}`
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
  const notMeasured = health.citationNotMeasuredPairs
  console.log(`Health: ${formatPercent(health.overallMentionRate)} mentioned (${health.mentionedPairs}/${health.totalPairs} pairs)`)
  console.log(health.overallCitedRate === null
    ? `        citations not measured (no pair's engine returns sources, ${notMeasured} pairs)`
    : `        ${formatPercent(health.overallCitedRate)} cited (${health.citedPairs}/${health.totalPairs - notMeasured} pairs)${notMeasured > 0 ? `, ${notMeasured} not measured (no sources)` : ''}`)
  console.log('')

  if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
    console.log('Provider Breakdown:')
    for (const [provider, stats] of Object.entries(health.providerBreakdown)) {
      console.log(`  ${provider.padEnd(15)} ${formatPercent(stats.mentionRate)} mentioned (${stats.mentioned}/${stats.total})   ${citedText(stats.citedRate, stats.cited, stats.total - stats.citationNotMeasured)}`)
    }
  }
}
