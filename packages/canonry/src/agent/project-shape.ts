import { and, count, eq } from 'drizzle-orm'
import { MEASUREMENT_PLAN_V2_SCHEMA_VERSION } from '@ainyc/canonry-contracts'
import { measurementPlans, measurementPlanVersions, queries, type DatabaseClient } from '@ainyc/canonry-db'

interface StoredPlanShape {
  schemaVersion?: number
  targets?: unknown[]
  groups?: Array<{ parentGroupKey?: string }>
  assignments?: Array<{ queryId?: string; queryClass?: string }>
}

export interface AeroProjectShape {
  /** Appended to the system prompt; '' when the project cannot be read. */
  prompt: string
  /**
   * The tools the prompt tells Aero to start with. A progressive turn keeps
   * them visible from the start, so the first calls it is told to make never
   * answer "not found", while the rest of the catalog still loads on demand.
   */
  pinned: string[]
}

const ADVANCED_TOOLS = [
  'canonry_measurement_portfolio_summary',
  'canonry_measurement_overview',
  'canonry_measurement_property_evidence',
  'canonry_measurement_property_competitors',
  'canonry_measurement_changes',
  'canonry_visibility_report',
  'canonry_analytics_sources',
]
/** Schema-v1 plans: the overview reads them; the portfolio and Property reads need v2. */
const LEGACY_TOOLS = ['canonry_measurement_overview', 'canonry_measurement_plan_get']
const SIMPLE_TOOLS = ['canonry_visibility_report']

/**
 * What kind of project Aero is in, told before it reads anything: an Advanced
 * Measurement portfolio (Properties, groups, classed queries), a legacy
 * schema-v1 plan, or a Simple project (a flat list of tracked queries), with
 * the tools that answer each kind. Without it the model spends its first
 * calls working that out, and guesses tool names on the way.
 *
 * Reads only the active plan pointer and its stored JSON, or a query count.
 * Returns an empty shape when the project cannot be read, so a turn is never
 * blocked.
 */
export function aeroProjectShape(db: DatabaseClient, projectId: string): AeroProjectShape {
  try {
    const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
    const version = pointer
      ? db.select().from(measurementPlanVersions).where(and(
          eq(measurementPlanVersions.projectId, projectId),
          eq(measurementPlanVersions.id, pointer.activeVersionId),
        )).get()
      : undefined
    if (version) {
      const plan = JSON.parse(version.canonicalJson) as StoredPlanShape
      const groups = plan.groups ?? []
      const topLevel = groups.filter(group => !group.parentGroupKey).length
      const size = `${plan.targets?.length ?? 0} Properties in ${groups.length} groups (${topLevel} top-level, ${groups.length - topLevel} nested)`
      if ((plan.schemaVersion ?? version.schemaVersion) !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
        return {
          prompt: `\n\nProject shape: an Advanced Measurement plan on the legacy schema v1 (plan revision ${version.revision}) with ${size}. Its queries are not classified as branded or non-brand, so do not report class splits for it. Read it with canonry_measurement_overview and canonry_measurement_plan_get; the portfolio ranking, Property evidence and the advanced visibility report need a schema-v2 plan and will refuse this one.`,
          pinned: LEGACY_TOOLS,
        }
      }
      const queriesIn = (queryClass: string) => new Set((plan.assignments ?? [])
        .filter(assignment => assignment.queryClass === queryClass)
        .map(assignment => assignment.queryId)).size
      return {
        prompt: `\n\nProject shape: an Advanced Measurement portfolio (plan revision ${version.revision}) with ${size}, ${queriesIn('branded')} branded and ${queriesIn('non-brand')} non-brand queries. Measure per Property, group or market, never pool branded and non-brand, and a query shared by several Properties is one answer scored for each. Start portfolio questions with canonry_measurement_portfolio_summary (weakest-first ranking with each Property's metro, the names answers wrote instead, and the domains they cited) or canonry_measurement_overview; drill into one Property with canonry_measurement_property_evidence and canonry_measurement_property_competitors; compare sweeps with canonry_measurement_changes. Project-wide tools such as canonry_visibility_report describe the whole project, not one Property. Group Properties only by the metro and submarkets the tools return, never by name. Names given instead were written in the answer text, not cited. Denominators count answers (queries x engines), not queries. Properties tied at the weakest rate are not ranked against each other. For sources, use each Property's citedDomains in the portfolio summary, or canonry_analytics_sources with queryClass and runId set; without them it pools both classes and every sweep. canonry_measurement_plan_get is plan structure with no metrics; do not read it for analysis.`,
        pinned: ADVANCED_TOOLS,
      }
    }
    const tracked = db.select({ total: count() }).from(queries).where(eq(queries.projectId, projectId)).get()?.total ?? 0
    return {
      prompt: `\n\nProject shape: a Simple project with ${tracked} tracked queries and no measurement plan (no Properties or markets). Start with canonry_project_overview, then canonry_visibility_report for mention and citation rates by query and engine.`,
      pinned: SIMPLE_TOOLS,
    }
  } catch {
    return { prompt: '', pinned: [] }
  }
}
