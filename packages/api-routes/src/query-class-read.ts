import type { DatabaseClient } from '@canonry/canonry-db'
import {
  compileQueryClassifier,
  effectiveBrandNames,
  parseStoredMeasurementPlanAnyVersion,
  type QueryClass,
} from '@canonry/canonry-contracts'
import { activePlanVersionRow } from './measurement-draft-repo.js'

/**
 * The class stored for each query in the project's active measurement plan.
 *
 * `null` means no plan stores a class for this project (no active plan, or an
 * active schema v1 plan), so its classes come from the query text. A map means
 * the plan owns the class: a query it does not hold, or holds as `null`, has no
 * single stored class.
 */
function storedQueryClasses(
  db: Pick<DatabaseClient, 'select'>,
  projectId: string,
): Map<string, QueryClass | null> | null {
  const classes = new Map<string, QueryClass | null>()
  let plan: ReturnType<typeof parseStoredMeasurementPlanAnyVersion>
  try {
    const version = activePlanVersionRow(db, projectId)
    if (!version) return null
    plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  } catch {
    // An active plan that cannot be read still owns the class. Report it as
    // unknown: the query text would be a second opinion, and a list read (or
    // the response to a write that already committed) must not fail over it.
    return classes
  }
  // Only a schema v2 revision stores a class. A v1 revision is classed from the
  // query text, the gate every other class read uses (`schemaVersion === 2` in
  // analytics.ts, visibility-stats.ts and competitor-landscape.ts).
  if (plan.schemaVersion !== 2) return null
  for (const assignment of plan.assignments) {
    const seen = classes.get(assignment.queryId)
    classes.set(
      assignment.queryId,
      seen === undefined || seen === assignment.queryClass ? assignment.queryClass : null,
    )
  }
  return classes
}

/**
 * The class each tracked query carries where queries are listed and added.
 *
 * Simple portfolio (no active plan, or an active schema v1 plan, which stores
 * no class): `compileQueryClassifier` over `effectiveBrandNames(project)`, the
 * one text classifier. A project with no usable brand name gets `null` for
 * every query, never `non-brand`.
 *
 * Custom portfolio (active schema v2 plan): the `queryClass` frozen on the
 * query's assignments in the active revision, the same stored field the query
 * workspace reports per assignment. It is one value only when every assignment
 * of the query agrees. An unassigned query and a query assigned under both
 * classes are `null`.
 */
export function readQueryClasses(
  db: Pick<DatabaseClient, 'select'>,
  project: Parameters<typeof effectiveBrandNames>[0] & { id: string },
  rows: ReadonlyArray<{ id: string; query: string }>,
): Map<string, QueryClass | null> {
  const stored = storedQueryClasses(db, project.id)
  if (stored !== null) return new Map(rows.map(row => [row.id, stored.get(row.id) ?? null]))
  const classifier = compileQueryClassifier(effectiveBrandNames(project))
  return new Map(rows.map(row => [row.id, classifier?.classify(row.query) ?? null]))
}
