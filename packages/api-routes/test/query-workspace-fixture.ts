import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type HTTPMethods } from 'fastify'
import { eq } from 'drizzle-orm'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlanVersions,
  measurementPlans,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'

/** Isolated API fixture for the browser component's generated-SDK smoke test. */
export async function createQueryWorkspaceFixture(options: { advanced?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'query-workspace-api-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = '2026-08-28T10:00:00.000Z'
  const originalText = 'Where are apartments in Metro Alder?'
  const alderLocation = { label: 'metro-alder', city: 'Alder', region: 'MI', country: 'US' }
  db.insert(projects).values({
    id: 'project-demo',
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'demo.example',
    country: 'US',
    language: 'en',
    ...(options.advanced ? {
      providers: ['openai', 'gemini', 'perplexity'],
      providerModels: { openai: 'gpt-5', gemini: 'gemini-3-pro', perplexity: 'sonar-pro' },
      locations: [alderLocation],
      defaultLocation: alderLocation.label,
    } : {}),
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values([
    { id: 'query-original', projectId: 'project-demo', query: originalText, createdAt: now },
    { id: 'query-sibling', projectId: 'project-demo', query: 'Which apartments have a pool?', createdAt: now },
  ]).run()

  if (options.advanced) {
    const sourceContexts = {
      alder: { providers: ['openai', 'gemini'], models: { openai: 'gpt-5', gemini: 'gemini-3-pro' }, location: alderLocation },
      birch: { providers: ['perplexity'], models: { perplexity: 'sonar-pro' }, location: null },
      sibling: { providers: ['openai'], models: {}, location: alderLocation },
    }
    const candidate = measurementPlanV2Schema.parse({
      schemaVersion: 2,
      identities: {
        projectBrand: { canonicalHost: 'demo.example', ownedHosts: ['demo.example'], names: ['Demo'] },
      },
      targets: [
        {
          stableKey: 'metro-alder',
          label: 'Metro Alder',
          aliases: ['Metro Alder'],
          urlMatchers: [{ kind: 'prefix', host: 'demo.example', pathPrefix: '/apartments/alder', pathCase: 'insensitive' }],
          mentionNotApplicable: false,
          discoveryIdentity: null,
        },
        {
          stableKey: 'metro-birch',
          label: 'Metro Birch',
          aliases: ['Metro Birch'],
          urlMatchers: [{ kind: 'prefix', host: 'demo.example', pathPrefix: '/apartments/birch', pathCase: 'insensitive' }],
          mentionNotApplicable: false,
          discoveryIdentity: null,
        },
      ],
      groups: [{
        stableKey: 'metro-portfolio',
        label: 'Metro portfolio',
        targetKeys: ['metro-alder', 'metro-birch'],
        competitors: [{ stableKey: 'rival', label: 'Rival Apartments', domain: 'rival.example', aliases: ['Rival'] }],
      }],
      querySnapshots: [
        { queryId: 'query-original', queryText: originalText, provenance: { source: 'manual', sourceId: null, capturedAt: now } },
        { queryId: 'query-sibling', queryText: 'Which apartments have a pool?', provenance: { source: 'manual', sourceId: null, capturedAt: now } },
      ],
      assignments: [
        { targetKey: 'metro-alder', queryId: 'query-original', queryClass: 'non-brand', executionNodeKey: 'original-alder' },
        { targetKey: 'metro-birch', queryId: 'query-original', queryClass: 'branded', executionNodeKey: 'original-birch' },
        { targetKey: 'metro-alder', queryId: 'query-sibling', queryClass: 'non-brand', executionNodeKey: 'sibling-alder' },
      ],
      executionNodes: [
        { stableKey: 'original-alder', queryId: 'query-original', queryText: originalText, context: sourceContexts.alder, expectedSnapshots: 2 },
        { stableKey: 'original-birch', queryId: 'query-original', queryText: originalText, context: sourceContexts.birch, expectedSnapshots: 1 },
        { stableKey: 'sibling-alder', queryId: 'query-sibling', queryText: 'Which apartments have a pool?', context: sourceContexts.sibling, expectedSnapshots: 1 },
      ],
      usageEdges: [
        { executionNodeKey: 'original-alder', targetKey: 'metro-alder', queryId: 'query-original' },
        { executionNodeKey: 'original-birch', targetKey: 'metro-birch', queryId: 'query-original' },
        { executionNodeKey: 'sibling-alder', targetKey: 'metro-alder', queryId: 'query-sibling' },
      ],
      compiledChecksum: '0'.repeat(64),
    })
    const plan: MeasurementPlanV2 = measurementPlanV2Schema.parse({
      ...candidate,
      compiledChecksum: createHash('sha256').update(measurementPlanV2ChecksumJson(candidate)).digest('hex'),
    })
    const canonicalJson = canonicalMeasurementPlanV2Json(plan)
    const activeVersionId = 'plan-active-v2'
    db.insert(measurementPlanVersions).values({
      id: activeVersionId,
      projectId: 'project-demo',
      revision: 1,
      canonicalJson,
      checksum: createHash('sha256').update(canonicalJson).digest('hex'),
      schemaVersion: 2,
      compiledChecksum: plan.compiledChecksum,
      createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'project-demo', activeVersionId, createdAt: now, updatedAt: now }).run()
    db.insert(runs).values({
      id: 'run-old',
      projectId: 'project-demo',
      kind: 'answer-visibility',
      trigger: 'manual',
      status: 'completed',
      measurementPlanVersionId: activeVersionId,
      measurementManifest: buildMeasurementPlanV2Manifest(plan),
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    }).run()
    db.insert(querySnapshots).values(plan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
      id: `snapshot-${node.stableKey}-${provider}`,
      runId: 'run-old',
      queryId: node.queryId,
      queryText: node.queryText,
      provider,
      citationState: 'cited' as const,
      answerMentioned: true,
      answerText: 'Stored original answer.',
      citedDomains: ['demo.example'],
      citedUrls: [`https://demo.example/${node.stableKey}`],
      captureStatus: 'complete' as const,
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: node.context.location?.label ?? null,
      measurementExecutionId: node.stableKey,
      model: node.context.models[provider] ?? null,
      requestedContext: node.context.location,
      supportedContext: node.context.location ? { status: 'applied' as const, resolved: node.context.location } : null,
      createdAt: now,
    })))).run()
  } else {
    db.insert(runs).values({ id: 'run-old', projectId: 'project-demo', kind: 'answer-visibility', trigger: 'manual', status: 'completed', createdAt: now, finishedAt: now }).run()
    db.insert(querySnapshots).values({ id: 'snapshot-old', runId: 'run-old', queryId: 'query-original', queryText: null, provider: 'gemini', citationState: 'cited', citedDomains: ['demo.example'], competitorOverlap: [], recommendedCompetitors: [], answerText: 'Stored original answer.', createdAt: now }).run()
  }
  let requestedRuns = 0
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    getRunnableProviderNames: () => options.advanced ? ['openai', 'gemini', 'perplexity'] : ['gemini'],
    onRunCreated: () => { requestedRuns += 1 },
  })
  await app.ready()
  return {
    originalText,
    async request(method: string, url: string, payload?: string, headers: Record<string, string> = {}) {
      const response = await app.inject({
        method: method as HTTPMethods,
        url,
        headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
        payload,
      })
      return { body: response.body, status: response.statusCode }
    },
    catalog: () => db.select().from(queries).where(eq(queries.projectId, 'project-demo')).all(),
    snapshot: () => db.select().from(querySnapshots).get(),
    snapshots: () => db.select().from(querySnapshots).all(),
    runCount: () => db.select().from(runs).all().length,
    requestedRuns: () => requestedRuns,
    async close() {
      await app.close()
      db.$client.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}
