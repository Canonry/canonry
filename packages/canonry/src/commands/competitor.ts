import { createApiClient } from '../client.js'

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

  if (format === 'json') {
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

  if (format === 'json') {
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
