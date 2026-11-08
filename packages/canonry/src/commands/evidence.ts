import { CitationStates, citationStateToCited, isCitationStateMeasured, type CitationState } from '@canonry/canonry-contracts'
import { createApiClient, type TimelineDto } from '../client.js'
import { emitJsonl } from '../cli-output.js'

type EvidenceJsonEntry = TimelineDto & {
  /** The latest run's citation: null when no answer carried sources (not measured). */
  cited: boolean | null
}

/** The latest run's citation for one query; false with no runs at all. */
function latestCited(entry: TimelineDto): boolean | null {
  const latest = entry.runs[entry.runs.length - 1]
  return latest ? citationStateToCited(latest.citationState) : false
}

const STATE_LABEL: Record<CitationState, string> = {
  [CitationStates.cited]: '✓ cited',
  [CitationStates['not-cited']]: '✗ not-cited',
  [CitationStates['not-measured']]: '· not measured (no sources)',
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
      cited: latestCited(entry),
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
      cited: latestCited(entry),
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
    const transition = latest.transition !== latest.citationState ? ` (${latest.transition})` : ''
    console.log(`  ${STATE_LABEL[latest.citationState]}${transition}  ${entry.query}`)
  }

  // The cited base is the queries whose latest answers carried sources.
  const latestStates = timeline.flatMap(e => e.runs.length > 0 ? [e.runs[e.runs.length - 1]!.citationState] : [])
  const measured = latestStates.filter(isCitationStateMeasured).length
  const cited = latestStates.filter(state => state === CitationStates.cited).length
  console.log(`\n  Queries: ${timeline.length}`)
  console.log(`  Cited:    ${cited} / ${measured}`)
  if (measured < latestStates.length) {
    console.log(`  Not measured: ${latestStates.length - measured} (no answer carried sources)`)
  }
}
