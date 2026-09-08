import { shareOfVoiceLabel, shareOfVoiceReason, type ShareOfVoiceContext } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import type { CompetitorLandscapeQuery, CompetitorLandscapeResponse, ModelEvidenceState } from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

export async function addCompetitors(project: string, domains: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listCompetitors(project)
  const existingDomains = existing.map(c => c.domain)
  const existingSet = new Set(existingDomains)
  const requested = new Set(uniqueStrings(domains))
  const current = await client.appendCompetitors(project, domains)
  const currentDomains = current.map(c => c.domain)
  const addedDomains = currentDomains.filter(domain => requested.has(domain) && !existingSet.has(domain))

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      domains: currentDomains,
      addedDomains,
      addedCount: addedDomains.length,
    }, null, 2))
    return
  }

  if (addedDomains.length === 0) {
    console.log(`No new competitors added to "${project}" (all already tracked).`)
  } else {
    console.log(`Added ${addedDomains.length} competitor(s) to "${project}".`)
  }
}

export async function removeCompetitors(project: string, domains: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listCompetitors(project)
  const existingDomains = existing.map(c => c.domain)
  const requested = new Set(uniqueStrings(domains))
  const current = await client.deleteCompetitors(project, domains)
  const currentSet = new Set(current.map(c => c.domain))
  const removedDomains = existingDomains.filter(domain => requested.has(domain) && !currentSet.has(domain))

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      domains: current.map(c => c.domain),
      removedDomains,
      removedCount: removedDomains.length,
    }, null, 2))
    return
  }

  console.log(`Removed ${removedDomains.length} competitor(s) from "${project}".`)
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export async function listCompetitors(project: string, format?: string): Promise<void> {
  const client = getClient()
  const comps = await client.listCompetitors(project)

  if (format === 'json') {
    console.log(JSON.stringify(comps, null, 2))
    return
  } else if (format === 'jsonl') {
    // One self-contained competitor per line. Each carries `project` so a line
    // lifted out of context still says which project it belongs to; the record's
    // own fields spread last and win.
    emitJsonl(comps.map(c => ({ project, ...c })))
    return
  }

  if (comps.length === 0) {
    console.log(`No competitors found for "${project}".`)
    return
  }

  console.log(`Competitors for "${project}" (${comps.length}):\n`)
  for (const c of comps) {
    console.log(`  ${c.domain}`)
  }
}

export interface CompetitorLandscapeOptions extends CompetitorLandscapeQuery {
  format?: string
}

/** `canonry competitor landscape` — stored historical evidence; never starts a provider run. */
export async function showCompetitorLandscape(project: string, options: CompetitorLandscapeOptions): Promise<void> {
  const client = getClient()
  const data = await client.getCompetitorLandscape(project, {
    window: options.window,
    scope: options.scope,
    groupKey: options.groupKey,
    provider: options.provider,
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    queryClass: options.queryClass,
    location: options.location,
    runId: options.runId,
  })

  if (options.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  // The response has several dependent row collections plus evidence metadata;
  // JSONL therefore emits one compact, self-contained document on one line.
  if (options.format === 'jsonl') {
    console.log(JSON.stringify(data))
    return
  }
  printCompetitorLandscape(data)
}

function printCompetitorLandscape(data: CompetitorLandscapeResponse): void {
  const scope = data.scope.kind === 'group'
    ? `market ${data.scope.groupKey}`
    : data.scope.kind === 'all-markets' ? 'all markets' : 'project'
  console.log(`Competitor landscape · ${scope} · ${data.window}`)
  if (data.filters.model !== undefined) {
    console.log(`Requested model filter: ${data.filters.provider} · ${data.filters.model}`)
  }
  console.log('Mention share is answer-text evidence; citations are independent source-list evidence.')
  console.log(
    data.filters.queryClass === 'all'
      ? 'Share of voice is blank: branded and non-brand queries are pooled here. Add --query-class non-brand for a ratio.'
      : `Counting ${data.filters.queryClass} queries only.`,
  )
  if (data.reason) console.log(shareOfVoiceReason(data.reason))
  if (data.truncated) console.log('Top 100 observed competitors and top 100 other cited sources shown; pinned competitors are complete.')
  console.log('')
  printLandscapeRows('Your brand', [data.project], false, data, data.filters.queryClass)
  printLandscapeRows('Pinned competitors', data.pinned, false, data, data.filters.queryClass)
  printLandscapeRows('Observed competitors', data.observed, false, data, data.filters.queryClass)
  printLandscapeRows('Other cited sources', data.otherSources, false, data, data.filters.queryClass)
  console.log('')
  console.log(
    `Evidence: ${data.evidence.answeredResults} answer-text result(s), ${data.evidence.sourceResults} source result(s); `
    + `excluded: ${data.evidence.excludedProbeResults} probe, ${data.evidence.excludedNonCompletedResults} non-completed.`,
  )
  if (data.observedNames?.length) {
    console.log('Names observed in answers (not a comparison set):')
    for (const row of data.observedNames) console.log(`  ${row.name} · ${row.answerCount} answers`)
  }
  if (data.modelComparison) printModelComparison(data.modelComparison, data.filters.queryClass)
}

function describeServedModels(evidence: ModelEvidenceState): string {
  if (evidence.status === 'unknown') return 'Unknown (not disclosed)'
  if (evidence.status === 'known') return evidence.model
  return [...evidence.models, ...(evidence.includesUnknown ? ['Unknown (not disclosed)'] : [])].join(', ')
}

function printModelComparison(comparison: NonNullable<CompetitorLandscapeResponse['modelComparison']>, queryClass: string): void {
  console.log('')
  console.log(`Model comparison · requested-model basis · ${comparison.groups.length} of ${comparison.totalGroups} groups`)
  console.log('Groups use stored observations. They do not form a matched-query or equal-weight comparison.')
  if (comparison.truncated) console.log('The first 50 provider/model groups are shown. Additional groups are omitted.')
  for (const group of comparison.groups) {
    console.log('')
    console.log(`${group.provider} · requested model: ${group.model ?? 'Unknown (not recorded)'}`)
    console.log(`Served model evidence: ${describeServedModels(group.servedModels)}`)
    console.log(`Samples: ${group.snapshotCount} snapshot(s), ${group.evidence.answeredResults} answer-text result(s), ${group.evidence.sourceResults} source result(s).`)
    if (group.reason) console.log(shareOfVoiceReason(group.reason))
    printLandscapeRows('Your brand', [group.project], true, group, queryClass)
    printLandscapeRows('Pinned competitors', group.pinned, true, group, queryClass)
    printLandscapeRows('Observed competitors', group.observed, true, group, queryClass)
    printLandscapeRows('Other cited sources', group.otherSources, true, group, queryClass)
    if (group.truncated) console.log('Top 100 observed competitors and top 100 other sources shown. Pinned competitors are complete.')
  }
}

function printLandscapeRows(
  heading: string,
  rows: readonly CompetitorLandscapeResponse['pinned'][number][],
  showSampleCount = false,
  context?: Partial<ShareOfVoiceContext>,
  queryClass = 'all',
): void {
  console.log(`${heading}:`)
  if (rows.length === 0) {
    console.log('  —')
    return
  }
  for (const row of rows) {
    const sov = `${shareOfVoiceLabel(row.shareOfVoice, context)} · ${queryClass} queries`
    console.log(`  ${row.domain}  mention ${row.mentionCount} · citation ${row.citationCount} · SOV ${sov}${showSampleCount ? ` · answers ${row.answeredResults}` : ''}`)
  }
}
