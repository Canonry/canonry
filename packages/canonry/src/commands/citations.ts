import type { CitationVisibilityResponse } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

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
    if (data.reason === 'no-keywords') {
      console.log('No keywords configured. Add some with `canonry keyword add`.')
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
    totalKeywords,
    keywordsCitedAndMentioned,
    keywordsCitedOnly,
    keywordsMentionedOnly,
    keywordsInvisible,
  } = data.summary
  console.log('Citation visibility')
  if (data.summary.latestRunAt) {
    console.log(`Latest run:           ${data.summary.latestRunAt}`)
  }
  console.log(`Cited in sources:     ${providersCiting}/${providersConfigured} engines`)
  console.log(`Mentioned in answers: ${providersMentioning}/${providersConfigured} engines`)
  console.log('')
  console.log(`Keywords (${totalKeywords} total):`)
  console.log(`  cited + mentioned:  ${keywordsCitedAndMentioned}`)
  console.log(`  cited only:         ${keywordsCitedOnly}`)
  console.log(`  mentioned only:     ${keywordsMentionedOnly}`)
  console.log(`  invisible:          ${keywordsInvisible}`)
}

function printCoverage(data: CitationVisibilityResponse): void {
  if (data.byKeyword.length === 0) {
    console.log('No keyword coverage rows.')
    return
  }
  // Build a stable provider column order from any row that has providers
  const providerSet = new Set<string>()
  for (const row of data.byKeyword) {
    for (const p of row.providers) providerSet.add(p.provider)
  }
  const providerColumns = Array.from(providerSet).sort()

  if (providerColumns.length === 0) {
    console.log('Per-keyword coverage:')
    for (const row of data.byKeyword) {
      console.log(`  ${row.keyword.padEnd(35)} no snapshots`)
    }
    return
  }

  // Each cell is two glyphs: citation state then mention state. Legend printed
  // above the table so the symbols are unambiguous to scripts and humans both.
  // Width grows with the longest provider name so headers like "perplexity"
  // stay aligned with the 2-char cells underneath.
  const cellWidth = Math.max(6, ...providerColumns.map(p => p.length))
  const keywordWidth = Math.max(7, ...data.byKeyword.map(r => r.keyword.length))
  const header = ['Keyword'.padEnd(keywordWidth), ...providerColumns.map(p => p.padEnd(cellWidth)), 'Cite', 'Ment'].join('  ')
  console.log('Per-keyword coverage:  (cell = [citation][mention];  C=cited c=not, M=mentioned m=not, –=no data)')
  console.log(header)
  console.log('─'.repeat(header.length))
  for (const row of data.byKeyword) {
    const cells = providerColumns.map(p => {
      const provider = row.providers.find(x => x.provider === p)
      if (!provider) return '–'.padEnd(cellWidth)
      const citationGlyph = provider.cited ? 'C' : 'c'
      const mentionGlyph = provider.mentioned ? 'M' : 'm'
      return `${citationGlyph}${mentionGlyph}`.padEnd(cellWidth)
    })
    const citeCol = `${row.citedCount}/${row.totalProviders}`
    const mentCol = `${row.mentionedCount}/${row.totalProviders}`
    console.log([row.keyword.padEnd(keywordWidth), ...cells, citeCol, mentCol].join('  '))
  }
}

function printGaps(data: CitationVisibilityResponse): void {
  console.log('Competitor gaps (not cited but a competitor is):')
  const keywordWidth = Math.max(7, ...data.competitorGaps.map(g => g.keyword.length))
  const providerWidth = Math.max(8, ...data.competitorGaps.map(g => g.provider.length))
  for (const gap of data.competitorGaps) {
    console.log(
      `  ${gap.keyword.padEnd(keywordWidth)}  ${gap.provider.padEnd(providerWidth)}  ${gap.citingCompetitors.join(', ')}`,
    )
  }
}
