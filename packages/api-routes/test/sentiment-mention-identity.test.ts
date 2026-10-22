import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  canonicalMeasurementPlanV2Json,
  storedSentimentClassifierInputSchema,
  type RunDetailDto,
  type SentimentClassifierOutput,
  type SentimentOutcome,
} from '@canonry/canonry-contracts'
import {
  createClient, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs,
  SentimentRepository, type DatabaseClient,
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { SentimentService } from '../src/sentiment-service.js'
import { refreshSnapshotMentionIdentity } from '../src/sentiment-mention-identity.js'
import { buildMeasurementPlanV2Manifest, buildMeasurementPlanV2ReportInput, v2UsageEdgeId } from '../src/measurement-report-adapter.js'
import { buildMeasurementEvidence, buildMeasurementReport } from '../src/measurement-report.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-10-22T00:00:00.000Z'
let db: DatabaseClient

beforeEach(() => {
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
})
afterEach(() => db.$client.close())

describe('sentiment identity verdicts on mentions', () => {
  it('reports a Simple name match judged wrong-subject as not mentioned, with the matched name and the reason', async () => {
    db.insert(queries).values({ id: 'q', projectId: 'p', query: 'best hardware stores', createdAt: NOW }).run()
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: NOW }).run()
    // As the sentiment completion stores them: the namesake's name still matches the text.
    db.insert(querySnapshots).values([
      { id: 's-namesake', runId: 'r', queryId: 'q', queryText: 'best hardware stores', provider: 'openai', citationState: 'not-cited', answerMentioned: false, mentionIdentity: 'wrong-subject', answerText: 'Acme Hardware on Main Street sells lumber.', createdAt: NOW },
      { id: 's-brand', runId: 'r', queryId: 'q', queryText: 'best hardware stores', provider: 'gemini', citationState: 'not-cited', answerMentioned: true, answerText: 'Acme is the best option.', createdAt: NOW },
    ]).run()
    const app = Fastify(); app.register(apiRoutes, { db, skipAuth: true }); await app.ready()
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/runs/r' })
      expect(response.statusCode, response.body).toBe(200)
      const byId = new Map((response.json() as RunDetailDto).snapshots!.map(snapshot => [snapshot.id, snapshot]))
      expect(byId.get('s-namesake')).toMatchObject({ answerMentioned: false, mentionState: 'not-mentioned', matchedTerms: ['Acme'], mentionIdentity: 'wrong-subject' })
      expect(byId.get('s-brand')).toMatchObject({ answerMentioned: true, mentionState: 'mentioned', matchedTerms: ['Acme'], mentionIdentity: null })
      // The project snapshot list serializes the same reason.
      const list = await app.inject({ method: 'GET', url: '/api/v1/projects/p/snapshots' })
      expect(list.statusCode, list.body).toBe(200)
      const listed = new Map((list.json() as { snapshots: RunDetailDto['snapshots'] }).snapshots!.map(snapshot => [snapshot.id, snapshot]))
      expect(listed.get('s-namesake')).toMatchObject({ answerMentioned: false, mentionState: 'not-mentioned', mentionIdentity: 'wrong-subject' })
      expect(listed.get('s-brand')).toMatchObject({ answerMentioned: true, mentionState: 'mentioned', mentionIdentity: null })
    } finally {
      await app.close()
    }
  })

  it('drops an Advanced Property\'s mention of an answer sentiment judged wrong-subject for it, and only that Property\'s', () => {
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    const manifest = buildMeasurementPlanV2Manifest(plan)
    db.insert(runs).values({ id: 'advanced', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: manifest, measurementExecutionIdentity: { language: 'en' }, createdAt: NOW }).run()
    for (const node of plan.executionNodes) {
      for (const provider of node.context.providers) {
        db.insert(querySnapshots).values({
          id: `${node.stableKey}-${provider}`, runId: 'advanced', measurementExecutionId: node.stableKey, queryText: node.queryText,
          provider, model: node.context.models[provider] ?? null, servedModel: `${provider}-served`,
          location: HARBOR_CONTEXT.label, requestedContext: HARBOR_CONTEXT, supportedContext: { status: 'applied', resolved: HARBOR_CONTEXT },
          answerText: 'Harbor Homes and Bayside Homes offer homes.', citationState: 'not-cited', createdAt: NOW,
        }).run()
      }
    }

    const service = new SentimentService(db, { install: () => ({ enabled: true, ready: true, reason: null, model: 'jev-1.13.0' }), now: () => new Date(NOW), previewSecret: 'identity-test' })
    service.configure('p', { enabled: true })
    for (const queryClass of ['branded', 'non-brand'] as const) {
      service.submit('p', service.preview('p', { runId: 'advanced', queryClass }).previewToken!, `advanced:${queryClass}`, 'fixture')
    }
    // The worker's completion: the verdict and the snapshot's mention fields commit together.
    const repository = new SentimentRepository(db)
    for (let work = repository.claim({ owner: 'test', now: NOW, leaseMs: 30_000 }); work; work = repository.claim({ owner: 'test', now: NOW, leaseMs: 30_000 })) {
      const input = storedSentimentClassifierInputSchema.parse(work.input)
      const outcome: SentimentOutcome = input.subject.id === 'harbor' ? 'wrong-subject' : 'favorable'
      const usage = { kind: 'reported' as const, inputTokens: 10, outputTokens: 1 }
      const result: SentimentClassifierOutput = outcome === 'favorable'
        ? { kind: 'classified', outcome, returnedModel: 'jev-1.13.0', usage, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null }
        : { kind: 'abstained', outcome, reason: 'The answer refers to another subject.', returnedModel: 'jev-1.13.0', usage }
      repository.completeWork({ workItemId: work.id, owner: 'test', now: NOW, outcome, result, returnedModel: 'jev-1.13.0' },
        (tx, completed) => { refreshSnapshotMentionIdentity(tx, [completed.snapshotId]) })
    }

    const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, 'advanced')).all()
    const harborNodes = new Set(plan.usageEdges.filter(edge => edge.targetKey === 'harbor').map(edge => edge.executionNodeKey))
    for (const snapshot of snapshots) {
      expect(snapshot.wrongSubjectTargetKeys).toEqual(harborNodes.has(snapshot.measurementExecutionId!) ? ['harbor'] : null)
      // The project-level brand mention is not a Property verdict's to change.
      expect(snapshot).toMatchObject({ answerMentioned: null, mentionIdentity: null })
    }

    const { input } = buildMeasurementPlanV2ReportInput(1, plan, manifest, snapshots)
    const targets = new Map(buildMeasurementReport(input).targets.map(target => [target.id, target.mentionCoverage]))
    const harborAnswers = snapshots.filter(snapshot => harborNodes.has(snapshot.measurementExecutionId!)).length
    const baysideAnswers = snapshots.filter(snapshot => plan.usageEdges.some(edge => edge.targetKey === 'bayside' && edge.executionNodeKey === snapshot.measurementExecutionId)).length
    expect(targets.get('harbor')).toMatchObject({ numerator: 0, denominator: harborAnswers, rate: 0 })
    expect(targets.get('bayside')).toMatchObject({ numerator: baysideAnswers, denominator: baysideAnswers, rate: 1 })

    const edgeTarget = new Map(plan.usageEdges.map(edge => [v2UsageEdgeId(edge), edge.targetKey]))
    const rows = buildMeasurementEvidence(input).answers.filter(row => row.usageEdgeType === 'target')
    expect(rows.filter(row => edgeTarget.get(row.usageEdgeId) === 'harbor').map(row => [row.mentioned, row.mentionIdentity]))
      .toEqual(Array.from({ length: harborAnswers }, () => [false, 'wrong-subject']))
    expect(rows.filter(row => edgeTarget.get(row.usageEdgeId) === 'bayside').map(row => [row.mentioned, row.mentionIdentity]))
      .toEqual(Array.from({ length: baysideAnswers }, () => [true, null]))
  })
})
