import type { ProjectDto } from '@ainyc/canonry-contracts'
import { effectiveDomains, normalizeProjectAliases } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

export async function createProject(
  name: string,
  opts: { domain: string; ownedDomains?: string[]; aliases?: string[]; country: string; language: string; displayName: string; providers?: string[]; providerModels?: Record<string, string>; format?: string },
): Promise<void> {
  const client = getClient()
  const result: ProjectDto = await client.putProject(name, {
    displayName: opts.displayName,
    canonicalDomain: opts.domain,
    ownedDomains: opts.ownedDomains ?? [],
    aliases: normalizeProjectAliases(opts.displayName, opts.aliases ?? []),
    country: opts.country,
    language: opts.language,
    providers: opts.providers ?? [],
    providerModels: opts.providerModels ?? {},
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Project created: ${result.name} (${result.id})`)
}

export async function listProjects(format?: string): Promise<void> {
  const client = getClient()
  const projects: ProjectDto[] = await client.listProjects()

  if (format === 'json') {
    console.log(JSON.stringify(projects, null, 2))
    return
  }

  if (format === 'jsonl') {
    // Global command — each project already self-identifies via name/id, so
    // records emit bare with no envelope tag to prepend.
    emitJsonl(projects)
    return
  }

  if (projects.length === 0) {
    console.log('No projects found.')
    return
  }

  console.log('Projects:\n')
  const nameWidth = Math.max(4, ...projects.map(p => p.name.length))
  const domainLabel = (p: { canonicalDomain: string; ownedDomains?: string[] }) => {
    const extra = Math.max(0, effectiveDomains(p).length - 1)
    return extra > 0 ? `${p.canonicalDomain} (+${extra})` : p.canonicalDomain
  }
  const domainWidth = Math.max(6, ...projects.map(p => domainLabel(p).length))

  console.log(
    `  ${'NAME'.padEnd(nameWidth)}  ${'DOMAIN'.padEnd(domainWidth)}  COUNTRY  LANGUAGE`,
  )
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(domainWidth)}  ───────  ────────`)

  for (const p of projects) {
    console.log(
      `  ${p.name.padEnd(nameWidth)}  ${domainLabel(p).padEnd(domainWidth)}  ${p.country.padEnd(7)}  ${p.language}`,
    )
  }
}

export async function showProject(name: string, format?: string): Promise<void> {
  const client = getClient()
  const project: ProjectDto = await client.getProject(name)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(project, null, 2))
    return
  }

  console.log(`Project: ${project.displayName ?? project.name}\n`)
  console.log(`  Name:             ${project.name}`)
  console.log(`  ID:               ${project.id}`)
  console.log(`  Domain:           ${project.canonicalDomain}`)
  const secondaryDomains = effectiveDomains(project).slice(1)
  if (secondaryDomains.length > 0) {
    console.log(`  Owned domains:    ${secondaryDomains.join(', ')}`)
  }
  if (project.aliases && project.aliases.length > 0) {
    console.log(`  Aliases:          ${project.aliases.join(', ')}`)
  }
  console.log(`  Country:          ${project.country}`)
  console.log(`  Language:         ${project.language}`)
  console.log(`  Config source:    ${project.configSource}`)
  console.log(`  Config revision:  ${project.configRevision}`)
  console.log(`  Providers:        ${(project.providers ?? []).length > 0 ? project.providers.join(', ') : 'all configured'}`)
  const providerModels = Object.entries(project.providerModels ?? {})
  console.log(`  Model overrides:  ${providerModels.length > 0 ? providerModels.map(([provider, model]) => `${provider}=${model}`).join(', ') : '(none; instance settings inherited)'}`)
  console.log(`  Tags:             ${project.tags.length > 0 ? project.tags.join(', ') : '(none)'}`)
  const labelEntries = Object.entries(project.labels)
  console.log(`  Labels:           ${labelEntries.length > 0 ? labelEntries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`)
  if (project.createdAt) console.log(`  Created:          ${project.createdAt}`)
  if (project.updatedAt) console.log(`  Updated:          ${project.updatedAt}`)
}

export async function updateProjectSettings(
  name: string,
  opts: {
    displayName?: string
    domain?: string
    ownedDomains?: string[]
    addOwnedDomain?: string[]
    removeOwnedDomain?: string[]
    aliases?: string[]
    addAlias?: string[]
    removeAlias?: string[]
    country?: string
    language?: string
    providers?: string[]
    providerModels?: Record<string, string>
    clearProviderModels?: string[]
    format?: string
  },
): Promise<void> {
  const client = getClient()
  const project: ProjectDto = await client.getProject(name)

  let ownedDomains = opts.ownedDomains ?? project.ownedDomains ?? []
  if (opts.addOwnedDomain) {
    const toAdd = opts.addOwnedDomain.filter(d => !ownedDomains.includes(d))
    ownedDomains = [...ownedDomains, ...toAdd]
  }
  if (opts.removeOwnedDomain) {
    const toRemove = new Set(opts.removeOwnedDomain)
    ownedDomains = ownedDomains.filter(d => !toRemove.has(d))
  }

  const nextDisplayName = opts.displayName ?? project.displayName ?? project.name
  let aliases = opts.aliases ?? project.aliases ?? []
  if (opts.addAlias) {
    const existingKeys = new Set(aliases.map(a => a.toLowerCase()))
    const toAdd = opts.addAlias.filter(a => !existingKeys.has(a.toLowerCase()))
    aliases = [...aliases, ...toAdd]
  }
  if (opts.removeAlias) {
    const toRemove = new Set(opts.removeAlias.map(a => a.toLowerCase()))
    aliases = aliases.filter(a => !toRemove.has(a.toLowerCase()))
  }
  const providerModels = { ...(project.providerModels ?? {}), ...(opts.providerModels ?? {}) }
  for (const provider of opts.clearProviderModels ?? []) delete providerModels[provider]

  const result: ProjectDto = await client.putProject(name, {
    displayName: nextDisplayName,
    canonicalDomain: opts.domain ?? project.canonicalDomain,
    ownedDomains,
    aliases: normalizeProjectAliases(nextDisplayName, aliases),
    country: opts.country ?? project.country,
    language: opts.language ?? project.language,
    tags: project.tags,
    labels: project.labels,
    providers: opts.providers ?? project.providers,
    providerModels,
    locations: project.locations,
    defaultLocation: project.defaultLocation,
    autoExtractBacklinks: project.autoExtractBacklinks,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Project updated: ${result.name}`)
}

export async function deleteProject(name: string, opts?: { dryRun?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const isJson = isMachineFormat(opts?.format)

  if (opts?.dryRun) {
    const preview = await client.previewProjectDelete(name)
    if (isJson) {
      console.log(JSON.stringify({ dryRun: true, ...preview }, null, 2))
      return
    }
    const { cascadeRows: cr, detachedRows: dr } = preview
    console.log(`Project delete preview for "${name}":`)
    console.log(`  Cascade-deletes:`)
    console.log(`    queries:      ${cr.queries}`)
    console.log(`    competitors:  ${cr.competitors}`)
    console.log(`    runs:         ${cr.runs}`)
    console.log(`    snapshots:    ${cr.snapshots}`)
    console.log(`    insights:     ${cr.insights}`)
    console.log(`  Detached (project_id set to NULL):`)
    console.log(`    audit_log:    ${dr.auditLog}`)
    console.log(``)
    console.log(`No DB writes performed. Re-run without --dry-run to delete.`)
    return
  }

  await client.deleteProject(name)

  if (isJson) {
    console.log(JSON.stringify({ name, deleted: true }, null, 2))
    return
  }

  console.log(`Project deleted: ${name}`)
}

export async function addLocation(
  project: string,
  opts: { label: string; city: string; region: string; country: string; timezone?: string; format?: string },
): Promise<void> {
  const client = getClient()
  const location = await client.addLocation(project, {
    label: opts.label,
    city: opts.city,
    region: opts.region,
    country: opts.country,
    timezone: opts.timezone,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(location, null, 2))
    return
  }

  console.log(`Location added: ${opts.label} (${opts.city}, ${opts.region}, ${opts.country})`)
}

export async function listLocations(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.listLocations(project)

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (format === 'jsonl') {
    // Project-scoped — prepend the `project` tag the line loses by leaving the
    // envelope, plus `isDefault` derived from the envelope's default marker so
    // the default location stays identifiable per line. Spread the location
    // record last so its own fields win.
    emitJsonl(result.locations.map(loc => ({
      project,
      isDefault: loc.label === result.defaultLocation,
      ...loc,
    })))
    return
  }

  if (result.locations.length === 0) {
    console.log(`No locations configured for "${project}".`)
    return
  }

  console.log(`Locations for "${project}" (${result.locations.length}):\n`)
  console.log('  LABEL            CITY                 REGION               COUNTRY  DEFAULT')
  console.log('  ───────────────  ───────────────────  ───────────────────  ───────  ───────')

  for (const loc of result.locations) {
    const isDefault = loc.label === result.defaultLocation ? '  *' : ''
    console.log(
      `  ${loc.label.padEnd(15)}  ${loc.city.padEnd(19)}  ${loc.region.padEnd(19)}  ${loc.country.padEnd(7)}${isDefault}`,
    )
  }

  if (result.defaultLocation) {
    console.log(`\n  Default: ${result.defaultLocation}`)
  }
}

export async function removeLocation(project: string, label: string, format?: string): Promise<void> {
  const client = getClient()
  await client.removeLocation(project, label)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, label, removed: true }, null, 2))
    return
  }

  console.log(`Location removed: ${label}`)
}

export async function setDefaultLocation(project: string, label: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.setDefaultLocation(project, label)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, ...result }, null, 2))
    return
  }

  console.log(`Default location set to: ${label}`)
}
