import { eq } from 'drizzle-orm'
import {
  RunKinds, RunStatuses, RunTriggers, SeoAdapterOutcomes, SeoCapabilities, SeoProviders,
  SeoRunStatuses, SeoScopeKinds, SeoTargetKinds, emptySeoResults, measurementPlanV2Schema,
  type SeoProfileInput, type SeoProvenance, type SeoResults,
} from '@canonry/canonry-contracts'
import { measurementPlans, measurementPlanVersions, runs, seoJobs, seoProfiles, seoTasks, type DatabaseClient } from '@canonry/canonry-db'
import { harborProperties } from './portfolio.js'
import type { DemoSeedContext } from './types.js'

/** Fictional saved SEO observations. No adapter, credentials, or provider work. */
export function seedDemoSeo(db: DatabaseClient, context: DemoSeedContext): void {
  db.transaction(tx => {
    for (const project of [context.simple, context.portfolio]) {
      const version = tx.select({ version: measurementPlanVersions }).from(measurementPlans).innerJoin(measurementPlanVersions, eq(measurementPlans.activeVersionId, measurementPlanVersions.id)).where(eq(measurementPlans.projectId, project.id)).get()?.version
      const plan = version ? measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)) : null
      const properties = harborProperties()
      const keywords = plan
        ? properties.map(property => `luxury resorts in ${property.market.label.toLowerCase()} with ${['oceanfront pools', 'family suites', 'spa packages', 'waterfront dining'][property.number - 1]}`)
        : ['roof repair near me', 'roof replacement cost', 'metal roofing contractors', 'emergency roof repair', 'shingle roof installation', 'storm damage roof repair', 'roof inspection', 'flat roof repair']
      const base: SeoProfileInput = {
        name: 'Whole site', connectionId: 'demo-seo',
        capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['domain-intelligence'], SeoCapabilities['ranked-keywords']],
        targets: [{ kind: SeoTargetKinds.domain, value: project.domain, includeSubdomains: true }],
        keywords, locationCode: 2840, languageCode: 'en', limit: 100,
        scope: { kind: SeoScopeKinds.project, ...(version ? { expectedPlanRevision: version.revision } : {}) },
      }
      const profiles: Array<{ id: string; input: SeoProfileInput }> = [{ id: 'all-site', input: base }]
      if (plan && version) {
        for (const scope of [
          ...plan.groups.map(group => ({ kind: SeoScopeKinds.group, key: group.stableKey, label: group.label, targetKeys: group.targetKeys })),
          ...(plan.reportingScopes ?? []).map(market => ({ kind: SeoScopeKinds.market, key: market.stableKey, label: market.label, targetKeys: market.usageEdges.map(edge => edge.targetKey) })),
          ...plan.targets.map(target => ({ kind: SeoScopeKinds.property, key: target.stableKey, label: target.label, targetKeys: [target.stableKey] })),
        ]) {
          profiles.push({ id: `${scope.kind}-${scope.key}`, input: {
            ...base, name: `${scope.label} · ${scope.kind}`, targets: [],
            capabilities: [SeoCapabilities['keyword-metrics']],
            keywords: properties.flatMap((property, index) => scope.targetKeys.includes(property.key) ? [keywords[index]!] : []),
            scope: { kind: scope.kind, key: scope.key, expectedPlanRevision: version.revision },
          } })
        }
      }
      for (const { id: profileId, input } of profiles) {
        const createdAt = new Date(context.now.getTime() - 8 * 86_400_000).toISOString()
        tx.insert(seoProfiles).values({ projectId: project.id, id: profileId, revision: 1, input, createdAt, updatedAt: createdAt }).run()
        for (const daysAgo of [8, 1]) {
          const capturedAt = new Date(context.now.getTime() - daysAgo * 86_400_000).toISOString()
          const runId = `demo-seo-${project.id}-${profileId}-${daysAgo}`
          tx.insert(runs).values({ id: runId, projectId: project.id, kind: RunKinds['seo-sync'], status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: capturedAt, startedAt: capturedAt, finishedAt: capturedAt }).run()
          tx.insert(seoJobs).values({
            id: runId, runId, projectId: project.id, projectKey: project.id, profileId, profileRevision: 1,
            profile: input, scopeSnapshot: { mode: plan ? 'advanced' : 'simple', scope: input.scope, ...(version ? { planRevision: version.revision, planVersionId: version.id } : {}) },
            requestHash: runId, idempotencyKey: runId, principalId: 'public-demo-viewer',
            connectionId: input.connectionId, accountKey: 'demo-no-provider-account', buckets: [],
            status: SeoRunStatuses.completed, createdAt: capturedAt, startedAt: capturedAt, finishedAt: capturedAt,
          }).run()
          for (const capability of input.capabilities) {
            const provenance: SeoProvenance = { provider: SeoProviders.dataforseo, dataset: `demo-${capability}`, engine: 'google', locationCode: input.locationCode, languageCode: input.languageCode, device: 'unspecified', collectedAt: capturedAt, sourceUpdatedAt: capturedAt }
            const results: SeoResults = emptySeoResults()
            const target = input.targets[0] ?? null
            if (capability === SeoCapabilities['keyword-metrics']) {
              results.keywordMetrics = input.keywords.map(keyword => {
                const index = keywords.indexOf(keyword)
                return {
                  keyword, searchVolume: 2400 + index * 320, cpcUsd: 2.4 + index * 0.65, adCompetition: 0.52,
                  keywordDifficulty: 28 + index * 3, searchIntent: 'commercial', coreKeyword: null, provenance,
                  monthlySearches: Array.from({ length: 6 }, (_, month) => {
                    const date = new Date(Date.UTC(context.now.getUTCFullYear(), context.now.getUTCMonth() - 6 + month, 1))
                    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, searchVolume: 2000 + index * 320 + month * 80 }
                  }),
                }
              })
            } else if (capability === SeoCapabilities['domain-intelligence'] && target) {
              results.domainIntelligence = [{ target, organicKeywords: plan ? 3240 : 486, estimatedOrganicTraffic: plan ? 18400 : 2750, estimatedOrganicTrafficValueUsd: plan ? 46200 : 9100, top1: plan ? 126 : 18, top2To3: plan ? 284 : 42, top4To10: plan ? 812 : 116, top11To20: plan ? 640 : 94, provenance }]
            } else if (capability === SeoCapabilities['ranked-keywords'] && target) {
              results.rankedKeywords = input.keywords.map((keyword, index) => ({
                target, keyword, url: `https://${project.domain}${plan ? properties[index]!.path : ['/services/roof-repair/', '/services/roof-replacement/', '/services/metal-roofing/', '/services/emergency-roof-repair/', '/services/shingle-roofing/', '/services/storm-damage/', '/services/roof-inspection/', '/services/flat-roofing/'][index]}`,
                rankOrganic: index + (daysAgo === 1 ? 2 : 4), rankAbsolute: index + (daysAgo === 1 ? 4 : 6), searchVolume: 2400 + index * 320,
                estimatedTraffic: 420 - index * 25, cpcUsd: 2.4 + index * 0.65, keywordDifficulty: 28 + index * 3,
                serpFeatures: index % 2 === 0 ? ['local_pack', 'people_also_ask'] : ['people_also_ask'], provenance,
              }))
            }
            tx.insert(seoTasks).values({
              id: `${runId}-${capability}`, jobId: runId,
              request: { capability, target: capability === SeoCapabilities['keyword-metrics'] ? null : target, keywords: capability === SeoCapabilities['keyword-metrics'] ? input.keywords : [], locationCode: input.locationCode, languageCode: input.languageCode, limit: input.limit, tag: runId },
              status: SeoRunStatuses.completed, catalogRevision: 'demo', collectionOutcome: SeoAdapterOutcomes.completed,
              reservedMicros: 0, actualMicros: 0, receipts: [], results, startedAt: capturedAt, finishedAt: capturedAt,
            }).run()
          }
        }
      }
    }
  })
}
