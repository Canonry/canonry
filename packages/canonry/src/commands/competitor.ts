import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

export async function addCompetitors(project: string, domains: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listCompetitors(project)
  const existingDomains = existing.map(c => c.domain)
  const existingSet = new Set(existingDomains)
  const addedDomains = [...new Set(domains.filter(domain => !existingSet.has(domain)))]
  const current = await client.appendCompetitors(project, domains)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      domains: current.map(c => c.domain),
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
  const existingSet = new Set(existing.map(c => c.domain))
  const removedDomains = [...new Set(domains.filter(domain => existingSet.has(domain)))]
  const current = await client.deleteCompetitors(project, domains)

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
