import { and, count, eq } from 'drizzle-orm'
import { measurementPlans, measurementPlanVersions, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { canonryMcpTools } from '../mcp/tool-registry.js'

interface StoredPlanShape {
  schemaVersion?: number
  targets?: unknown[]
  groups?: Array<{ parentGroupKey?: string }>
  assignments?: Array<{ queryId?: string; queryClass?: string }>
}

const tiers = new Map(canonryMcpTools.map(tool => [tool.name as string, tool.tier as string]))

/** A tool name, with its toolkit when the turn loads toolkits progressively. */
function toolRef(name: string, progressive: boolean): string {
  const tier = tiers.get(name)
  return progressive && tier && tier !== 'core' ? `${name} (toolkit "${tier}")` : name
}

/**
 * One paragraph telling Aero what kind of project it is in before it reads
 * anything: an Advanced Measurement portfolio (Properties, groups, classed
 * queries) or a Simple project (a flat list of tracked queries), and which
 * tools answer each kind. Without it the model spends its first calls working
 * that out, and guesses tool names on the way.
 *
 * Reads only the active plan pointer and its stored JSON, or a query count.
 * Returns '' when the project cannot be read, so a prompt is never blocked.
 */
export function aeroProjectShapePrompt(db: DatabaseClient, projectId: string, opts: { progressive: boolean }): string {
  try {
    const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
    const version = pointer
      ? db.select().from(measurementPlanVersions).where(and(
          eq(measurementPlanVersions.projectId, projectId),
          eq(measurementPlanVersions.id, pointer.activeVersionId),
        )).get()
      : undefined
    const ref = (name: string) => toolRef(name, opts.progressive)
    if (version) {
      const plan = JSON.parse(version.canonicalJson) as StoredPlanShape
      const groups = plan.groups ?? []
      const topLevel = groups.filter(group => !group.parentGroupKey).length
      const queriesIn = (queryClass: string) => new Set((plan.assignments ?? [])
        .filter(assignment => assignment.queryClass === queryClass)
        .map(assignment => assignment.queryId)).size
      return `\n\nProject shape: an Advanced Measurement portfolio (plan revision ${version.revision}) with ${plan.targets?.length ?? 0} Properties in ${groups.length} groups (${topLevel} top-level, ${groups.length - topLevel} nested), ${queriesIn('branded')} branded and ${queriesIn('non-brand')} non-brand queries. Measure per Property, group or market, never pool branded and non-brand, and a query shared by several Properties is one answer scored for each. Start portfolio questions with ${ref('canonry_measurement_portfolio_summary')} (weakest-first ranking with names given instead) or ${ref('canonry_measurement_overview')}; drill into one Property with ${ref('canonry_measurement_property_evidence')} and ${ref('canonry_measurement_property_competitors')}; compare sweeps with ${ref('canonry_measurement_changes')}. Project-wide tools such as ${ref('canonry_visibility_report')} describe the whole project, not one Property.`
    }
    const tracked = db.select({ total: count() }).from(queries).where(eq(queries.projectId, projectId)).get()?.total ?? 0
    return `\n\nProject shape: a Simple project with ${tracked} tracked queries and no measurement plan (no Properties or markets). Start with ${ref('canonry_project_overview')}, then ${ref('canonry_visibility_report')} for mention and citation rates by query and engine.`
  } catch {
    return ''
  }
}
