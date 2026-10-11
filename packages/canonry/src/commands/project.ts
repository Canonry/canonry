import type { CompetitorAutoAliasMode, MeasurementConfig, ProjectDto, ProjectPatchRequest, ProjectUpsertRequest, ProviderDispatchModesMap } from '@ainyc/canonry-contracts'
import { DEFAULT_MEASUREMENT_CONFIG, effectiveDomains, measurementConfigSchema, normalizeProjectAliases, resolveNegativeReviewMaxStars, formatSiteAuditPageBudget, resolveProjectQualifiedAliases } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isEndpointMissing, isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

export interface MeasurementUpdateFlags {
  leadEvents?: string[]
  addLeadEvents?: string[]
  removeLeadEvents?: string[]
  brandTerms?: string[]
  addBrandTerms?: string[]
  removeBrandTerms?: string[]
  marketingHosts?: string[]
  addMarketingHosts?: string[]
  removeMarketingHosts?: string[]
}

export async function createProject(
  name: string,
  opts: { domain: string; ownedDomains?: string[]; aliases?: string[]; qualifiedAliases?: string[]; country: string; language: string; displayName: string; providers?: string[]; providerModels?: Record<string, string>; providerDispatchModes?: ProviderDispatchModesMap; siteAuditMaxPages?: number | null; format?: string },
): Promise<void> {
  const client = getClient()
  const result: ProjectDto = await client.putProject(name, {
    displayName: opts.displayName,
    canonicalDomain: opts.domain,
    ownedDomains: opts.ownedDomains ?? [],
    aliases: normalizeProjectAliases(opts.displayName, opts.aliases ?? []),
    ...(opts.qualifiedAliases?.length ? { qualifiedAliases: opts.qualifiedAliases } : {}),
    country: opts.country,
    language: opts.language,
    providers: opts.providers ?? [],
    providerModels: opts.providerModels ?? {},
    ...(opts.providerDispatchModes && Object.keys(opts.providerDispatchModes).length > 0
      ? { providerDispatchModes: opts.providerDispatchModes }
      : {}),
    // Sent only when given: this PUT also re-runs over an existing project,
    // and an omitted budget keeps the stored one.
    ...(opts.siteAuditMaxPages !== undefined ? { siteAuditMaxPages: opts.siteAuditMaxPages } : {}),
  })

  warnDroppedDispatchModes(opts.providerDispatchModes ?? {}, result)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Project created: ${result.name} (${result.id})`)
}

/**
 * The server keeps a dispatch preference only for an engine the project's runs
 * measure, and prunes the rest. Name what it dropped on stderr in BOTH formats:
 * whoever asked for batch must not read a plain success, and stdout's JSON
 * stays the API response byte for byte.
 */
function warnDroppedDispatchModes(sent: ProviderDispatchModesMap, result: ProjectDto): void {
  const kept = result.providerDispatchModes ?? {}
  const dropped = Object.keys(sent).filter(provider => !(provider in kept))
  if (dropped.length > 0) {
    console.error(`Warning: Dropped dispatch mode for engine(s) the project does not measure: ${dropped.join(', ')}`)
  }
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

/** A newer CLI can be pointed at an older server that predates the field. */
function storedQualifiedAliases(project: ProjectDto): string[] {
  return (project as { qualifiedAliases?: string[] }).qualifiedAliases ?? []
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
  const qualifiedAliases = storedQualifiedAliases(project)
  if (qualifiedAliases.length > 0) {
    console.log(`  Qualified:        ${qualifiedAliases.join(', ')} (sentiment)`)
  }
  console.log(`  Country:          ${project.country}`)
  console.log(`  Language:         ${project.language}`)
  console.log(`  Config source:    ${project.configSource}`)
  console.log(`  Config revision:  ${project.configRevision}`)
  console.log(`  Providers:        ${(project.providers ?? []).length > 0 ? project.providers.join(', ') : 'all configured'}`)
  const providerModels = Object.entries(project.providerModels ?? {})
  console.log(`  Model overrides:  ${providerModels.length > 0 ? providerModels.map(([provider, model]) => `${provider}=${model}`).join(', ') : '(none; instance settings inherited)'}`)
  const dispatchModes = Object.entries(project.providerDispatchModes ?? {}).sort(([left], [right]) => left.localeCompare(right))
  console.log(`  Dispatch modes:   ${dispatchModes.length > 0 ? `${dispatchModes.map(([provider, mode]) => `${provider}=${mode}`).join(', ')} (scheduled sweeps; others sync)` : '(none; every provider runs sync)'}`)
  console.log(`  Negative reviews: ${resolveNegativeReviewMaxStars(project.negativeReviewMaxStars)} stars or fewer${project.negativeReviewMaxStars == null ? ' (default)' : ''}`)
  // Absent only from a server that predates the saved budget: say nothing rather than guess.
  if (project.siteAuditMaxPages !== undefined) {
    console.log(`  Site Health page budget: ${formatSiteAuditPageBudget(project.siteAuditMaxPages)}`)
  }
  // Absent only from a server that predates the setting.
  if (project.competitorAutoAliases !== undefined) {
    console.log(`  Competitor auto aliases: ${formatCompetitorAutoAliasMode(project.competitorAutoAliases)}`)
  }
  if (project.measurement) {
    console.log(`  Marketing hosts:  ${project.measurement.marketingHosts.length > 0 ? project.measurement.marketingHosts.join(', ') : '(none)'}`)
    console.log(`  Brand terms:      ${project.measurement.brandTerms.length > 0 ? project.measurement.brandTerms.join(', ') : '(none)'}`)
    console.log(`  Lead events:      ${project.measurement.leadEventNames.length > 0 ? project.measurement.leadEventNames.join(', ') : '(none)'}`)
  }
  console.log(`  Tags:             ${project.tags.length > 0 ? project.tags.join(', ') : '(none)'}`)
  const labelEntries = Object.entries(project.labels)
  console.log(`  Labels:           ${labelEntries.length > 0 ? labelEntries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`)
  if (project.createdAt) console.log(`  Created:          ${project.createdAt}`)
  if (project.updatedAt) console.log(`  Updated:          ${project.updatedAt}`)
}

function formatCompetitorAutoAliasMode(mode: CompetitorAutoAliasMode): string {
  if (mode === 'apply') return 'apply (names detected after each sweep are stored and counted)'
  if (mode === 'off') return 'off (no detection after sweeps)'
  return 'preview (detected after each sweep and logged; nothing stored)'
}

function mergeMeasurementList(
  current: readonly string[],
  exact: string[] | undefined,
  additions: string[] | undefined,
  removals: string[] | undefined,
  caseInsensitive: boolean,
): string[] {
  let values = [...(exact ?? current)]
  if (additions) values.push(...additions)
  if (removals?.length) {
    const remove = new Set(removals.map(value => caseInsensitive ? value.toLowerCase() : value))
    values = values.filter(value => !remove.has(caseInsensitive ? value.toLowerCase() : value))
  }
  return values
}

function resolveMeasurementUpdate(project: ProjectDto, flags: MeasurementUpdateFlags): MeasurementConfig {
  const current = project.measurement ?? DEFAULT_MEASUREMENT_CONFIG
  const parsed = measurementConfigSchema.safeParse({
    marketingHosts: mergeMeasurementList(current.marketingHosts, flags.marketingHosts, flags.addMarketingHosts, flags.removeMarketingHosts, true),
    brandTerms: mergeMeasurementList(current.brandTerms, flags.brandTerms, flags.addBrandTerms, flags.removeBrandTerms, true),
    leadEventNames: mergeMeasurementList(current.leadEventNames, flags.leadEvents, flags.addLeadEvents, flags.removeLeadEvents, false),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw usageError(`Error: invalid measurement option${issue?.message ? `: ${issue.message}` : ''}`, {
      message: issue?.message ?? 'invalid measurement option',
      details: { command: 'project.update', path: issue?.path.join('.') ?? '' },
    })
  }
  return parsed.data
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
    addQualifiedAlias?: string[]
    removeQualifiedAlias?: string[]
    country?: string
    language?: string
    providers?: string[]
    providerModels?: Record<string, string>
    clearProviderModels?: string[]
    dispatchModes?: ProviderDispatchModesMap
    clearDispatchModes?: string[]
    /** 1-4 sets the negative-review threshold, null resets it to the default of 3, undefined leaves it. */
    negativeReviewMaxStars?: number | null
    /** 1-50,000 sets the Site Health page budget, null means the full site, undefined leaves it. */
    siteAuditMaxPages?: number | null
    /** Sets the answer-derived competitor alias detection mode; undefined leaves it. */
    competitorAutoAliases?: CompetitorAutoAliasMode
    expectedConfigRevision?: number
    /** Measurement lists changed by one or more measurement flags. */
    measurement?: MeasurementUpdateFlags
    format?: string
  },
): Promise<void> {
  const client = getClient()
  const project: ProjectDto = await client.getProject(name)
  if (opts.expectedConfigRevision !== undefined && opts.expectedConfigRevision !== project.configRevision) {
    throw new CliError({
      code: 'PROJECT_REVISION_CONFLICT',
      message: `Project '${name}' has revision ${project.configRevision}, not the expected ${opts.expectedConfigRevision}.`,
      details: { expected: opts.expectedConfigRevision, actual: project.configRevision },
    })
  }

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
  const nextAliases = normalizeProjectAliases(nextDisplayName, aliases)

  // Sent only when a qualified-alias flag was given; an omitted list keeps the
  // stored one server-side. Unlike the model and dispatch maps below, the
  // stored list IS filtered here, by the rule the server applies only when the
  // field is omitted: echoing a name that `--remove-alias` just dropped, or
  // that `--display-name` now spells, would turn this edit into a 400. The
  // server keeps the stored list clear of competitor names on its own.
  const touchesQualified = (opts.addQualifiedAlias?.length ?? 0) > 0 || (opts.removeQualifiedAlias?.length ?? 0) > 0
  let qualifiedAliases = resolveProjectQualifiedAliases(
    { displayName: nextDisplayName, aliases: nextAliases },
    storedQualifiedAliases(project),
  ).value
  if (opts.addQualifiedAlias) {
    const existingKeys = new Set(qualifiedAliases.map(alias => alias.toLowerCase()))
    for (const alias of opts.addQualifiedAlias) {
      if (existingKeys.has(alias.toLowerCase())) continue
      existingKeys.add(alias.toLowerCase())
      qualifiedAliases = [...qualifiedAliases, alias]
    }
  }
  if (opts.removeQualifiedAlias) {
    const toRemove = new Set(opts.removeQualifiedAlias.map(alias => alias.toLowerCase()))
    qualifiedAliases = qualifiedAliases.filter(alias => !toRemove.has(alias.toLowerCase()))
  }
  const providerModels = { ...(project.providerModels ?? {}), ...(opts.providerModels ?? {}) }
  for (const provider of opts.clearProviderModels ?? []) delete providerModels[provider]
  // Two flags in the SAME invocation that contradict each other are a usage
  // error: the operator explicitly typed a model for an engine this command
  // does not select. Rejecting it before the request keeps a value the operator
  // typed from being silently pruned server-side.
  //
  // Nothing else is filtered here. The stored map is echoed back untouched and
  // the API normalizes it against the incoming engine set — one implementation,
  // one semantics. Stripping it client-side too would put the same rule in two
  // places, and the CLI cannot know what the server will keep.
  const nextProviders = opts.providers ?? project.providers ?? []
  if (nextProviders.length > 0) {
    const requested = Object.keys(opts.providerModels ?? {}).filter(p => !nextProviders.includes(p))
    if (requested.length > 0) {
      throw usageError(
        `Error: --provider-model set for ${requested.join(', ')}, which ${requested.length > 1 ? 'are' : 'is'} not a selected engine for "${name}"`,
        {
          message: 'provider-model set for a provider the project does not run',
          details: { command: 'project.update', project: name, providers: nextProviders, unselected: requested },
        },
      )
    }
  }

  // Sent only when a dispatch flag was given: the server keeps the stored
  // preference when the field is omitted, so an unrelated edit never races a
  // change made elsewhere.
  const touchesDispatch = Object.keys(opts.dispatchModes ?? {}).length > 0 || (opts.clearDispatchModes ?? []).length > 0
  const providerDispatchModes: ProviderDispatchModesMap = { ...(project.providerDispatchModes ?? {}), ...(opts.dispatchModes ?? {}) }
  for (const provider of opts.clearDispatchModes ?? []) delete providerDispatchModes[provider]

  const patch: ProjectPatchRequest = {
    expectedConfigRevision: opts.expectedConfigRevision ?? project.configRevision,
    ...(opts.displayName !== undefined ? { displayName: nextDisplayName } : {}),
    ...(opts.domain !== undefined ? { canonicalDomain: opts.domain } : {}),
    ...((opts.ownedDomains !== undefined || opts.addOwnedDomain !== undefined || opts.removeOwnedDomain !== undefined) ? { ownedDomains } : {}),
    ...((opts.aliases !== undefined || opts.addAlias !== undefined || opts.removeAlias !== undefined) ? { aliases: nextAliases } : {}),
    ...(opts.country !== undefined ? { country: opts.country } : {}),
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
    ...((Object.keys(opts.providerModels ?? {}).length > 0 || (opts.clearProviderModels?.length ?? 0) > 0) ? { providerModels } : {}),
    ...(touchesQualified ? { qualifiedAliases } : {}),
    ...(touchesDispatch ? { providerDispatchModes } : {}),
    ...(opts.negativeReviewMaxStars !== undefined ? { negativeReviewMaxStars: opts.negativeReviewMaxStars } : {}),
    ...(opts.siteAuditMaxPages !== undefined ? { siteAuditMaxPages: opts.siteAuditMaxPages } : {}),
    ...(opts.competitorAutoAliases !== undefined ? { competitorAutoAliases: opts.competitorAutoAliases } : {}),
    ...(opts.measurement !== undefined ? { measurement: resolveMeasurementUpdate(project, opts.measurement) } : {}),
  }
  let result: ProjectDto
  try {
    result = await client.patchProject(name, patch)
  } catch (error) {
    // A route-specific 404 or 405 from PATCH identifies an older server whose
    // API predates PATCH. Preserve the historical full PUT path only for that
    // transport case; application NOT_FOUND responses must propagate.
    if (!(error instanceof CliError) || !isEndpointMissing(error) || !/route/i.test(error.message)) throw error
    let latest: ProjectDto
    try {
      // Re-read before the legacy request so a changed project is rejected.
      // The legacy GET followed by PUT has no server-side compare-and-swap;
      // callers still receive the historical fallback semantics after this
      // best-effort race check.
      latest = await client.getProject(name)
    } catch (readError) {
      throw readError
    }
    if (latest.configRevision !== project.configRevision) {
      throw new CliError({
        code: 'PROJECT_REVISION_CONFLICT',
        message: `Project '${name}' changed while the PATCH endpoint was unavailable. Re-read it and retry.`,
        details: { expected: project.configRevision, actual: latest.configRevision },
      })
    }
    const legacyBody: ProjectUpsertRequest = {
      displayName: nextDisplayName,
      canonicalDomain: opts.domain ?? project.canonicalDomain,
      ownedDomains,
      aliases: nextAliases,
      ...(touchesQualified ? { qualifiedAliases } : {}),
      country: opts.country ?? project.country,
      language: opts.language ?? project.language,
      tags: project.tags,
      labels: project.labels,
      providers: opts.providers ?? project.providers,
      providerModels,
      ...(touchesDispatch ? { providerDispatchModes } : {}),
      locations: project.locations,
      defaultLocation: project.defaultLocation,
      autoExtractBacklinks: project.autoExtractBacklinks,
      ...(opts.negativeReviewMaxStars !== undefined ? { negativeReviewMaxStars: opts.negativeReviewMaxStars } : {}),
      ...(opts.siteAuditMaxPages !== undefined ? { siteAuditMaxPages: opts.siteAuditMaxPages } : {}),
      ...(opts.competitorAutoAliases !== undefined ? { competitorAutoAliases: opts.competitorAutoAliases } : {}),
      ...(opts.measurement !== undefined ? { measurement: resolveMeasurementUpdate(project, opts.measurement) } : {}),
    }
    result = await client.putProject(name, legacyBody)
  }

  // What the server was left holding: the map sent, else the stored one.
  warnDroppedDispatchModes(touchesDispatch ? providerDispatchModes : (project.providerDispatchModes ?? {}), result)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Project updated: ${result.name}`)
  // The server prunes overrides for engines the project no longer runs. Say so
  // — the response is the record of what was persisted, and an operator who
  // narrowed the engine set should not have to diff it by hand.
  const dropped = Object.keys(providerModels).filter(provider => !(provider in result.providerModels))
  if (dropped.length > 0) {
    console.log(`  Dropped model override for deselected engine(s): ${dropped.join(', ')}`)
  }
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
