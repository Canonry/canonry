import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitorChangePreviewRequestSchema,
  competitorAliasProjectIdentity,
  competitorEntryParts,
  normalizeCompetitorDomain,
  type CompetitorIdentityInput,
  type CompetitorShareImpact,
  validationError,
} from '@ainyc/canonry-contracts'
import { runs } from '@ainyc/canonry-db'
import { readCompetitorLandscape } from './competitor-landscape.js'
import { projectQueryClassifier, shareOfVoiceFromLandscape } from './mention-share-inputs.js'
import { competitorWritesFromEntries, planCompetitorSet, readStoredCompetitors } from './competitor-writes.js'
import { resolveProject } from './helpers.js'
import { readMarketCompetitorPins } from './plan-competitors.js'
import { activeMeasurementPlan } from './measurement-overview.js'

function delta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before
}

export function previewCompetitorShareImpact(
  app: Pick<FastifyInstance, 'db'>,
  projectName: string,
  after: readonly CompetitorIdentityInput[],
  options: { marketNames?: ReadonlyMap<string, string[]>; autoAliasRescanPending?: boolean } = {},
): CompetitorShareImpact {
  const project = resolveProject(app.db, projectName)
  const hasBrand = projectQueryClassifier(project) !== null
  const activeV2 = activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
  const queryClass = hasBrand || activeV2 ? 'non-brand' : 'pooled'
  const query = queryClass === 'pooled' ? { runId: 'latest' as const } : { runId: 'latest' as const, queryClass: 'non-brand' as const }
  const beforeLandscape = readCompetitorLandscape(app, projectName, query)
  const afterLandscape = readCompetitorLandscape(app, projectName, query, undefined, {
    projectCompetitors: after,
    ...(options.marketNames ? { marketNames: options.marketNames } : {}),
  })
  const before = shareOfVoiceFromLandscape(beforeLandscape, queryClass)
  const afterShare = shareOfVoiceFromLandscape(afterLandscape, queryClass)
  const runIds = beforeLandscape.runIds ?? []
  const sweepAt = runIds.length === 0 ? null : app.db.select({ createdAt: runs.createdAt }).from(runs).where(and(eq(runs.projectId, project.id), inArray(runs.id, runIds))).all().map(row => row.createdAt).sort().at(-1) ?? null
  const caveats: CompetitorShareImpact['caveats'] = []
  if (queryClass === 'pooled') caveats.push('pooled')
  if (runIds.length === 0) caveats.push('no-latest-sweep')
  if (before.competitorCount !== afterShare.competitorCount) caveats.push('basis-changed')
  if (options.autoAliasRescanPending) caveats.push('auto-alias-rescan-pending')
  return {
    instrument: 'competitor-landscape',
    queryClass,
    before,
    after: afterShare,
    deltaPercent: delta(before.percent, afterShare.percent),
    restatesHistory: true,
    caveats,
    runIds,
    runCount: beforeLandscape.runCount ?? 0,
    sweepAt,
    scope: beforeLandscape.scope.kind === 'all-markets' ? 'all-markets' : 'project',
  }
}

export async function competitorChangePreviewRoutes(app: FastifyInstance) {
  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/competitor-changes/preview', async (request) => {
    const parsed = competitorChangePreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid competitor change preview request', { issues: parsed.error.issues })
    const project = resolveProject(app.db, request.params.name)
    const stored = readStoredCompetitors(app.db, project.id)
    const marketPins = readMarketCompetitorPins(app.db, project.id)
    const change = parsed.data
    let plan
    if (change.change === 'remove') {
      const remove = new Set(change.competitors.map(normalizeCompetitorDomain))
      plan = planCompetitorSet(stored, stored.filter(row => !remove.has(normalizeCompetitorDomain(row.domain))).map(row => ({ domain: row.domain, aliases: row.aliases })), { replace: true, project: competitorAliasProjectIdentity(project), marketPins })
    } else {
      const writes = change.change === 'aliases'
        ? [{ domain: change.domain, aliases: change.aliases, aliasMode: change.mode }]
        : competitorWritesFromEntries(change.competitors, change.change === 'replace' ? 'set' : 'add')
      plan = planCompetitorSet(stored, writes, { replace: change.change === 'replace', project: competitorAliasProjectIdentity(project), marketPins })
    }
    const after = plan.final.map(row => ({ domain: row.domain, aliases: row.aliases, autoAliases: row.autoAliases, blockedAliases: row.blockedAliases }))
    const impact = previewCompetitorShareImpact(app, project.name, after)
    const alreadyTracked = change.change === 'add' ? change.competitors.map(competitorEntryParts).map(entry => normalizeCompetitorDomain(entry.domain)).filter(domain => stored.some(row => normalizeCompetitorDomain(row.domain) === domain)) : []
    const { final: _final, ...planSummary } = plan
    return { project: project.name, change, plan: { ...planSummary, alreadyTracked }, impact }
  })
}
