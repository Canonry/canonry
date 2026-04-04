import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

export async function addCompetitors(project: string, domains: string[], format?: string): Promise<void> {
  // First get existing competitors, then put the combined list
  const client = getClient()
  const existing = await client.listCompetitors(project) as Array<{ domain: string }>
  const existingDomains = existing.map(c => c.domain)
  const addedDomains = domains.filter(domain => !existingDomains.includes(domain))
  const allDomains = [...new Set([...existingDomains, ...domains])]
  await client.putCompetitors(project, allDomains)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      domains: allDomains,
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

export async function listCompetitors(project: string, format?: string): Promise<void> {
  const client = getClient()
  const comps = await client.listCompetitors(project) as Array<{
    id: string
    domain: string
    createdAt: string
  }>

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
