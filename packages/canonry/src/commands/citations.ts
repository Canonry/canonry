import type { CitationVisibilityResponse } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { SNAPSHOT_CELL_LEGEND, citationGlyph, mentionGlyph } from '../snapshot-cell.js'

export async function showCitationVisibility(
  project: string,
  opts: { format?: string },
): Promise<void> {
  const client = createApiClient()
  const data = await client.getCitationVisibility(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (data.status === 'no-data') {
    if (data.reason === 'no-queries') {
      console.log('No queries configured. Add some with `canonry query add`.')
    } else {
      console.log('No citation data yet — run a sweep first (canonry run <project>).')
    }
    return
  }

  printSummary(data)
  console.log('')
  printCoverage(data)
  if (data.competitorGaps.length > 0) {
    console.log('')
    printGaps(data)
  }
}

function printSummary(data: CitationVisibilityResponse): void {
  const {
    providersCiting,
    providersMentioning,
    providersConfigured,
    providersCitationNotMeasured,
    totalQueries,
    queriesCitedAndMentioned,
    queriesCitedOnly,
    queriesMentionedOnly,
    queriesInvisible,
    queriesCitationNotMeasured,
  } = data.summary
  console.log('AEO visibility (citations + mentions)')
  if (data.summary.latestRunAt) {
    console.log(`Latest run:           ${data.summary.latestRunAt}`)
  }
  // An engine that returns no sources is out of the cited base, never a miss.
  const notMeasuredNote = providersCitationNotMeasured > 0
    ? ` (${providersCitationNotMeasured} not measured: no sources)`
    : ''
  console.log(`Cited in sources:     ${providersCiting}/${providersConfigured - providersCitationNotMeasured} engines${notMeasuredNote}`)
  console.log(`Mentioned in answers: ${providersMentioning}/${providersConfigured} engines`)
  console.log('')
  console.log(`Queries (${totalQueries} total):`)
  console.log(`  cited + mentioned:  ${queriesCitedAndMentioned}`)
  console.log(`  cited only:         ${queriesCitedOnly}`)
  console.log(`  mentioned only:     ${queriesMentionedOnly}`)
  console.log(`  invisible:          ${queriesInvisible}`)
  if (queriesCitationNotMeasured > 0) {
    console.log(`  citation not measured (no sources): ${queriesCitationNotMeasured}`)
  }
}

function printCoverage(data: CitationVisibilityResponse): void {
  if (data.byQuery.length === 0) {
    console.log('No query coverage rows.')
    return
  }
  // Build a stable provider column order from any row that has providers
  const providerSet = new Set<string>()
  for (const row of data.byQuery) {
    for (const p of row.providers) providerSet.add(p.provider)
  }
  const providerColumns = Array.from(providerSet).sort()

  if (providerColumns.length === 0) {
    console.log('Per-query coverage:')
    for (const row of data.byQuery) {
      console.log(`  ${row.query.padEnd(35)} no snapshots`)
    }
    return
  }

  // Each cell is two glyphs: citation state then mention state. Legend printed
  // above the table so the symbols are unambiguous to scripts and humans both.
  // Width grows with the longest provider name so headers like "perplexity"
  // stay aligned with the 2-char cells underneath.
  const cellWidth = Math.max(6, ...providerColumns.map(p => p.length))
  const queryWidth = Math.max(7, ...data.byQuery.map(r => r.query.length))
  const header = ['Query'.padEnd(queryWidth), ...providerColumns.map(p => p.padEnd(cellWidth)), 'Cite', 'Ment'].join('  ')
  console.log(`Per-query coverage:  ${SNAPSHOT_CELL_LEGEND}`)
  console.log(header)
  console.log('─'.repeat(header.length))
  for (const row of data.byQuery) {
    const cells = providerColumns.map(p => {
      const provider = row.providers.find(x => x.provider === p)
      if (!provider) return '–'.padEnd(cellWidth)
      return `${citationGlyph(provider.citationState)}${mentionGlyph(provider.mentioned)}`.padEnd(cellWidth)
    })
    // Cited is out of the engines whose answers carried sources.
    const citationBase = row.totalProviders - row.citationNotMeasured
    const citeCol = citationBase > 0 ? `${row.citedCount}/${citationBase}` : '·'
    const mentCol = `${row.mentionedCount}/${row.totalProviders}`
    console.log([row.query.padEnd(queryWidth), ...cells, citeCol, mentCol].join('  '))
  }
}

function printGaps(data: CitationVisibilityResponse): void {
  console.log('Competitor gaps (not cited but a competitor is):')
  const queryWidth = Math.max(7, ...data.competitorGaps.map(g => g.query.length))
  const providerWidth = Math.max(8, ...data.competitorGaps.map(g => g.provider.length))
  for (const gap of data.competitorGaps) {
    console.log(
      `  ${gap.query.padEnd(queryWidth)}  ${gap.provider.padEnd(providerWidth)}  ${gap.citingCompetitors.join(', ')}`,
    )
  }
}
