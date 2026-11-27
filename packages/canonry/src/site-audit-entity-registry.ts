import { and, eq } from 'drizzle-orm'
import type { EntityRegistry, EntityUrlMatcher } from '@canonry/agent-readiness'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  parseStoredMeasurementPlanAnyVersion,
  type MeasurementPlanV2,
  type MeasurementV2UrlMatcher,
} from '@canonry/canonry-contracts'
import { measurementPlans, measurementPlanVersions, type DatabaseClient } from '@canonry/canonry-db'

/** The pages one plan matcher covers, as a host and a path prefix. */
function entityMatcher(matcher: MeasurementV2UrlMatcher): EntityUrlMatcher | null {
  switch (matcher.kind) {
    case 'prefix':
      return { host: matcher.host, pathPrefix: matcher.pathPrefix }
    case 'host':
      return { host: matcher.host, pathPrefix: '/' }
    case 'exact': {
      // The page and anything under it: a Property's own page owns its sub-pages too.
      try {
        const url = new URL(matcher.url)
        return { host: url.hostname, pathPrefix: url.pathname }
      } catch {
        return null
      }
    }
  }
}

/**
 * The plan's Properties as the audit engine's entity registry: each Property's
 * names (label, aliases and identity aliases) and the URLs that belong to it.
 * With it, the audit flags a page that belongs to one Property when its FAQ,
 * title or H1 names another (`names-another-entity`). Null for a plan with no
 * Properties.
 */
export function planEntityRegistry(plan: MeasurementPlanV2): EntityRegistry | null {
  if (plan.targets.length === 0) return null
  return {
    entities: plan.targets.map(target => ({
      key: target.stableKey,
      names: [...new Set([target.label, ...target.aliases, ...(target.identityAliases ?? [])])],
      urlMatchers: target.urlMatchers.map(entityMatcher).filter((matcher): matcher is EntityUrlMatcher => matcher !== null),
    })),
  }
}

/**
 * The registry for a project's active Advanced Measurement plan, with the plan
 * revision it came from. Null for a project without a plan, with an older (v1)
 * plan, or with a plan that has no Properties: the audit then skips the check.
 */
export function activePlanEntityRegistry(db: DatabaseClient, projectId: string): { planRevision: number; registry: EntityRegistry } | null {
  const pointer = db.select({ versionId: measurementPlans.activeVersionId }).from(measurementPlans)
    .where(eq(measurementPlans.projectId, projectId)).get()
  if (!pointer) return null
  const version = db.select({ revision: measurementPlanVersions.revision, canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlanVersions)
    .where(and(eq(measurementPlanVersions.projectId, projectId), eq(measurementPlanVersions.id, pointer.versionId))).get()
  if (!version) return null
  const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  if (plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) return null
  const registry = planEntityRegistry(plan)
  return registry ? { planRevision: version.revision, registry } : null
}
