import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

/** `canonry technical-aeo score <project>` — site-level scorecard. Composite → json (not jsonl). */
export async function technicalAeoScore(project: string, opts: { format?: string }): Promise<void> {
  const client = getClient()
  const score = await client.getTechnicalAeoScore(project)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(score, null, 2))
    return
  }

  if (!score.hasData) {
    console.log(
      `No technical audit yet for "${project}". Run \`canonry technical-aeo run ${project}\` to generate one.`,
    )
    return
  }

  const lines: string[] = []
  const delta = score.deltaScore == null ? '' : ` (${score.deltaScore >= 0 ? '+' : ''}${score.deltaScore} vs prev)`
  lines.push(`Technical AEO: ${score.aggregateScore}/100 (${score.aggregateGrade})${delta}`)
  lines.push(
    `Audited ${score.pagesAudited} page(s) · ${score.pagesSkipped} skipped · ${score.pagesErrored} errored · sitemap ${score.sitemapUrl}`,
  )
  lines.push(`As of ${score.auditedAt}`)
  if (score.factors.length > 0) {
    lines.push('')
    lines.push(`${'Factor'.padEnd(32)}${'Wt'.padStart(4)}${'Avg'.padStart(6)}${'Grade'.padStart(7)}   Pass/Part/Fail`)
    for (const f of score.factors) {
      lines.push(
        `${f.name.slice(0, 31).padEnd(32)}${String(f.weight).padStart(4)}${String(f.avgScore).padStart(6)}${f.avgGrade.padStart(7)}   ${f.pagesPassing}/${f.pagesPartial}/${f.pagesFailing}`,
      )
    }
  }
  if (score.prioritizedFixes.length > 0) {
    lines.push('')
    lines.push('Prioritized fixes:')
    score.prioritizedFixes.forEach((fix, i) => lines.push(`  ${i + 1}. ${fix}`))
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo pages <project>` — per-page breakdown. Collection → supports jsonl. */
export async function technicalAeoPages(
  project: string,
  opts: { status?: string; sort?: string; limit?: number; format?: string },
): Promise<void> {
  const client = getClient()
  const status = opts.status === 'success' || opts.status === 'error' ? opts.status : undefined
  const res = await client.getTechnicalAeoPages(project, { status, sort: opts.sort, limit: opts.limit })

  if (opts.format === 'jsonl') {
    emitJsonl(res.pages.map((p) => ({ project, runId: res.runId, ...p })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  if (res.pages.length === 0) {
    console.log(`No audited pages for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  const lines: string[] = []
  lines.push(`${res.pages.length} of ${res.total} page(s) from run ${res.runId}:\n`)
  lines.push(`${'Score'.padStart(5)}  ${'Grade'.padEnd(5)}  ${'Status'.padEnd(7)}  URL`)
  for (const p of res.pages) {
    const tail = p.status === 'error' ? `  ${p.error ?? 'error'}` : ''
    lines.push(`${String(p.overallScore).padStart(5)}  ${p.overallGrade.padEnd(5)}  ${p.status.padEnd(7)}  ${p.url}${tail}`)
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo trend <project>` — aggregate score over time. Collection → supports jsonl. */
export async function technicalAeoTrend(
  project: string,
  opts: { limit?: number; format?: string },
): Promise<void> {
  const client = getClient()
  const res = await client.getTechnicalAeoTrend(project, { limit: opts.limit })

  if (opts.format === 'jsonl') {
    emitJsonl(res.points.map((p) => ({ project, ...p })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  if (res.points.length === 0) {
    console.log(`No audits yet for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  const lines: string[] = []
  lines.push(`${'Date'.padEnd(26)}  ${'Score'.padStart(5)}  ${'Grade'.padEnd(5)}  Pages`)
  for (const p of res.points) {
    lines.push(`${p.auditedAt.padEnd(26)}  ${String(p.aggregateScore).padStart(5)}  ${p.aggregateGrade.padEnd(5)}  ${p.pagesAudited}`)
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo run <project>` — trigger a site-audit run. Mutation → json (not jsonl). */
export async function technicalAeoRun(
  project: string,
  opts: { sitemapUrl?: string; limit?: number; wait?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const { runId, status } = await client.triggerSiteAudit(project, {
    sitemapUrl: opts.sitemapUrl,
    limit: opts.limit,
  })

  if (!opts.wait) {
    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({ runId, status }, null, 2))
      return
    }
    console.log(
      `Site audit started (run ${runId}, status ${status}). Use \`canonry runs get ${runId}\` to check status, or pass --wait.`,
    )
    return
  }

  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])
  const start = Date.now()
  const timeoutMs = 15 * 60 * 1000
  if (!isMachineFormat(opts.format)) process.stderr.write('Auditing')
  let final = status
  while (!terminal.has(final) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const run = await client.getRun(runId)
    if (!isMachineFormat(opts.format)) process.stderr.write('.')
    final = run.status
  }
  if (!isMachineFormat(opts.format)) process.stderr.write('\n')

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({ runId, status: final }, null, 2))
    return
  }
  console.log(`Site audit ${final} (run ${runId}).`)
}
