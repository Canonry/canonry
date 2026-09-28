/** Synthetic source rows only. All admission, classification and reads use the installed package. */
import { createHash } from 'node:crypto'
import {
  apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries,
  querySnapshots, runs, simpleMeasurementDefinitions,
} from '../packages/db/src/index.js'
import { buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, measurementPlanV2Schema } from '../packages/contracts/src/index.js'
import { buildMeasurementPlanV2Manifest } from '../packages/api-routes/src/measurement-report-adapter.js'
import { SMOKE_ADMIN, SMOKE_READ, SMOKE_SCOPED, SMOKE_NOW } from './sentiment-smoke-seed.js'

export const ENGINE_SIMPLE_QUERY = 'Reliable repair services in Aurora City'
export const ENGINE_ADVANCED_QUERY = 'Best apartments in Harbor and Marina'
const engines = ['openai', 'gemini', 'claude', 'perplexity'] as const
const model = (provider: string) => `synthetic-${provider}-requested`
const served = (provider: string) => `synthetic-${provider}-served`
export function seedSentimentEngineSmoke(database: string): void {
  if (!database.startsWith('/tmp/canonry-sentiment-engines-') || !database.endsWith('/synthetic.sqlite')) throw new Error('Engine smoke can only seed its task-owned synthetic database')
  const db = createClient(database)
  try {
    migrate(db)
    const now = SMOKE_NOW
    for (const name of ['simple', 'advanced']) db.insert(projects).values({ id: name, name, displayName: name === 'simple' ? 'Aurora Service' : 'Northstar Homes', canonicalDomain: `${name}.example`, country: 'US', language: 'en', providers: name === 'simple' ? [...engines] : ['openai', 'gemini'], createdAt: now, updatedAt: now }).run()
    for (const [id, token, scopes, projectId] of [['admin', SMOKE_ADMIN, ['*'], null], ['read', SMOKE_READ, ['read'], null], ['scoped', SMOKE_SCOPED, ['read'], 'simple']] as const) {
      db.insert(apiKeys).values({ id, name: `Synthetic ${id}`, keyHash: createHash('sha256').update(token).digest('hex'), keyPrefix: token.slice(0, 9), scopes: [...scopes], projectId, createdAt: now }).run()
    }
    db.insert(queries).values({ id: 'simple-query', projectId: 'simple', query: ENGINE_SIMPLE_QUERY, createdAt: now }).run()
    db.insert(runs).values({ id: 'simple-run', projectId: 'simple', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    const definition = buildSimpleMeasurementDefinition({ capturedAt: now, identity: { displayName: 'Aurora Service', aliases: ['Aurora Service'], canonicalDomain: 'https://aurora.example', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: engines.map(provider => ({ provider, requestedModel: model(provider) })), queries: [{ queryId: 'simple-query', queryText: ENGINE_SIMPLE_QUERY, provenance: null }] })
    db.insert(simpleMeasurementDefinitions).values({ runId: 'simple-run', projectId: 'simple', definition, checksum: createHash('sha256').update(JSON.stringify(definition)).digest('hex'), capturedAt: now }).run()
    for (const provider of engines) db.insert(querySnapshots).values({ id: `simple-${provider}`, runId: 'simple-run', queryId: 'simple-query', queryText: ENGINE_SIMPLE_QUERY, provider, model: model(provider), servedModel: served(provider), answerText: provider === 'claude' ? 'Beacon Repairs provides dependable service. Customers recommend Beacon Repairs.' : provider === 'gemini' ? 'Aurora Service at aurora.example provides poor service and unreliable repairs. I recommend avoiding Aurora Service.' : 'Aurora Service at aurora.example provides excellent service and reliable repairs. I strongly recommend Aurora Service.', citationState: provider === 'claude' ? 'not-cited' : 'cited', answerMentioned: provider !== 'claude', createdAt: now }).run()

    const contexts = [{ provider: 'openai', location: { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' } }, { provider: 'gemini', location: { label: 'Marina', city: 'Marina', region: 'EX', country: 'US' } }]
    const usageEdges = contexts.flatMap(({ provider }) => ['harbor', 'bayside'].map(targetKey => ({ executionNodeKey: `node-${provider}`, targetKey, queryId: 'advanced-query' })))
    const plan = measurementPlanV2Schema.parse({ schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'northstar.example', ownedHosts: ['northstar.example'], names: ['Northstar Homes'] } },
      targets: ['harbor', 'bayside'].map(key => ({ stableKey: key, label: `${key === 'harbor' ? 'Harbor' : 'Bayside'} Homes`, aliases: [`${key === 'harbor' ? 'Harbor' : 'Bayside'} Homes`], identityAliases: [], urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: `/${key}`, pathCase: 'insensitive' }], mentionNotApplicable: false, discoveryIdentity: null })),
      groups: [{ stableKey: 'regional', label: 'Regional', targetKeys: ['harbor', 'bayside'], competitors: [] }],
      querySnapshots: [{ queryId: 'advanced-query', queryText: ENGINE_ADVANCED_QUERY, provenance: { source: 'manual', sourceId: null, capturedAt: now } }],
      assignments: usageEdges.map(edge => ({ ...edge, queryClass: 'non-brand' })),
      executionNodes: contexts.map(({ provider, location }) => ({ stableKey: `node-${provider}`, queryId: 'advanced-query', queryText: ENGINE_ADVANCED_QUERY, context: { providers: [provider], models: { [provider]: model(provider) }, location }, expectedSnapshots: 1 })),
      usageEdges, reportingScopes: [
        { stableKey: 'market-all', label: 'All properties', kind: 'market', usageEdges },
        { stableKey: 'market-harbor', label: 'Harbor property', kind: 'market', usageEdges: usageEdges.filter(edge => edge.targetKey === 'harbor') },
      ], compiledChecksum: 'd'.repeat(64),
    })
    db.insert(queries).values({ id: 'advanced-query', projectId: 'advanced', query: ENGINE_ADVANCED_QUERY, createdAt: now }).run()
    db.insert(measurementPlanVersions).values({ id: 'advanced-plan', projectId: 'advanced', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'd'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    db.insert(measurementPlans).values({ projectId: 'advanced', activeVersionId: 'advanced-plan', createdAt: now, updatedAt: now }).run()
    db.insert(runs).values({ id: 'advanced-run', projectId: 'advanced', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'advanced-plan', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { schemaVersion: 1, providers: ['openai', 'gemini'], models: { openai: model('openai'), gemini: model('gemini') }, checksum: 'e'.repeat(64), language: 'en' }, createdAt: now, finishedAt: now }).run()
    for (const { provider, location } of contexts) db.insert(querySnapshots).values({ id: `advanced-${provider}`, runId: 'advanced-run', queryId: 'advanced-query', queryText: ENGINE_ADVANCED_QUERY, measurementExecutionId: `node-${provider}`, requestedContext: location, location: location.label, supportedContext: { status: 'applied', resolved: location }, provider, model: model(provider), servedModel: served(provider), answerText: provider === 'openai' ? 'Harbor Homes at northstar.example/harbor is excellent and strongly recommended. Bayside Homes at northstar.example/bayside is poorly managed and should be avoided.' : 'Harbor Homes at northstar.example/harbor is poorly managed and should be avoided. Bayside Homes at northstar.example/bayside is excellent and strongly recommended.', citationState: 'cited', answerMentioned: true, createdAt: now }).run()
  } finally { db.$client.close() }
}
