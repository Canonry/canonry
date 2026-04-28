import { createApiClient } from '../client.js'

export async function searchProject(
  project: string,
  opts: { query: string; limit?: number; format?: string },
): Promise<void> {
  const client = createApiClient()
  const result = await client.searchProject(project, { q: opts.query, limit: opts.limit })

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Search: "${result.query}" — ${result.totalHits} hit${result.totalHits === 1 ? '' : 's'}${result.truncated ? ' (truncated)' : ''}\n`)
  if (result.hits.length === 0) {
    console.log('  No matches.')
    return
  }
  for (const hit of result.hits) {
    if (hit.kind === 'snapshot') {
      console.log(`  [snapshot] ${hit.keyword} (${hit.provider}, ${hit.citationState}) — ${hit.matchedField}`)
      console.log(`    ${hit.snippet}`)
      console.log(`    run=${hit.runId}  at ${hit.createdAt}`)
    } else {
      const dismissed = hit.dismissed ? ' [dismissed]' : ''
      console.log(`  [insight ${hit.severity.toUpperCase()}] ${hit.type} — ${hit.title}${dismissed}`)
      console.log(`    ${hit.snippet}`)
      console.log(`    keyword=${hit.keyword}  at ${hit.createdAt}`)
    }
    console.log('')
  }
}
