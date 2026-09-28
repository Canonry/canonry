import { and, count, eq } from 'drizzle-orm'
import { MEASUREMENT_CHANGES_NOISE_ANSWERS, MEASUREMENT_PLAN_V2_SCHEMA_VERSION } from '@ainyc/canonry-contracts'
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
  'canonry_measurement_data_quality',
  'canonry_run_completeness',
  'canonry_competitor_landscape',
  'canonry_visibility_report',
  'canonry_analytics_sources',
]
/** Schema-v1 plans: the overview reads them; the portfolio and Property reads need v2. */
const LEGACY_TOOLS = ['canonry_measurement_overview', 'canonry_measurement_plan_get', 'canonry_run_completeness']
/**
 * A Simple sweep has no plan manifest, so canonry_run_completeness has no
 * expected answers to count for it and is not pinned here.
 */
const SIMPLE_TOOLS = ['canonry_visibility_report']

/**
 * Which read answers each Advanced question. The reads already return what
 * these questions need; the common failure is answering from the wrong one
 * (a run status for completeness, a few weak rows for a portfolio-wide
 * ranking), so the prompt names the read rather than restating its rules.
 */
const ADVANCED_ROUTES = [
  'Weakest or strongest Properties: canonry_measurement_portfolio_summary (rows with metro, names written instead and cited domains; mentionRanking for both ends). For more rows pass groupKey, or page canonry_measurement_overview.',
  'Which metros have the biggest gaps: the summary\'s markets (every metro) and tiedAtWeakest.byMetro.',
  'One Property: canonry_measurement_property_evidence and canonry_measurement_property_competitors (names written instead of it, and citedDomains, its own cited sources). Portfolio lists such as weakestAnswerSources pool many Properties.',
  'Which names answers give instead across the portfolio: canonry_competitor_landscape with queryClass and runId "latest". Per-Property named-instead lists are samples of weak Properties.',
  'Where answers get their sources: canonry_analytics_sources with queryClass and runId "latest"; without them it pools both classes and every sweep.',
  'What changed since the last sweep: canonry_measurement_changes once per class. Quote its distribution for how many Properties moved.',
  'Is the sweep complete, or is anything unreliable: canonry_measurement_data_quality (quote completeness expected, executed and missing, unattributedByClass and latestFill), then canonry_run_completeness with its run.displayedRunId for missing answers per engine. A Healthy run status and canonry_doctor are not completeness checks.',
]

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
          prompt: `\n\nProject shape: an Advanced Measurement plan on the legacy schema v1 (plan revision ${version.revision}) with ${size}. Its queries are not classified as branded or non-brand, so do not report class splits for it. Read it with canonry_measurement_overview and canonry_measurement_plan_get. For whether a sweep is complete, pass the overview's measurement.displayedRunId to canonry_run_completeness and quote expected, executed and missing. The portfolio ranking, Property evidence and the advanced visibility report need a schema-v2 plan and will refuse this one.`,
          pinned: LEGACY_TOOLS,
        }
      }
      const queriesIn = (queryClass: string) => new Set((plan.assignments ?? [])
        .filter(assignment => assignment.queryClass === queryClass)
        .map(assignment => assignment.queryId)).size
      return {
        prompt: `\n\nProject shape: an Advanced Measurement portfolio (plan revision ${version.revision}) with ${size}, ${queriesIn('branded')} branded and ${queriesIn('non-brand')} non-brand queries. This line settles the project type.`
          + '\nRules: measure per Property, group or market, never pool branded and non-brand, and a query shared by several Properties is one answer scored for each. Denominators count answers (queries x engines), not queries; label them answers. Group Properties only by the metro and submarkets the tools return, never by name. Names given instead were written in the answer text, not cited; cited domains are sources and never go under a named-instead heading. Name only engines a tool returned.'
          + ` Between two sweeps, a Property that moved ${MEASUREMENT_CHANGES_NOISE_ANSWERS} answers or fewer is within noise (withinNoise): never call it a gain, loss, trend or regression.`
          + ' Properties tied at the weakest rate are not ranked: they are listed by name, so say how many tie (tiedAtWeakest.count), give tiedAtWeakest.byMetro, and call the listed rows examples of the tie, not a ranked bottom list.'
          + ' A result with truncated true, a total above its rows, __partialLists or __truncation is partial: say how many of how many you saw, and never call those rows the biggest, all, or the full picture.'
          + `\nRoute each question to its read:\n${ADVANCED_ROUTES.map(route => `- ${route}`).join('\n')}`
          + '\ncanonry_visibility_report describes the whole project, not one Property. canonry_measurement_plan_get is plan structure with no metrics; do not read it for analysis.',
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
