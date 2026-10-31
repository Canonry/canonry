import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  gaAcquisitionDaily,
  gaAiReferrals,
  gaDailyTotals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gaSearchLandingPages,
  gaSearchLandingWindows,
  gaSocialReferrals,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gaTrafficWindowSummaries,
  gaWindowMetrics,
  projects,
} from '@canonry/canonry-db'
import type { Ga4CredentialStore } from './ga.js'
import type { GoogleConnectionStore } from './google.js'
import { writeAuditLog } from './helpers.js'

type Database = FastifyInstance['db']
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** The connection stores a project's GA4 property resolves from. */
export interface Ga4ConnectionStores {
  ga4CredentialStore?: Ga4CredentialStore
  googleConnectionStore?: GoogleConnectionStore
}

/** A project as GA4 property resolution needs it. */
export type Ga4Project = Pick<typeof projects.$inferSelect, 'id' | 'name' | 'canonicalDomain'>

/**
 * The GA4 property a project resolves to now, in the order the GA sync
 * resolves credentials: the project's service-account connection first, then
 * the domain's OAuth (`ga4`) connection. The same property `GET /ga/status`
 * reports. Reads stored connection records only: no token refresh and no
 * Google call. Null when neither names a property.
 */
export function resolveCurrentGa4PropertyId(
  stores: Ga4ConnectionStores,
  projectName: string,
  canonicalDomain: string,
): string | null {
  const serviceAccount = stores.ga4CredentialStore?.getConnection(projectName)
  if (serviceAccount?.propertyId) return serviceAccount.propertyId
  return stores.googleConnectionStore?.getConnection(canonicalDomain, 'ga4')?.propertyId ?? null
}

/**
 * Every table a GA4 sync fills from the project's property. Only the Search
 * Console landing-page windows record which property they were read from, so
 * once two properties' rows are stored, nothing tells them apart. The sync
 * state is cleared with them: its timestamps would turn the next sync's full
 * backfill into an incremental refresh.
 */
const GA_PROPERTY_TABLES = [
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gaTrafficWindowSummaries,
  gaWindowMetrics,
  gaDailyTotals,
  gaAiReferrals,
  gaSocialReferrals,
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaSearchLandingPages,
  gaSearchLandingWindows,
  gaMeasurementSyncStates,
] as const

/**
 * Delete everything GA4 syncs stored for the project, sync state included,
 * so every GA read shows it as never synced until the next sync. Runs inside
 * the caller's transaction, beside the audit entry for the change. Returns the
 * number of rows deleted.
 */
export function clearGaPropertyData(tx: Transaction, projectId: string): number {
  let deleted = 0
  for (const table of GA_PROPERTY_TABLES) {
    deleted += tx.delete(table).where(eq(table.projectId, projectId)).run().changes
  }
  return deleted
}

/**
 * The projects that resolve their GA4 property through `canonicalDomain`'s
 * OAuth `ga4` connection, unless their own service account names one. The
 * store keys that connection by the exact domain, so a write to it reaches
 * every project with this canonical domain.
 */
export function projectsSharingGa4Connection(db: Database, canonicalDomain: string): Ga4Project[] {
  return db.select({ id: projects.id, name: projects.name, canonicalDomain: projects.canonicalDomain })
    .from(projects)
    .where(eq(projects.canonicalDomain, canonicalDomain))
    .all()
}

/** A project and the GA4 property it resolved to before a connection write. */
export interface Ga4PropertyReading {
  project: Ga4Project
  propertyId: string | null
}

/** Each project's current GA4 property, read before a write that may change it. */
export function readGa4Properties(
  stores: Ga4ConnectionStores,
  gaProjects: readonly Ga4Project[],
): Ga4PropertyReading[] {
  return gaProjects.map((project) => ({
    project,
    propertyId: resolveCurrentGa4PropertyId(stores, project.name, project.canonicalDomain),
  }))
}

/**
 * After a write to a GA4 connection: clear the GA data of every project in
 * `before` that now resolves to another property, or to none, and of every
 * project whose stored landing-page snapshot names a property other than the
 * one it resolves to now. A project still on the same property keeps its data,
 * so a rotated key or a repeated connect changes nothing. Each project that
 * loses rows gets its own `ga4.data-cleared` audit entry, because the write may
 * belong to another project on the same domain.
 */
export function clearGaDataOnPropertyChange(
  tx: Transaction,
  stores: Ga4ConnectionStores,
  before: readonly Ga4PropertyReading[],
  actor = 'api',
): void {
  for (const { project, propertyId: previousPropertyId } of before) {
    const propertyId = resolveCurrentGa4PropertyId(stores, project.name, project.canonicalDomain)
    const moved = previousPropertyId !== null && previousPropertyId !== propertyId
    const snapshotOfAnotherProperty = !moved && tx
      .selectDistinct({ propertyId: gaSearchLandingWindows.propertyId })
      .from(gaSearchLandingWindows)
      .where(eq(gaSearchLandingWindows.projectId, project.id))
      .all()
      .some((stored) => stored.propertyId !== propertyId)
    if (!moved && !snapshotOfAnotherProperty) continue
    // A project with no GA rows loses nothing, so it gets no entry.
    if (clearGaPropertyData(tx, project.id) === 0) continue

    writeAuditLog(tx, {
      projectId: project.id,
      actor,
      action: 'ga4.data-cleared',
      entityType: 'ga_connection',
      entityId: propertyId,
      diff: { previousPropertyId, propertyId },
    })
  }
}
