import type { SnapshotProviderResultDto, SnapshotReportDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { writeSnapshotPdf } from '../snapshot-pdf.js'

function getClient() {
  return createApiClient()
}

export async function createSnapshotReport(
  companyName: string,
  opts: {
    domain: string
    phrases?: string[]
    competitors?: string[]
    pdf?: string
    format?: string
  },
): Promise<void> {
  const client = getClient()
  const report = await client.createSnapshot({
    companyName,
    domain: opts.domain,
    ...(opts.phrases && opts.phrases.length > 0 ? { phrases: opts.phrases } : {}),
    ...(opts.competitors && opts.competitors.length > 0 ? { competitors: opts.competitors } : {}),
  })

  let savedPdfPath: string | undefined
  if (opts.pdf) {
    savedPdfPath = await writeSnapshotPdf(report, opts.pdf)
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2))
    if (savedPdfPath) {
      process.stderr.write(`Saved PDF: ${savedPdfPath}\n`)
    }
    return
  }

  console.log(formatSnapshotText(report))
  if (savedPdfPath) {
    console.log(`\nPDF saved: ${savedPdfPath}`)
  }
}

export function formatSnapshotText(report: SnapshotReportDto): string {
  const lines: string[] = []
  lines.push(`Snapshot: ${report.companyName} (${report.domain})`)
  lines.push(`AEO audit: ${report.audit.overallScore}/100 (${report.audit.overallGrade})`)
  lines.push(report.summary.visibilityGap)
  lines.push('')

  if (report.summary.topCompetitors.length > 0) {
    lines.push(
      `Top competitors AI recommended instead: ${report.summary.topCompetitors.map(entry => `${entry.name} (${entry.count})`).join(', ')}`,
    )
    lines.push('')
  }

  if (report.summary.whatThisMeans.length > 0) {
    lines.push('What this means:')
    for (const item of report.summary.whatThisMeans) {
      lines.push(`  - ${item}`)
    }
    lines.push('')
  }

  const providerWidth = Math.max(
    8,
    ...report.queryResults.flatMap(query => query.providerResults.map(result => result.displayName.length)),
  )

  for (const query of report.queryResults) {
    lines.push(`"${query.phrase}"`)
    for (const result of query.providerResults) {
      lines.push(`  ${result.displayName.padEnd(providerWidth)}  ${formatProviderLine(result)}`)
    }
    lines.push('')
  }

  if (report.summary.recommendedActions.length > 0) {
    lines.push('Recommended actions:')
    for (const action of report.summary.recommendedActions) {
      lines.push(`  - ${action}`)
    }
  }

  return lines.join('\n').trimEnd()
}

function formatProviderLine(result: SnapshotProviderResultDto): string {
  if (result.error) {
    return `ERROR: ${result.error}`
  }

  const bits: string[] = []
  bits.push(result.mentioned ? 'YES mentioned' : 'NO mention')
  if (result.cited) bits.push('cited')
  if (result.describedAccurately !== 'not-mentioned') {
    bits.push(`accuracy=${result.describedAccurately}`)
  }
  if (result.recommendedCompetitors.length > 0) {
    bits.push(`recommended instead: ${result.recommendedCompetitors.join(', ')}`)
  }
  if (result.incorrectClaims.length > 0) {
    bits.push(`incorrect: ${result.incorrectClaims.join('; ')}`)
  }
  return bits.join(' | ')
}
