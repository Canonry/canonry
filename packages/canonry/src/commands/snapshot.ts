import fs from 'node:fs'
import path from 'node:path'
import type { SnapshotProviderResultDto, SnapshotReportDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { writeSnapshotPdf } from '../snapshot-pdf.js'

function getClient() {
  return createApiClient()
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function autoOutputPath(companyName: string, ext: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `${slugify(companyName)}-snapshot-${date}.${ext}`
}

export async function createSnapshotReport(
  companyName: string,
  opts: {
    domain: string
    phrases?: string[]
    competitors?: string[]
    md?: boolean
    pdf?: boolean
    outputPath?: string
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

  let savedMdPath: string | undefined
  if (opts.md) {
    const mdPath = opts.outputPath ?? autoOutputPath(companyName, 'md')
    savedMdPath = writeSnapshotMarkdown(report, mdPath)
  }

  let savedPdfPath: string | undefined
  if (opts.pdf) {
    const pdfPath = opts.outputPath && !opts.md
      ? opts.outputPath
      : autoOutputPath(companyName, 'pdf')
    savedPdfPath = await writeSnapshotPdf(report, pdfPath)
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2))
    if (savedMdPath) process.stderr.write(`Saved markdown: ${savedMdPath}\n`)
    if (savedPdfPath) process.stderr.write(`Saved PDF: ${savedPdfPath}\n`)
    return
  }

  console.log(formatSnapshotText(report))
  if (savedMdPath) console.log(`\nMarkdown saved: ${savedMdPath}`)
  if (savedPdfPath) console.log(`\nPDF saved: ${savedPdfPath}`)
}

export function writeSnapshotMarkdown(report: SnapshotReportDto, outputPath: string): string {
  const resolvedPath = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, formatSnapshotMarkdown(report), 'utf-8')
  return resolvedPath
}

export function formatSnapshotMarkdown(report: SnapshotReportDto): string {
  const lines: string[] = []

  lines.push(`# AI Perception Snapshot: ${report.companyName}`)
  lines.push('')
  lines.push(`**Domain:** ${report.domain}`)
  lines.push(`**Generated:** ${new Date(report.generatedAt).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)
  lines.push(`**AEO Audit Score:** ${report.audit.overallScore}/100 (${report.audit.overallGrade})`)
  lines.push('')

  lines.push('## Visibility Gap')
  lines.push('')
  lines.push(report.summary.visibilityGap)
  lines.push('')

  if (report.summary.whatThisMeans.length > 0) {
    lines.push('## What This Means')
    lines.push('')
    for (const item of report.summary.whatThisMeans) {
      lines.push(`- ${item}`)
    }
    lines.push('')
  }

  if (report.summary.recommendedActions.length > 0) {
    lines.push('## Recommended Actions')
    lines.push('')
    for (const action of report.summary.recommendedActions) {
      lines.push(`- ${action}`)
    }
    lines.push('')
  }

  if (report.summary.topCompetitors.length > 0) {
    lines.push('## Competitors AI Recommends Instead')
    lines.push('')
    lines.push('| Competitor | Mentions |')
    lines.push('|------------|----------|')
    for (const entry of report.summary.topCompetitors) {
      lines.push(`| ${entry.name} | ${entry.count} |`)
    }
    lines.push('')
  }

  lines.push('## Provider Comparison')
  lines.push('')
  for (const query of report.queryResults) {
    lines.push(`### "${query.phrase}"`)
    lines.push('')
    lines.push('| Provider | Mentioned | Cited | Accuracy | Competitors Recommended |')
    lines.push('|----------|-----------|-------|----------|------------------------|')
    for (const result of query.providerResults) {
      if (result.error) {
        lines.push(`| ${result.displayName} | ERROR | - | - | ${result.error} |`)
        continue
      }
      const mentioned = result.mentioned ? 'Yes' : 'No'
      const cited = result.cited ? 'Yes' : 'No'
      const accuracy = result.describedAccurately === 'not-mentioned' ? '-' : result.describedAccurately
      const competitors = result.recommendedCompetitors.length > 0
        ? result.recommendedCompetitors.join(', ')
        : '-'
      lines.push(`| ${result.displayName} | ${mentioned} | ${cited} | ${accuracy} | ${competitors} |`)
    }
    lines.push('')
  }

  if (report.audit.factors.length > 0) {
    lines.push('## Audit Factors')
    lines.push('')
    lines.push(report.audit.summary)
    lines.push('')
    lines.push('| Factor | Score | Weight | Status |')
    lines.push('|--------|-------|--------|--------|')
    const sorted = [...report.audit.factors].sort((a, b) => a.score - b.score)
    for (const factor of sorted) {
      lines.push(`| ${factor.name} | ${factor.score} | ${factor.weight} | ${factor.status} |`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`*Generated by [Canonry](https://github.com/AINYC/canonry)*`)

  return lines.join('\n')
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
