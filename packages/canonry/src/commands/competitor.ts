import { normalizeCompetitorAliases, normalizeCompetitorDomain, shareOfVoiceLabel, shareOfVoiceReason, type CompetitorDto, type ShareOfVoiceContext } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import type { CompetitorLandscapeQuery, CompetitorLandscapeResponse, ModelEvidenceState } from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

/**
 * `canonry competitor add`. With `aliases` (one domain only), the names are
 * added to that competitor's curated alias list, tracked already or not.
 */
export async function addCompetitors(project: string, domains: string[], format?: string, aliases: string[] = []): Promise<void> {
  const client = getClient()
  const existing = await client.listCompetitors(project)
  const existingDomains = existing.map(c => c.domain)
  const existingSet = new Set(existingDomains)
  // Compare in the stored (registrable) form, so `www.rival.example` counts as
  // the `rival.example` row it creates.
  const requested = new Set(uniqueStrings(domains).map(domain => normalizeCompetitorDomain(domain.trim())))
  const current = await client.appendCompetitors(
    project,
    aliases.length > 0 ? domains.map(domain => ({ domain, aliases })) : domains,
  )
  const currentDomains = current.map(c => c.domain)
  const addedDomains = currentDomains.filter(domain => requested.has(domain) && !existingSet.has(domain))
  const aliasTarget = aliases.length > 0 ? normalizeCompetitorDomain(domains[0]!.trim()) : null
  // Compared in stored form: a row an older build stored as a subdomain is
  // the competitor the aliases were added to.
  const aliasRow = aliasTarget ? current.find(c => normalizeCompetitorDomain(c.domain) === aliasTarget) : undefined

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      domains: currentDomains,
      addedDomains,
      addedCount: addedDomains.length,
      // The aliased competitor as the API returns it (`CompetitorDto`).
      ...(aliasRow ? { competitor: aliasRow } : {}),
    }, null, 2))
    return
  }

  if (addedDomains.length === 0) {
    console.log(`No new competitors added to "${project}" (all already tracked).`)
  } else {
    console.log(`Added ${addedDomains.length} competitor(s) to "${project}".`)
  }
  if (aliasRow) console.log(`Aliases for ${aliasRow.domain}: ${formatAliases(storedAliases(aliasRow))}`)
}

/**
 * A newer CLI can be pointed at an older server that predates the field; its
 * competitors have no aliases. JSON output stays the server's response.
 */
function storedAliases(competitor: CompetitorDto): string[] {
  return (competitor as { aliases?: string[] }).aliases ?? []
}

function formatAliases(aliases: readonly string[]): string {
  return aliases.length > 0 ? aliases.join(', ') : '(none)'
}

function sameAliasName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export interface CompetitorAliasesOptions {
  /** Replace the list exactly. */
  set?: string[]
  /** Append names. */
  add?: string[]
  /** Remove names (case-insensitive). */
  remove?: string[]
  /** Remove every alias. */
  clear?: boolean
  format?: string
}

/**
 * `canonry competitor aliases`. With no change flag it reads the competitor's
 * aliases. `--set` / `--clear` write the exact list. `--add` alone appends
 * server-side in one call (`POST /competitors` with `{ domain, aliases }`), so
 * concurrent adds never overwrite each other. `--remove` reads the list, edits
 * it and writes it back through the exact-set route, so an edit made by
 * another client between that read and write is overwritten. Every write is
 * idempotent (an unchanged list writes nothing server-side).
 */
export async function competitorAliases(project: string, domain: string, options: CompetitorAliasesOptions): Promise<void> {
  const client = getClient()
  let result: CompetitorDto
  if (options.set !== undefined || options.clear === true) {
    result = await client.setCompetitorAliases(project, domain, options.clear ? [] : options.set ?? [])
  } else {
    const target = normalizeCompetitorDomain(domain.trim())
    // Any spelling finds the stored row, including one an older build stored
    // as a subdomain; several rows for one competitor are refused, as the API
    // refuses them, rather than editing one at random.
    const matches = (await client.listCompetitors(project)).filter(c => normalizeCompetitorDomain(c.domain) === target)
    if (matches.length > 1) {
      // The removal discards the rows' curated aliases, so the hint restates
      // them on the add that follows.
      const rows = [...matches].sort((a, b) => a.domain.localeCompare(b.domain))
      const aliases = normalizeCompetitorAliases(rows.flatMap(storedAliases))
      const addAgain = `canonry competitor add ${project} ${target}${aliases.map(alias => ` --alias ${JSON.stringify(alias)}`).join('')}`
      const stored = `${matches.length} rows (${rows.map(c => c.domain).join(', ')})`
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: `Competitor ${target} is stored as ${stored}; remove the competitor (every row goes) and add it again: ${addAgain}`,
        displayMessage: `Error: competitor ${target} is stored as ${stored}. Remove it with: canonry competitor remove ${project} ${target}, then add it again with: ${addAgain}`,
        details: { project, domain: target, matches: rows.map(c => ({ id: c.id, domain: c.domain })), aliases },
      })
    }
    const current = matches.at(0)
    if (!current) {
      throw new CliError({
        code: 'NOT_FOUND',
        message: `Competitor "${target}" is not tracked by project "${project}"`,
        displayMessage: `Error: competitor "${target}" is not tracked by "${project}". Add it with: canonry competitor add ${project} ${target}`,
        details: { project, domain: target },
      })
    }
    const removed = options.remove ?? []
    const added = options.add ?? []
    if (added.length === 0 && removed.length === 0) {
      result = current
    } else if (removed.length === 0) {
      const listed = await client.appendCompetitors(project, [{ domain: current.domain, aliases: added }])
      result = listed.find(c => c.domain === current.domain) ?? current
    } else {
      const next = [
        ...storedAliases(current).filter(alias => !removed.some(name => sameAliasName(name, alias))),
        ...added,
      ]
      result = await client.setCompetitorAliases(project, current.domain, next)
    }
  }

  if (isMachineFormat(options.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Aliases for ${result.domain}: ${formatAliases(storedAliases(result))}`)
}

export async function removeCompetitors(project: string, domains: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listCompetitors(project)
  const existingDomains = existing.map(c => c.domain)
  // The server removes every stored row that is a requested competitor in any
  // spelling (`www.`, a subdomain, or a row stored as a subdomain).
  const requested = new Set(uniqueStrings(domains).map(domain => normalizeCompetitorDomain(domain.trim())))
  const current = await client.deleteCompetitors(project, domains)
  const currentSet = new Set(current.map(c => c.domain))
  const removedDomains = existingDomains.filter(domain => requested.has(normalizeCompetitorDomain(domain)) && !currentSet.has(domain))

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
    const aliases = storedAliases(c)
    console.log(aliases.length > 0 ? `  ${c.domain}  (aliases: ${aliases.join(', ')})` : `  ${c.domain}`)
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
    const total = data.observedNamesTotal ?? data.observedNames.length
    console.log(total > data.observedNames.length
      ? `Names observed in answers (not a comparison set), top ${data.observedNames.length} of ${total}:`
      : 'Names observed in answers (not a comparison set):')
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
