import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  isEligibleFor,
  isSweepProvider,
  measurementDraftProviderNames,
  ProviderConnectionUsageSources,
  ProviderWorkflows,
  routeConnectionName,
  routeFamiliesOf,
  RunKinds,
  type ProviderConnectionConfigDto,
  type ProviderConnectionSettingsDto,
  type ProviderConnectionUsageSource,
} from '@canonry/canonry-contracts'
import { measurementPlanDrafts, projects, schedules, type DatabaseClient } from '@canonry/canonry-db'
import { parseStoredAuthoring } from './measurement-draft-repo.js'
import { activeRevisionProviders } from './run-queue.js'
import type { ProviderAdapterInfo } from './settings.js'

type Usage = ProviderConnectionSettingsDto['usage']

/** A stored plan's or draft's provider names, or null when it cannot be read. */
function readSavedProviders(read: () => readonly string[]): readonly string[] | null {
  try {
    return read()
  } catch {
    // One project's unreadable plan or draft leaves only that project's usage unknown.
    return null
  }
}

/** Saved dependencies only: disconnect never rewrites a project, draft, plan, schedule, or historical answer. */
export function providerConnectionSettings(
  db: DatabaseClient,
  connections: readonly ProviderConnectionConfigDto[],
  adapters: readonly ProviderAdapterInfo[],
): ProviderConnectionSettingsDto[] {
  const families = routeFamiliesOf(adapters)
  const implicit = connections.filter(connection => connection.configured && isSweepProvider(connection.name, families)
    && isEligibleFor({ kind: connection.kind }, ProviderWorkflows['visibility-sweep'], 'implicit')).map(connection => connection.name)
  const savedSchedules = db.select().from(schedules).where(eq(schedules.kind, RunKinds['answer-visibility'])).all()
  const savedDrafts = new Map(db.select().from(measurementPlanDrafts).all().map(draft => [draft.projectId, draft.authoringJson]))
  const references = db.select().from(projects).all().map(project => {
    const planProviders = readSavedProviders(() => activeRevisionProviders(db, project.id))
    const projectProviders = project.providers.length > 0 ? project.providers : implicit
    const entries: Array<{ source: ProviderConnectionUsageSource; providers: readonly string[] }> = [
      { source: ProviderConnectionUsageSources.project, providers: projectProviders },
    ]
    const unknown: ProviderConnectionUsageSource[] = []
    const projectSchedules = savedSchedules.filter(row => row.projectId === project.id)
    if (planProviders) {
      entries.push({ source: ProviderConnectionUsageSources['measurement-plan'], providers: planProviders })
      for (const schedule of projectSchedules) {
        const selected = schedule.providers
        entries.push({ source: ProviderConnectionUsageSources.schedule, providers: planProviders.length > 0 ? planProviders : selected.length > 0 ? selected : projectProviders })
      }
    } else {
      // A published plan's providers replace a schedule's own selection, so its schedules are unknown too.
      unknown.push(ProviderConnectionUsageSources['measurement-plan'])
      if (projectSchedules.length > 0) unknown.push(ProviderConnectionUsageSources.schedule)
    }
    const authoring = savedDrafts.get(project.id)
    if (authoring !== undefined) {
      const draftProviders = readSavedProviders(() => measurementDraftProviderNames(parseStoredAuthoring(authoring)))
      if (draftProviders) entries.push({ source: ProviderConnectionUsageSources['measurement-draft'], providers: draftProviders })
      else unknown.push(ProviderConnectionUsageSources['measurement-draft'])
    }
    return { name: project.name, displayName: project.displayName, entries, unknown: unknown.sort() }
  })
  // Any connection may be named in an unreadable plan or draft, so each one reports the same unknown projects.
  const unknownProjects = references.filter(project => project.unknown.length > 0)
    .map(project => ({ name: project.name, displayName: project.displayName, sources: project.unknown }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return connections.map(connection => {
    const usedBy = references.flatMap(project => {
      const entries = project.entries.map(entry => ({ ...entry, providers: entry.providers.filter(provider => routeConnectionName(provider, families) === connection.name) }))
        .filter(entry => entry.providers.length > 0)
      if (entries.length === 0) return []
      return [{
        name: project.name, displayName: project.displayName,
        providers: [...new Set(entries.flatMap(entry => entry.providers))].sort(),
        sources: [...new Set(entries.map(entry => entry.source))].sort(),
      }]
    }).sort((a, b) => a.name.localeCompare(b.name))
    const usage: Usage = {
      projectCount: usedBy.length,
      projects: usedBy,
      ...(unknownProjects.length > 0 ? { unknown: { projectCount: unknownProjects.length, projects: unknownProjects } } : {}),
    }
    const impactRevision = crypto.createHash('sha256').update(JSON.stringify({ revision: connection.revision, usage, hostUses: connection.hostUses, blockers: connection.blockers })).digest('hex')
    return { ...connection, usage, impactRevision }
  })
}
