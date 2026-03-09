import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function createProject(
  name: string,
  opts: { domain: string; country: string; language: string; displayName: string },
): Promise<void> {
  const client = getClient()
  const result = await client.putProject(name, {
    displayName: opts.displayName,
    canonicalDomain: opts.domain,
    country: opts.country,
    language: opts.language,
  }) as { id: string; name: string }
  console.log(`Project created: ${result.name} (${result.id})`)
}

export async function listProjects(): Promise<void> {
  const client = getClient()
  const projects = await client.listProjects() as Array<{
    name: string
    canonicalDomain: string
    country: string
    language: string
  }>

  if (projects.length === 0) {
    console.log('No projects found.')
    return
  }

  console.log('Projects:\n')
  const nameWidth = Math.max(4, ...projects.map(p => p.name.length))
  const domainWidth = Math.max(6, ...projects.map(p => p.canonicalDomain.length))

  console.log(
    `  ${'NAME'.padEnd(nameWidth)}  ${'DOMAIN'.padEnd(domainWidth)}  COUNTRY  LANGUAGE`,
  )
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(domainWidth)}  ───────  ────────`)

  for (const p of projects) {
    console.log(
      `  ${p.name.padEnd(nameWidth)}  ${p.canonicalDomain.padEnd(domainWidth)}  ${p.country.padEnd(7)}  ${p.language}`,
    )
  }
}

export async function showProject(name: string): Promise<void> {
  const client = getClient()
  const project = await client.getProject(name) as {
    id: string
    name: string
    displayName: string
    canonicalDomain: string
    country: string
    language: string
    tags: string[]
    labels: Record<string, string>
    configSource: string
    configRevision: number
    createdAt: string
    updatedAt: string
  }

  console.log(`Project: ${project.displayName}\n`)
  console.log(`  Name:             ${project.name}`)
  console.log(`  ID:               ${project.id}`)
  console.log(`  Domain:           ${project.canonicalDomain}`)
  console.log(`  Country:          ${project.country}`)
  console.log(`  Language:         ${project.language}`)
  console.log(`  Config source:    ${project.configSource}`)
  console.log(`  Config revision:  ${project.configRevision}`)
  console.log(`  Tags:             ${project.tags.length > 0 ? project.tags.join(', ') : '(none)'}`)
  const labelEntries = Object.entries(project.labels)
  console.log(`  Labels:           ${labelEntries.length > 0 ? labelEntries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`)
  console.log(`  Created:          ${project.createdAt}`)
  console.log(`  Updated:          ${project.updatedAt}`)
}

export async function deleteProject(name: string): Promise<void> {
  const client = getClient()
  await client.deleteProject(name)
  console.log(`Project deleted: ${name}`)
}
