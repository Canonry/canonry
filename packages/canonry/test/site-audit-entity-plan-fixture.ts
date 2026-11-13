import crypto from 'node:crypto'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  measurementPlanV2ChecksumJson,
  type MeasurementPlanV2,
} from '@canonry/canonry-contracts'
import { measurementPlans, measurementPlanVersions, type DatabaseClient } from '@canonry/canonry-db'

const NOW = '2026-11-10T00:00:00.000Z'

/** Two Properties on one site: one by path prefix plus a host of its own, one by its exact page. */
export function entityPlan(overrides: Partial<MeasurementPlanV2> = {}): MeasurementPlanV2 {
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Example Homes'] } },
    targets: [
      { stableKey: 'harbor-point', label: 'Harbor Point', aliases: ['Harbor Point', 'Harbor Point Apartments'], identityAliases: ['Harbor Point Austin'],
        mentionNotApplicable: false, discoveryIdentity: null,
        urlMatchers: [
          { kind: 'prefix', host: 'example.com', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' },
          { kind: 'host', host: 'harborpoint.example.com' },
        ] },
      { stableKey: 'ridge-view', label: 'Ridge View', aliases: ['Ridge View'], mentionNotApplicable: false, discoveryIdentity: null,
        urlMatchers: [{ kind: 'exact', url: 'https://example.com/apartments/ridge-view/', pathCase: 'insensitive' }] },
    ],
    groups: [], querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [],
    compiledChecksum: '0'.repeat(64),
    ...overrides,
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

/** Stores a plan revision and, unless `active` is false, points the project at it. */
export function storePlanRevision(db: DatabaseClient, projectId: string, plan: MeasurementPlanV2, revision: number, active = true): string {
  const id = crypto.randomUUID()
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({ id, projectId, revision, schemaVersion: 2, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
  if (active) {
    db.insert(measurementPlans).values({ projectId, activeVersionId: id, createdAt: NOW, updatedAt: NOW })
      .onConflictDoUpdate({ target: measurementPlans.projectId, set: { activeVersionId: id, updatedAt: NOW } }).run()
  }
  return id
}

/** An older (v1) plan with one Target, active for the project. */
export function storeV1Plan(db: DatabaseClient, projectId: string): void {
  const location = { label: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US' }
  const plan = compileMeasurementPlan({ schemaVersion: 1,
    targets: [{ stableKey: 'harbor-point', label: 'Harbor Point', aliases: ['Harbor Point'], urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' }] }],
    groups: [{ stableKey: 'all', label: 'All', targetKeys: ['harbor-point'] }], targetQuerySelections: [{ targetKey: 'harbor-point', queryIds: ['q1'] }],
  }, { canonicalDomain: 'example.com', ownedDomains: [], brandNames: ['Example Homes'], defaultContext: location, locations: [location], trackedQueries: [{ id: 'q1', query: 'apartments in austin' }], expectedSnapshots: 1 })
  const id = crypto.randomUUID()
  const canonicalJson = canonicalMeasurementPlanJson(plan)
  db.insert(measurementPlanVersions).values({ id, projectId, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: NOW }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: id, createdAt: NOW, updatedAt: NOW }).run()
}
