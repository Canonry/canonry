import { readFileSync } from 'node:fs'
import { SeoMarketRankingOutcomes, formatNumber, marketRankingBands, seoProfileInputSchema, type SeoEvidenceQuery, type SeoMarketRankingCounts, type SeoMarketRankingQuery, type SeoMarketRankingRow, type SeoMarketRankingSummaryQuery, type SeoRun, type SeoSyncInput } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError, type CliFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { seoReconcileInputSchema } from '@canonry/canonry-contracts'

export async function showSeoOperatorTask(id: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoOperatorTask(id)
  if (!printSeoJson(value, format)) {
    console.log(`${value.id}: ${value.status} · run ${value.runId}`)
    console.log(`Reserved microUSD: ${value.reservedCostMicros} · settled microUSD: ${value.actualCostMicros ?? 'Unknown'}`)
    for (const receipt of value.receipts) console.log(`${receipt.remoteTaskId ?? 'Unknown receipt'} · status ${receipt.statusCode ?? 'Unknown'} · microUSD ${receipt.costMicros ?? 'Unknown'}`)
  }
}

export async function reconcileSeoTask(id: string, source: string, format: CliFormat): Promise<void> {
  let value: unknown
  try { value = JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')) }
  catch { throw usageError('Provide a readable verified receipt JSON file (or - for stdin).') }
  const parsed = seoReconcileInputSchema.safeParse(value)
  if (!parsed.success) throw usageError('Receipt requires actualCostMicros, remoteTaskId, outcome and a verification note.')
  const result = await createApiClient().reconcileSeoTask(id, parsed.data)
  if (!printSeoJson(result, format)) console.log(`${result.id}: ${result.status}`)
}

function printSeoJson(value: unknown, format: CliFormat): boolean {
  if (!isMachineFormat(format)) return false
  console.log(JSON.stringify(value, null, format === 'jsonl' ? 0 : 2))
  return true
}

function printSeoRun(run: SeoRun): void {
  console.log(`${run.id}: ${run.status} · profile ${run.profileId} · ${run.completedTasks}/${run.taskCount} tasks`)
  console.log(`Scope: ${run.scope.kind}${run.scope.key ? ` ${run.scope.key}` : ''}${run.scope.expectedPlanRevision !== undefined ? ` · revision ${run.scope.expectedPlanRevision}` : ''}`)
  if (run.error) console.log(run.error)
}

export async function showSeoContext(project: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoContext(project)
  if (printSeoJson(value, format)) return
  console.log(`SEO data: ${value.available ? 'available' : 'unavailable'}`)
  if (value.reason) console.log(value.reason)
  for (const connection of value.connections) console.log(`${connection.id}: ${connection.label} · ${connection.provider} · ${connection.capabilities.join(', ')}`)
  for (const scope of value.scopes) console.log(`${scope.kind}${scope.key ? ` ${scope.key}` : ''}: ${scope.label} · ${scope.supported ? 'supported' : scope.reason ?? 'unsupported'}`)
  console.log(`Actions: refresh ${value.access.canRun ? 'allowed' : 'unavailable'}; edit profiles ${value.access.canWrite ? 'allowed' : 'unavailable'}`)
}

export async function showSeoStatus(project: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoStatus(project)
  if (printSeoJson(value, format)) return
  console.log(`SEO data: ${value.available ? 'available' : 'unavailable'} · ${value.profileCount} profiles`)
  if (value.reason) console.log(value.reason)
  if (value.latestRunId) console.log(`Latest refresh: ${value.latestRunId} · ${value.latestRunStatus}`)
  console.log(`Last completed: ${value.lastCompletedAt ?? 'No completed refresh'}`)
}

export async function listSeoProfiles(project: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().listSeoProfiles(project)
  if (format === 'jsonl') { emitJsonl(value.profiles.map(profile => ({ project, ...profile }))); return }
  if (printSeoJson(value, format)) return
  for (const profile of value.profiles) console.log(`${profile.id}: ${profile.name} · revision ${profile.revision} · ${profile.connectionId} · ${profile.locationCode}/${profile.languageCode} · ${profile.scope.kind}${profile.scope.key ? ` ${profile.scope.key}` : ''}`)
  if (!value.profiles.length) console.log('No SEO profiles. Use seo context to inspect available connections and scopes, then seo profile set.')
}

export async function showSeoProfile(project: string, id: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoProfile(project, id)
  if (printSeoJson(value, format)) return
  console.log(`${value.name} (${value.id}) · revision ${value.revision}`)
  console.log(`Source: ${value.connectionId} · Google · ${value.locationCode}/${value.languageCode}`)
  console.log(`Scope: ${value.scope.kind}${value.scope.key ? ` ${value.scope.key}` : ''}`)
  console.log(`Capabilities: ${value.capabilities.join(', ')} · row limit ${value.limit}`)
  for (const target of value.targets) console.log(`Target: ${target.kind} ${target.value} · subdomains ${target.includeSubdomains ? 'included' : 'excluded'}`)
  for (const keyword of value.keywords) console.log(`Keyword: ${keyword}`)
}

export async function setSeoProfile(project: string, id: string, source: string, format: CliFormat): Promise<void> {
  let input: unknown
  try { input = JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')) }
  catch { throw usageError('SEO profile input must be a readable JSON file (or - for stdin).') }
  const parsed = seoProfileInputSchema.safeParse(input)
  if (!parsed.success) throw usageError(`Invalid SEO profile: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  const value = await createApiClient().putSeoProfile(project, id, parsed.data)
  if (!printSeoJson(value, format)) console.log(`Saved ${value.name} (${value.id}) · revision ${value.revision}. No refresh started.`)
}

export async function prepareSeoRefresh(project: string, profileId: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().createSeoRefreshIntent(project, { profileId })
  if (printSeoJson(value, format)) return
  console.log(`Refresh: ${value.availability} · ${value.taskCount} tasks · profile ${value.profileId} revision ${value.profileRevision}`)
  if (value.reason) console.log(value.reason)
  console.log(`Expires: ${value.expiresAt}`)
  console.log(`Intent token: ${value.token}`)
}

export async function syncSeo(project: string, request: SeoSyncInput, format: CliFormat): Promise<void> {
  const value = await createApiClient().syncSeo(project, request)
  if (!printSeoJson(value, format)) printSeoRun(value)
}

export async function listSeoRuns(project: string, format: CliFormat, profileId?: string): Promise<void> {
  const value = await createApiClient().listSeoRuns(project, { profileId })
  if (format === 'jsonl') { emitJsonl(value.runs.map(run => ({ project, ...run }))); return }
  if (printSeoJson(value, format)) return
  for (const run of value.runs) printSeoRun(run)
  if (!value.runs.length) console.log('No SEO refreshes yet.')
}

export async function showSeoRun(project: string, id: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoRun(project, id)
  if (printSeoJson(value, format)) return
  printSeoRun(value)
  for (const task of value.tasks) {
    // A market-rankings task is one search; its text names it, where the target is the same on every line.
    const subject = task.searchText !== null ? ` · "${task.searchText}" from ${task.locationLabel ?? 'its market'}` : task.target ? ` · ${task.target.value}` : ''
    console.log(`  ${task.capability}${subject}${task.retried ? ' · retried once' : ''}: ${task.status}${task.error ? ` · ${task.error}` : ''}`)
  }
  if (value.resultsTruncated) console.log('Result preview is partial. Read the evidence commands with this run ID for all saved rows.')
}

export async function cancelSeoRun(project: string, id: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().cancelSeoRun(project, id)
  if (!printSeoJson(value, format)) printSeoRun(value)
}

export async function showSeoOverview(project: string, query: SeoEvidenceQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoOverview(project, query)
  if (printSeoJson(value, format)) return
  console.log(`SEO data: ${value.status.available ? 'available' : 'unavailable'}`)
  if (value.status.reason) console.log(value.status.reason)
  if (value.latestRun) printSeoRun(value.latestRun)
  console.log(`Saved rows: ${value.keywordMetricsCount} keyword metrics · ${value.rankedKeywordCount} ranked keywords · ${value.domainIntelligenceCount} domain summaries · ${value.marketRankingCount} market rankings`)
  if (value.summary) console.log(`${value.summary.target.value}: ${value.summary.organicKeywords ?? 'Unavailable'} organic keywords · ${value.summary.inTop10 ?? 'Unavailable'} in top 10 · ${value.summary.estimatedOrganicTraffic ?? 'Unavailable'} estimated monthly traffic`)
  if (value.evidenceRunId) console.log(`Evidence run: ${value.evidenceRunId}`)
}

export async function showSeoKeywordMetrics(project: string, query: SeoEvidenceQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoKeywordMetrics(project, query)
  // Keep paging and the selected run even for an empty JSONL page.
  if (printSeoJson(value, format)) return
  console.log(`Keyword metrics · run ${value.runId ?? 'none'} · ${value.items.length} of ${value.total} rows · offset ${value.offset}`)
  for (const row of value.items) console.log(`${row.keyword}\tVolume ${row.searchVolume === null ? 'Not available' : formatNumber(row.searchVolume)}\tDifficulty ${row.keywordDifficulty === null ? 'Not available' : `${row.keywordDifficulty}/100`}\t${row.provenance.provider} · ${row.provenance.locationCode}/${row.provenance.languageCode} · ${row.provenance.collectedAt}`)
}

export async function showSeoDomainIntelligence(project: string, query: SeoEvidenceQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoDomainIntelligence(project, query)
  if (printSeoJson(value, format)) return
  console.log(`Domain intelligence · run ${value.runId ?? 'none'} · ${value.items.length} of ${value.total} rows · offset ${value.offset}`)
  for (const row of value.items) console.log(`${row.target.value}\tRanking keywords ${row.organicKeywords === null ? 'Not available' : formatNumber(row.organicKeywords)}\tOrganic traffic estimate ${row.estimatedOrganicTraffic === null ? 'Not available' : formatNumber(row.estimatedOrganicTraffic)}\t${row.provenance.provider} · ${row.provenance.locationCode}/${row.provenance.languageCode} · ${row.provenance.collectedAt}`)
}

export async function showSeoRankedKeywords(project: string, query: SeoEvidenceQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoRankedKeywords(project, query)
  if (printSeoJson(value, format)) return
  console.log(`Ranked keywords · run ${value.runId ?? 'none'} · ${value.items.length} of ${value.total} rows · offset ${value.offset}`)
  for (const row of value.items) console.log(`${row.keyword}\tOrganic rank ${row.rankOrganic ?? 'Not available'}\tVolume ${row.searchVolume === null ? 'Not available' : formatNumber(row.searchVolume)}\t${row.url ?? 'URL unavailable'}\t${row.provenance.provider} · ${row.provenance.locationCode}/${row.provenance.languageCode} · ${row.provenance.collectedAt}`)
}

export async function showSeoMarketRankings(project: string, query: SeoMarketRankingQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoMarketRankings(project, query)
  if (printSeoJson(value, format)) return
  console.log(`Market rankings · run ${value.runId ?? 'none'} · ${value.items.length} of ${value.total} rows · offset ${value.offset}`)
  for (const row of value.items) {
    const rival = row.competitors[0]
    const rivalText = row.outcome === SeoMarketRankingOutcomes.failed || row.outcome === SeoMarketRankingOutcomes.cancelled ? 'No result'
      : rival ? `Top rival ${rival.domain} #${rival.rankOrganic}${row.rivalAhead ? ' (ahead)' : ''}` : 'No tracked rival in the results'
    const source = row.provenance ? ` · ${row.provenance.device} · ${row.provenance.collectedAt}` : ''
    console.log(`${row.marketLabel}\t${row.queryText}\t${rankText(row)}\t${row.url ?? 'No ranking page'}\t${rivalText}\tSearched as "${row.searchText}" from ${row.locationLabel}${source}`)
  }
}

/** One row's rank in words: its Google rank, not in the results it checked, or why there is no result. */
function rankText(row: SeoMarketRankingRow): string {
  switch (row.outcome) {
    case SeoMarketRankingOutcomes.failed: return 'Search failed'
    case SeoMarketRankingOutcomes.cancelled: return 'Not searched'
    case SeoMarketRankingOutcomes['partly-checked']: return `Not in the top ${row.depth} (partial results)`
    case SeoMarketRankingOutcomes['not-ranked']: return `Not in the top ${row.depth}`
    case SeoMarketRankingOutcomes['page-1']:
    case SeoMarketRankingOutcomes['ranks-11-20']:
    case SeoMarketRankingOutcomes['ranks-21-plus']:
      return `Google rank ${row.rankOrganic}`
    default: {
      const unknown: never = row.outcome
      return unknown
    }
  }
}

function countsText(counts: SeoMarketRankingCounts, depth: number | null, totals: SeoMarketRankingCounts): string {
  return [...marketRankingBands(depth, totals).map(band => `${band.label} ${counts[band.count]}`),
    `Partly checked ${counts.partlyChecked}`, `Failed ${counts.failed}`, `Not searched ${counts.cancelled}`, `Needs work ${counts.needsWork}`, `Rival ahead ${counts.rivalAhead}`].join(' · ')
}

export async function showSeoMarketSummary(project: string, query: SeoMarketRankingSummaryQuery, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSeoMarketRankingSummary(project, query)
  if (printSeoJson(value, format)) return
  const scope = [value.regionKey === null ? null : `region ${value.regionLabel ?? value.regionKey}`, value.marketKey === null ? null : `market ${value.marketLabel ?? value.marketKey}`]
    .filter(part => part !== null).join(' · ') || 'all markets'
  const queries = (count: number) => `${count} ${count === 1 ? 'query' : 'queries'}`
  console.log(`Market rankings summary · run ${value.runId ?? 'none'} · ${scope} · ${queries(value.totals.queries)}`)
  console.log(countsText(value.totals, value.depth, value.totals))
  for (const group of value.groups) console.log(`${group.label}\t${group.kind}\t${queries(group.counts.queries)}\t${countsText(group.counts, value.depth, value.totals)}`)
}
