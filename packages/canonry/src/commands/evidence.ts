import { CitationStates } from '@ainyc/canonry-contracts'
import { createApiClient, type TimelineDto } from '../client.js'
import { emitJsonl } from '../cli-output.js'

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
      cited: entry.runs[entry.runs.length - 1]?.citationState === CitationStates.cited,
    }))
    console.log(JSON.stringify(enriched, null, 2))
    return
  } else if (format === 'jsonl') {
    // One self-contained record per tracked query. Each line carries `project`
    // so a line lifted out of context still says which project it describes;
    // the record (enriched TimelineDto + derived `cited`) is spread last so its
    // own fields win.
    emitJsonl(timeline.map((entry) => ({
      project,
      ...entry,
      cited: entry.runs[entry.runs.length - 1]?.citationState === CitationStates.cited,
    })))
    return
  }

  if (timeline.length === 0) {
    console.log('No query evidence yet. Trigger a run first with "canonry run".')
    return
  }

  console.log(`Evidence: ${project}\n`)

  for (const entry of timeline) {
    const latest = entry.runs[entry.runs.length - 1]
    if (!latest) continue
    const state = latest.citationState === CitationStates.cited ? '✓ cited' : '✗ not-cited'
    const transition = latest.transition !== latest.citationState ? ` (${latest.transition})` : ''
    console.log(`  ${state}${transition}  ${entry.query}`)
  }

  console.log(`\n  Queries: ${timeline.length}`)
  const cited = timeline.filter(e => e.runs[e.runs.length - 1]?.citationState === CitationStates.cited).length
  console.log(`  Cited:    ${cited} / ${timeline.length}`)
}
