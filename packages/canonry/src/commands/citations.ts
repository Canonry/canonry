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
  const { providersCiting, providersConfigured, totalKeywords, keywordsCited, keywordsFullyCovered, keywordsUncovered } = data.summary
  console.log(`Citation visibility — cited by ${providersCiting}/${providersConfigured} engines`)
  if (data.summary.latestRunAt) {
    console.log(`Latest run:        ${data.summary.latestRunAt}`)
  }
  console.log(`Keywords:          ${totalKeywords}`)
  console.log(`  cited (any):     ${keywordsCited}`)
  console.log(`  fully covered:   ${keywordsFullyCovered}`)
  console.log(`  uncovered:       ${keywordsUncovered}`)
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

  const keywordWidth = Math.max(7, ...data.byKeyword.map(r => r.keyword.length))
  const header = ['Keyword'.padEnd(keywordWidth), ...providerColumns.map(p => p.padEnd(10)), 'Coverage'].join('  ')
  console.log('Per-keyword coverage:')
  console.log(header)
  console.log('─'.repeat(header.length))
  for (const row of data.byKeyword) {
    const cells = providerColumns.map(p => {
      const provider = row.providers.find(x => x.provider === p)
      if (!provider) return '–'.padEnd(10)
      return (provider.cited ? '✓' : '✗').padEnd(10)
    })
    const coverage = `${row.citedCount}/${row.totalProviders}`
    console.log([row.keyword.padEnd(keywordWidth), ...cells, coverage].join('  '))
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
