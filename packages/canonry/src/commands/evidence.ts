import { createApiClient, type TimelineDto } from '../client.js'

type EvidenceJsonEntry = TimelineDto & {
  cited: boolean
}

function getClient() {
  return createApiClient()
}

export async function showEvidence(project: string, format?: string): Promise<void> {
  const client = getClient()
  const timeline = await client.getTimeline(project)

  if (format === 'json') {
    const enriched: EvidenceJsonEntry[] = timeline.map((entry) => ({
      ...entry,
      cited: entry.runs[entry.runs.length - 1]?.citationState === 'cited',
    }))
    console.log(JSON.stringify(enriched, null, 2))
    return
  }

  if (timeline.length === 0) {
    console.log('No keyword evidence yet. Trigger a run first with "canonry run".')
    return
  }

  console.log(`Evidence: ${project}\n`)

  for (const entry of timeline) {
    const latest = entry.runs[entry.runs.length - 1]
    if (!latest) continue
    const state = latest.citationState === 'cited' ? '✓ cited' : '✗ not-cited'
    const transition = latest.transition !== latest.citationState ? ` (${latest.transition})` : ''
    console.log(`  ${state}${transition}  ${entry.keyword}`)
  }

  console.log(`\n  Keywords: ${timeline.length}`)
  const cited = timeline.filter(e => e.runs[e.runs.length - 1]?.citationState === 'cited').length
  console.log(`  Cited:    ${cited} / ${timeline.length}`)
}
