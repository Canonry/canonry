import { createHash } from 'node:crypto'
import {
  apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries,
  querySnapshots, runs, simpleMeasurementDefinitions,
} from '../packages/db/src/index.js'
import { buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, measurementPlanV2Schema } from '../packages/contracts/src/index.js'
import { buildMeasurementPlanV2Manifest } from '../packages/api-routes/src/measurement-report-adapter.js'

export const SMOKE_ADMIN = 'cnry_sentiment_synthetic_admin'
export const SMOKE_READ = 'cnry_sentiment_synthetic_read'
export const SMOKE_SCOPED = 'cnry_sentiment_synthetic_simple_scope'
export const SMOKE_NOW = '2026-09-28T00:00:00.000Z'
export function seedSentimentSmoke(database: string, options: { queryClass?: 'branded' | 'non-brand'; absentSubject?: boolean } = {}): void {
  const queryClass = options.queryClass ?? 'branded'
  const simpleQuery = queryClass === 'branded' ? 'Aurora Service reviews' : 'Reliable local repair services'
  const advancedQuery = queryClass === 'branded' ? 'Compare Harbor Homes and Bayside Homes in Harbor' : 'Best apartments in Harbor'
  const db = createClient(database)
  migrate(db)
  const now = SMOKE_NOW
  for (const name of ['simple', 'advanced']) db.insert(projects).values({ id: name, name, displayName: name === 'simple' ? 'Aurora Service' : 'Northstar Homes', canonicalDomain: `${name}.example`, country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now }).run()
  for (const [id, token, scopes, projectId] of [['admin', SMOKE_ADMIN, ['*'], null], ['read', SMOKE_READ, ['read'], null], ['scoped', SMOKE_SCOPED, ['read'], 'simple']] as const) {
    db.insert(apiKeys).values({ id, name: `Synthetic ${id}`, keyHash: createHash('sha256').update(token).digest('hex'), keyPrefix: token.slice(0, 9), scopes: [...scopes], projectId, createdAt: now }).run()
  }
  db.insert(queries).values({ id: 'simple-query', projectId: 'simple', query: simpleQuery, createdAt: now }).run()
  db.insert(runs).values({ id: 'simple-run', projectId: 'simple', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
  const simple = buildSimpleMeasurementDefinition({ capturedAt: now, identity: { displayName: 'Aurora Service', aliases: ['Aurora Service'], canonicalDomain: 'https://aurora.example', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'source-model' }], queries: [{ queryId: 'simple-query', queryText: simpleQuery, provenance: null }] })
  if (simple.queries[0]?.queryClass !== queryClass) throw new Error('Synthetic query must freeze the intended query class.')
  db.insert(simpleMeasurementDefinitions).values({ runId: 'simple-run', projectId: 'simple', definition: simple, checksum: createHash('sha256').update(JSON.stringify(simple)).digest('hex'), capturedAt: now }).run()
  db.insert(querySnapshots).values({ id: 'simple-answer', runId: 'simple-run', queryId: 'simple-query', queryText: simpleQuery, provider: 'openai', model: 'source-model', servedModel: 'source-model-v1', answerText: options.absentSubject ? 'Beacon Repairs provides dependable repairs. Customers recommend Beacon Repairs.' : 'Aurora Service at aurora.example provides excellent customer service and dependable repairs. Customers strongly recommend Aurora Service for its reliable quality.', citationState: options.absentSubject ? 'not-cited' : 'cited', answerMentioned: !options.absentSubject, createdAt: now }).run()
  const location = { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' }
  const usageEdges = ['harbor', 'bayside'].map(targetKey => ({ executionNodeKey: 'shared-answer', targetKey, queryId: 'advanced-query' }))
  const plan = measurementPlanV2Schema.parse({ schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northstar.example', ownedHosts: ['northstar.example'], names: ['Northstar Homes'] } },
    targets: ['harbor', 'bayside'].map(key => ({ stableKey: key, label: `${key === 'harbor' ? 'Harbor' : 'Bayside'} Homes`, aliases: [`${key === 'harbor' ? 'Harbor' : 'Bayside'} Homes`], identityAliases: [`${key === 'harbor' ? 'Harbor' : 'Bayside'} Homes in Harbor`], urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: `/${key}`, pathCase: 'insensitive' }], mentionNotApplicable: false, discoveryIdentity: null })),
    groups: [{ stableKey: 'regional', label: 'Regional', targetKeys: ['harbor', 'bayside'], competitors: [] }],
    querySnapshots: [{ queryId: 'advanced-query', queryText: advancedQuery, provenance: { source: 'manual', sourceId: null, capturedAt: now } }],
    assignments: usageEdges.map(edge => ({ ...edge, queryClass })),
    executionNodes: [{ stableKey: 'shared-answer', queryId: 'advanced-query', queryText: advancedQuery, context: { providers: ['openai'], models: { openai: 'source-model' }, location }, expectedSnapshots: 1 }],
    usageEdges, reportingScopes: [
      { stableKey: 'market-all', label: 'All properties', kind: 'market', usageEdges },
      { stableKey: 'market-harbor', label: 'Harbor property', kind: 'market', usageEdges: [usageEdges[0]] },
    ], compiledChecksum: 'b'.repeat(64),
  })
  db.insert(queries).values({ id: 'advanced-query', projectId: 'advanced', query: advancedQuery, createdAt: now }).run()
  db.insert(measurementPlanVersions).values({ id: 'advanced-plan', projectId: 'advanced', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'b'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
  db.insert(measurementPlans).values({ projectId: 'advanced', activeVersionId: 'advanced-plan', createdAt: now, updatedAt: now }).run()
  db.insert(runs).values({ id: 'advanced-run', projectId: 'advanced', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'advanced-plan', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { schemaVersion: 1, providers: ['openai'], models: { openai: 'source-model' }, checksum: 'c'.repeat(64), language: 'en' }, createdAt: now, finishedAt: now }).run()
  db.insert(querySnapshots).values({ id: 'advanced-answer', runId: 'advanced-run', queryId: 'advanced-query', queryText: advancedQuery, measurementExecutionId: 'shared-answer', requestedContext: location, location: location.label, supportedContext: { status: 'applied', resolved: location }, provider: 'openai', model: 'source-model', servedModel: 'source-model-v1', answerText: options.absentSubject ? 'Riverstone Apartments offers comfortable housing. Residents recommend Riverstone Apartments.' : 'Harbor Homes in Harbor at northstar.example/harbor is excellent, with reliable maintenance and helpful management. I strongly recommend Harbor Homes. Bayside Homes in Harbor at northstar.example/bayside is poorly managed, with unreliable maintenance and serious recurring problems. I would avoid Bayside Homes.', citationState: options.absentSubject ? 'not-cited' : 'cited', answerMentioned: !options.absentSubject, createdAt: now }).run()
  db.$client.close()
}
