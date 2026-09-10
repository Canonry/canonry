import crypto from 'node:crypto'
import {
  buildSimpleMeasurementDefinition,
  buildMeasurementExecutionIdentity,
  canonicalMeasurementExecutionIdentityJson,
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanV2Json,
  canonicalSimpleMeasurementDefinitionJson,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  type LocationContext,
  type MeasurementDraftAuthoring,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  competitors,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  measurementSegments,
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { DemoSeedContext } from './types.js'
import { HARBOR_MARKETS as MARKETS, harborProperties } from './portfolio.js'

const PROVIDERS = [
  { provider: 'openai', requestedModel: 'gpt-5-demo', servedModel: 'gpt-5-demo-2026-08-15' },
  { provider: 'gemini', requestedModel: 'gemini-2.5-pro-demo', servedModel: 'gemini-2.5-pro' },
  { provider: 'claude', requestedModel: 'claude-sonnet-demo', servedModel: 'claude-sonnet-4-demo' },
] as const

const SIMPLE_QUERIES = [
  'Summit Roofing reviews',
  'roof repair contractor near me',
  'emergency roof leak repair',
  'best metal roof installer',
] as const

function isoAtWeek(now: Date, weeksAgo: number): string {
  return new Date(now.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000).toISOString()
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function harborLocations(): LocationContext[] {
  return MARKETS.map(market => ({
    label: market.label,
    city: market.city,
    region: market.region,
    country: 'US',
  }))
}

function harborPlan(context: DemoSeedContext, capturedAt: string): MeasurementPlanV2 {
  const properties = harborProperties()
  const locations = new Map(harborLocations().map(location => [location.label, location]))
  const querySnapshots = properties.flatMap(property => [
    { queryId: `${property.key}-brand`, queryText: `${property.label} reviews` },
    { queryId: `${property.key}-nonbrand`, queryText: `best luxury resort in ${property.market.label} for ${['oceanfront pools', 'family suites', 'spa weekends', 'sunset dining'][property.number - 1]}` },
  ].map(query => ({ ...query, provenance: { source: 'manual' as const, sourceId: 'demo-core', capturedAt } })))
  const assignments = properties.flatMap(property => [
    { suffix: 'brand', queryClass: 'branded' as const },
    { suffix: 'nonbrand', queryClass: 'non-brand' as const },
  ].map(item => ({
    targetKey: property.key,
    queryId: `${property.key}-${item.suffix}`,
    queryClass: item.queryClass,
    classificationSource: 'operator' as const,
    executionNodeKey: `exec-${property.key}-${item.suffix}`,
  })))
  const executionNodes = assignments.map(assignment => {
    const property = properties.find(candidate => candidate.key === assignment.targetKey)!
    const query = querySnapshots.find(candidate => candidate.queryId === assignment.queryId)!
    return {
      stableKey: assignment.executionNodeKey,
      queryId: query.queryId,
      queryText: query.queryText,
      context: {
        providers: PROVIDERS.map(identity => identity.provider),
        models: Object.fromEntries(PROVIDERS.map(identity => [identity.provider, identity.requestedModel])),
        location: locations.get(property.market.label)!,
      },
      expectedSnapshots: PROVIDERS.length,
    }
  })
  const usageEdges = assignments.map(assignment => ({
    executionNodeKey: assignment.executionNodeKey,
    targetKey: assignment.targetKey,
    queryId: assignment.queryId,
  }))
  const provisional = {
    schemaVersion: 2 as const,
    identities: {
      projectBrand: {
        canonicalHost: context.portfolio.domain,
        ownedHosts: [context.portfolio.domain],
        names: ['Harbor Resorts', 'Harbor'],
      },
    },
    targets: properties.map(property => ({
      stableKey: property.key,
      label: property.label,
      aliases: [property.label, `Harbor ${property.market.label}`],
      urlMatchers: [{ kind: 'prefix' as const, host: context.portfolio.domain, pathPrefix: property.path, pathCase: 'insensitive' as const }],
      mentionNotApplicable: false,
      discoveryIdentity: `demo:${property.key}`,
    })),
    groups: MARKETS.map(market => ({
      stableKey: `market-${market.key}`,
      label: `${market.label} market`,
      targetKeys: properties.filter(property => property.market.key === market.key).map(property => property.key),
      competitors: [
        { stableKey: 'seaside-collection', label: 'Seaside Collection', domain: 'seaside-collection.example', aliases: ['Seaside Collection'] },
        { stableKey: 'coastal-stays', label: 'Coastal Stays', domain: 'coastal-stays.example', aliases: ['Coastal Stays'] },
      ],
    })),
    querySnapshots,
    assignments,
    executionNodes,
    usageEdges,
    reportingScopes: MARKETS.map(market => ({
      stableKey: `market-${market.key}`,
      label: `${market.label} market`,
      kind: 'market' as const,
      usageEdges: usageEdges.filter(edge => edge.targetKey.includes(market.key)),
    })),
    compiledChecksum: '0'.repeat(64),
  }
  const parsed = measurementPlanV2Schema.parse(provisional)
  return measurementPlanV2Schema.parse({
    ...parsed,
    compiledChecksum: sha256(measurementPlanV2ChecksumJson(parsed)),
  })
}

function harborDraft(plan: MeasurementPlanV2): MeasurementDraftAuthoring {
  const targets = plan.targets.map(target => ({
    stableKey: target.stableKey,
    label: target.label,
    status: 'included' as const,
    aliases: target.aliases,
    urlMatchers: target.urlMatchers.map(matcher => matcher.kind === 'prefix' ? `https://${matcher.host}${matcher.pathPrefix}/*` : matcher.kind === 'host' ? matcher.host : matcher.url),
    source: 'sitemap' as const,
    discoveredUrl: `https://${target.urlMatchers[0]!.kind === 'prefix' ? target.urlMatchers[0].host + target.urlMatchers[0].pathPrefix : 'harbor-resorts.example'}`,
    discoveryIdentity: target.discoveryIdentity ?? undefined,
  }))
  return {
    defaultContext: { providers: PROVIDERS.map(identity => identity.provider), models: Object.fromEntries(PROVIDERS.map(identity => [identity.provider, identity.requestedModel])), locations: MARKETS.map(market => market.label) },
    targets,
    assignments: plan.assignments.map(assignment => ({
      targetKey: assignment.targetKey,
      queryId: assignment.queryId,
      queryClass: assignment.queryClass,
      classificationSource: 'operator' as const,
      executionContexts: [plan.executionNodes.find(node => node.stableKey === assignment.executionNodeKey)!.context],
    })),
    groups: plan.groups.map(group => ({
      stableKey: group.stableKey,
      label: group.label,
      targetKeys: group.targetKeys,
      competitors: group.competitors,
    })),
    reportingScopes: plan.reportingScopes,
  }
}

/** Seeds only fictional, stored observations. It never instantiates a provider or schedules work. */
export function seedDemoCore(db: DatabaseClient, context: DemoSeedContext): void {
  const now = context.now.toISOString()
  const simpleQueries = SIMPLE_QUERIES.map((query, index) => ({ id: `demo-summit-query-${index + 1}`, query }))
  const portfolioPlan = harborPlan(context, now)
  const planVersionId = 'demo-harbor-plan-v2'
  const execution = { providers: PROVIDERS.map(identity => identity.provider), models: Object.fromEntries(PROVIDERS.map(identity => [identity.provider, identity.requestedModel])) }
  const executionIdentity = buildMeasurementExecutionIdentity(execution, sha256(canonicalMeasurementExecutionIdentityJson(execution)))
  const planManifest = buildMeasurementRunManifestV1({
    expectedSlots: portfolioPlan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
      executionId: node.stableKey,
      queryText: node.queryText,
      provider,
      context: node.context.location,
      requestedModel: node.context.models[provider],
    }))),
  })

  db.transaction(tx => {
    tx.insert(projects).values([
      {
        id: context.simple.id, name: context.simple.name, displayName: context.simple.displayName,
        canonicalDomain: context.simple.domain, ownedDomains: [context.simple.domain], country: 'US', language: 'en',
        providers: PROVIDERS.map(identity => identity.provider), providerModels: Object.fromEntries(PROVIDERS.map(identity => [identity.provider, identity.requestedModel])),
        createdAt: now, updatedAt: now,
      },
      {
        id: context.portfolio.id, name: context.portfolio.name, displayName: context.portfolio.displayName,
        canonicalDomain: context.portfolio.domain, ownedDomains: [context.portfolio.domain], country: 'US', language: 'en',
        providers: PROVIDERS.map(identity => identity.provider), providerModels: Object.fromEntries(PROVIDERS.map(identity => [identity.provider, identity.requestedModel])),
        locations: harborLocations(), defaultLocation: 'Key West', createdAt: now, updatedAt: now,
      },
    ]).run()
    tx.insert(queries).values([
      ...simpleQueries.map(item => ({ id: item.id, projectId: context.simple.id, query: item.query, provenance: 'demo-core', createdAt: now })),
      ...portfolioPlan.querySnapshots.map(snapshot => ({ id: snapshot.queryId, projectId: context.portfolio.id, query: snapshot.queryText, provenance: 'demo-core', createdAt: now })),
    ]).run()
    tx.insert(competitors).values([
      { id: 'demo-summit-competitor-1', projectId: context.simple.id, domain: 'roofcraft.example', provenance: 'demo-core', createdAt: now },
      { id: 'demo-summit-competitor-2', projectId: context.simple.id, domain: 'everlast-roofing.example', provenance: 'demo-core', createdAt: now },
      { id: 'demo-harbor-competitor-1', projectId: context.portfolio.id, domain: 'seaside-collection.example', provenance: 'demo-core', createdAt: now },
      { id: 'demo-harbor-competitor-2', projectId: context.portfolio.id, domain: 'coastal-stays.example', provenance: 'demo-core', createdAt: now },
    ]).run()
    tx.insert(measurementPlanVersions).values({
      id: planVersionId, projectId: context.portfolio.id, revision: 2,
      canonicalJson: canonicalMeasurementPlanV2Json(portfolioPlan), checksum: sha256(canonicalMeasurementPlanV2Json(portfolioPlan)),
      schemaVersion: 2, compiledChecksum: portfolioPlan.compiledChecksum, publishedBy: 'demo-reviewed', createdAt: now,
    }).run()
    tx.insert(measurementPlans).values({ projectId: context.portfolio.id, activeVersionId: planVersionId, createdAt: now, updatedAt: now }).run()
    tx.insert(measurementSegments).values([
      ...portfolioPlan.targets.map(target => ({ id: `segment-${target.stableKey}`, projectId: context.portfolio.id, stableKey: target.stableKey, kind: 'target' as const, createdAt: now })),
      ...portfolioPlan.groups.map(group => ({ id: `segment-${group.stableKey}`, projectId: context.portfolio.id, stableKey: group.stableKey, kind: 'group' as const, createdAt: now })),
    ]).run()
    tx.insert(measurementPlanDrafts).values({
      id: 'demo-harbor-authoring-draft', projectId: context.portfolio.id, schemaVersion: 2,
      baseActiveVersionId: planVersionId, baseActiveRevision: 2, authoringJson: JSON.stringify(harborDraft(portfolioPlan)), etagVersion: 7,
      createdBy: JSON.stringify({ kind: 'system', id: 'demo', label: 'Demo authoring' }),
      updatedBy: JSON.stringify({ kind: 'system', id: 'demo', label: 'Demo authoring' }), createdAt: now, updatedAt: now,
    }).run()

    for (let week = 5; week >= 0; week--) {
      const createdAt = isoAtWeek(context.now, week)
      const simpleRunId = `demo-summit-week-${6 - week}`
      const simpleDefinition = buildSimpleMeasurementDefinition({
        capturedAt: createdAt,
        identity: { displayName: context.simple.displayName, aliases: ['Summit', 'Summit Roofing'], canonicalDomain: context.simple.domain, ownedDomains: [context.simple.domain] },
        country: 'US', language: 'en', location: null,
        engines: PROVIDERS.map(identity => ({ provider: identity.provider, requestedModel: identity.requestedModel })),
        competitors: [
          { domain: 'roofcraft.example', label: 'RoofCraft', aliases: ['RoofCraft'] },
          { domain: 'everlast-roofing.example', label: 'Everlast Roofing', aliases: ['Everlast'] },
        ],
        queries: simpleQueries.map(item => ({ queryId: item.id, queryText: item.query, provenance: 'demo-core' })),
      })
      tx.insert(runs).values({ id: simpleRunId, projectId: context.simple.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual', queries: simpleQueries.map(item => item.query), startedAt: createdAt, finishedAt: createdAt, createdAt }).run()
      tx.insert(simpleMeasurementDefinitions).values({
        runId: simpleRunId, projectId: context.simple.id, definition: simpleDefinition,
        checksum: sha256(canonicalSimpleMeasurementDefinitionJson(simpleDefinition)), capturedAt: createdAt,
      }).run()
      tx.insert(querySnapshots).values(simpleQueries.flatMap((query, queryIndex) => PROVIDERS.map((identity, providerIndex) => {
        const cited = (week + queryIndex + providerIndex) % 3 !== 0
        return {
          id: `${simpleRunId}-${identity.provider}-${queryIndex}`, runId: simpleRunId, queryId: query.id, queryText: query.query,
          provider: identity.provider, model: identity.requestedModel, servedModel: identity.servedModel,
          citationState: cited ? 'cited' : 'not-cited', answerMentioned: cited,
          answerText: cited ? `Fictional answer: Summit Roofing is a local option for ${query.query}.` : `Fictional answer: RoofCraft is discussed for ${query.query}.`,
          citedDomains: cited ? [context.simple.domain] : ['roofcraft.example'], citedUrls: cited ? [`https://${context.simple.domain}/services/${queryIndex + 1}`] : ['https://roofcraft.example/guide'],
          captureStatus: 'complete' as const, sourceCount: 1, resolvedCount: 1, captureVersion: 1, retrievalStatus: 'used' as const,
          competitorOverlap: cited ? [] : ['roofcraft.example'], recommendedCompetitors: cited ? ['roofcraft.example'] : ['everlast-roofing.example'], createdAt,
        }
      }))).run()

      const portfolioRunId = `demo-harbor-week-${6 - week}`
      tx.insert(runs).values({
        id: portfolioRunId, projectId: context.portfolio.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
        measurementPlanVersionId: planVersionId, measurementManifest: planManifest, measurementExecutionIdentity: executionIdentity, startedAt: createdAt, finishedAt: createdAt, createdAt,
      }).run()
      tx.insert(querySnapshots).values(portfolioPlan.executionNodes.flatMap((node, nodeIndex) => PROVIDERS.map((identity, providerIndex) => {
        const target = portfolioPlan.targets.find(candidate => node.stableKey.includes(candidate.stableKey))!
        const cited = !(week === 0 && identity.provider === 'gemini' && node.stableKey.endsWith('nonbrand')) && (week + nodeIndex + providerIndex) % 4 !== 0
        const competitor = providerIndex === 1 ? 'coastal-stays.example' : 'seaside-collection.example'
        return {
          id: `${portfolioRunId}-${node.stableKey}-${identity.provider}`, runId: portfolioRunId, queryId: node.queryId, queryText: node.queryText,
          provider: identity.provider, model: identity.requestedModel, servedModel: identity.servedModel,
          citationState: cited ? 'cited' : 'not-cited', answerMentioned: cited,
          answerText: cited ? `Fictional answer: ${target.label} is a Harbor Resorts option for this stay.` : `Fictional answer: ${providerIndex === 1 ? 'Coastal Stays' : 'Seaside Collection'} is recommended instead.`,
          citedDomains: cited ? [context.portfolio.domain] : [competitor],
          citedUrls: cited ? [`https://${context.portfolio.domain}${target.urlMatchers[0]!.kind === 'prefix' ? target.urlMatchers[0].pathPrefix : '/'}`] : [`https://${competitor}/guides/luxury-stays`],
          captureStatus: 'complete' as const, sourceCount: 1, resolvedCount: 1, captureVersion: 1, retrievalStatus: 'used' as const,
          competitorOverlap: cited ? [] : [competitor], recommendedCompetitors: [competitor], measurementExecutionId: node.stableKey,
          requestedContext: node.context.location, supportedContext: { status: 'applied' as const, resolved: node.context.location }, location: node.context.location!.label, createdAt,
        }
      }))).run()
    }
  })
}
