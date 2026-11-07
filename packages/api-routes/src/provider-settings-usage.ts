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
} from '@canonry/canonry-contracts'
import { measurementPlanDrafts, projects, schedules, type DatabaseClient } from '@canonry/canonry-db'
import { parseStoredAuthoring } from './measurement-draft-repo.js'
import { activeRevisionProviders } from './run-queue.js'
import type { ProviderAdapterInfo } from './settings.js'

type Usage = ProviderConnectionSettingsDto['usage']
type UsageSource = Usage['projects'][number]['sources'][number]

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
  const savedDrafts = new Map(db.select().from(measurementPlanDrafts).all().map(draft => [draft.projectId, parseStoredAuthoring(draft.authoringJson)]))
  const references = db.select().from(projects).all().map(project => {
    const planProviders = activeRevisionProviders(db, project.id)
    const projectProviders = project.providers.length > 0 ? project.providers : implicit
    const entries: Array<{ source: UsageSource; providers: readonly string[] }> = [
      { source: ProviderConnectionUsageSources.project, providers: projectProviders },
      { source: ProviderConnectionUsageSources['measurement-plan'], providers: planProviders },
    ]
    for (const schedule of savedSchedules.filter(row => row.projectId === project.id)) {
      const selected = schedule.providers
      entries.push({ source: ProviderConnectionUsageSources.schedule, providers: planProviders.length > 0 ? planProviders : selected.length > 0 ? selected : projectProviders })
    }
    const draft = savedDrafts.get(project.id)
    if (draft) entries.push({ source: ProviderConnectionUsageSources['measurement-draft'], providers: measurementDraftProviderNames(draft) })
    return { name: project.name, displayName: project.displayName, entries }
  })
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
    const usage: Usage = { projectCount: usedBy.length, projects: usedBy }
    const impactRevision = crypto.createHash('sha256').update(JSON.stringify({ revision: connection.revision, usage, hostUses: connection.hostUses, blockers: connection.blockers })).digest('hex')
    return { ...connection, usage, impactRevision }
  })
}
