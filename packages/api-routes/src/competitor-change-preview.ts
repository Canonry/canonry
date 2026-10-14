import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitorChangePreviewRequestSchema,
  CompetitorChangeKinds,
  CompetitorShareImpactCaveats,
  LATEST_RUN_ID,
  competitorAliasProjectIdentity,
  competitorEntryParts,
  normalizeCompetitorDomain,
  notFound,
  roundRatio,
  RatioUnits,
  type CompetitorShareImpact,
  validationError,
} from '@ainyc/canonry-contracts'
import { runs } from '@ainyc/canonry-db'
import { readCompetitorLandscape } from './competitor-landscape.js'
import { projectQueryClassifier, shareOfVoiceFromLandscape } from './mention-share-inputs.js'
import { bulkCompetitorAddPreview, summarizeBulkCompetitorAdd, competitorWritesFromEntries, planCompetitorSet, readStoredCompetitors, type CompetitorSetPlan, type StoredCompetitor } from './competitor-writes.js'
import { resolveProject } from './helpers.js'
import { readMarketCompetitorPins } from './plan-competitors.js'
import { readMarketCompetitorNames } from './market-competitor-names.js'
import { activeMeasurementPlan } from './measurement-overview.js'

function delta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : roundRatio(after - before, RatioUnits.percent)
}

export function previewCompetitorShareImpact(
  app: Pick<FastifyInstance, 'db'>,
  projectName: string,
  after: readonly Omit<StoredCompetitor, 'id'>[],
  options: { marketNames?: ReadonlyMap<string, string[]>; autoAliasRescanPending?: boolean } = {},
): CompetitorShareImpact {
  const project = resolveProject(app.db, projectName)
  const hasBrand = projectQueryClassifier(project) !== null
  const activeV2 = activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
  const queryClass = hasBrand || activeV2 ? 'non-brand' : 'pooled'
  const query = queryClass === 'pooled' ? { runId: LATEST_RUN_ID } : { runId: LATEST_RUN_ID, queryClass: 'non-brand' as const }
  const beforeLandscape = readCompetitorLandscape(app, projectName, query)
  const afterLandscape = readCompetitorLandscape(app, projectName, query, undefined, {
    projectCompetitors: after,
    marketNames: options.marketNames ?? readMarketCompetitorNames(app.db, project.id, after),
  })
  const before = shareOfVoiceFromLandscape(beforeLandscape, queryClass)
  const afterShare = shareOfVoiceFromLandscape(afterLandscape, queryClass)
  const runIds = beforeLandscape.runIds ?? []
  const sweepAt = runIds.length === 0 ? null : app.db.select({ createdAt: runs.createdAt }).from(runs).where(and(eq(runs.projectId, project.id), inArray(runs.id, runIds))).all().map(row => row.createdAt).sort().at(-1) ?? null
  const caveats: CompetitorShareImpact['caveats'] = []
  if (queryClass === 'pooled') caveats.push(CompetitorShareImpactCaveats['pooled'])
  if (runIds.length === 0) caveats.push(CompetitorShareImpactCaveats['no-latest-sweep'])
  if (before.competitorCount !== afterShare.competitorCount) caveats.push(CompetitorShareImpactCaveats['basis-changed'])
  if (options.autoAliasRescanPending) caveats.push(CompetitorShareImpactCaveats['auto-alias-rescan-pending'])
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
    if (change.change === CompetitorChangeKinds.aliases && !stored.some(row => normalizeCompetitorDomain(row.domain) === normalizeCompetitorDomain(change.domain))) {
      throw notFound('Competitor', normalizeCompetitorDomain(change.domain))
    }
    let plan: CompetitorSetPlan
    if (change.change === CompetitorChangeKinds.remove) {
      const remove = new Set(change.competitors.map(normalizeCompetitorDomain))
      // DELETE removes rows directly; it never revalidates retained aliases.
      plan = {
        final: stored.filter(row => !remove.has(normalizeCompetitorDomain(row.domain))),
        removed: stored.filter(row => remove.has(normalizeCompetitorDomain(row.domain))),
        added: [], aliasChanges: [], droppedAliases: [], autoAliasChanges: [], droppedAutoAliases: [],
      }
    } else {
      const writes = change.change === CompetitorChangeKinds.aliases
        ? [{ domain: change.domain, aliases: change.aliases, aliasMode: change.mode }]
        : change.change === CompetitorChangeKinds.replace
          ? change.competitors.map(domain => ({ domain, aliasMode: 'set' as const }))
          : competitorWritesFromEntries(change.competitors, 'add')
      plan = planCompetitorSet(stored, writes, { replace: change.change === CompetitorChangeKinds.replace, project: competitorAliasProjectIdentity(project), marketPins })
    }
    const after = plan.final.map(row => ({ domain: row.domain, aliases: row.aliases, autoAliases: row.autoAliases, blockedAliases: row.blockedAliases }))
    const impact = previewCompetitorShareImpact(app, project.name, after, {
      autoAliasRescanPending: project.competitorAutoAliases === 'apply' && plan.added.length > 0,
    })
    const bulkAdd = bulkCompetitorAddPreview(summarizeBulkCompetitorAdd(
      app.db, project.id, plan,
      { acknowledged: false, now: new Date().toISOString(), trackedBefore: stored.length },
    ))
    const alreadyTracked = change.change === CompetitorChangeKinds.add ? change.competitors.map(competitorEntryParts).map(entry => normalizeCompetitorDomain(entry.domain)).filter(domain => stored.some(row => normalizeCompetitorDomain(row.domain) === domain)) : []
    const { final: _final, ...planSummary } = plan
    return {
      project: project.name,
      change: change.change,
      plan: {
        ...planSummary,
        removed: plan.removed.map(row => row.domain),
        alreadyTracked,
      },
      bulkAdd,
      impact,
    }
  })
}
