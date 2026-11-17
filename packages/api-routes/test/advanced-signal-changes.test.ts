import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { canonicalMeasurementPlanJson, compileMeasurementPlan, RunStatuses } from '@canonry/canonry-contracts'
import { createClient, measurementPlanVersions, migrate, projects, runs, type DatabaseClient } from '@canonry/canonry-db'
import { readAdvancedSignalTransitions } from '../src/index.js'
import { measurementPlanV2Fixture, publishPlanV2, seedPlanV2Sweep, type PlanV2Answer } from './measurement-plan-v2-fixture.js'

/**
 * The per-Property changes a custom-portfolio sweep made since the comparable
 * sweep before it: what the change webhooks send. Mention and citation are
 * read from the frozen plan for each Property, apart, never from the
 * project-level snapshot columns.
 */

const FIRST = '2026-09-01T00:00:00.000Z'
const SECOND = '2026-09-08T00:00:00.000Z'
const PROJECT_ID = 'proj_northstar'
const HARBOR_URL = 'https://northstar.example/locations/harbor/details'
const BAYSIDE_URL = 'https://northstar.example/locations/bayside/details'

let directory: string
let db: DatabaseClient

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-advanced-changes-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    country: 'US', language: 'en', createdAt: FIRST, updatedAt: FIRST,
  }).run()
})

afterEach(() => {
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

type NearbyAnswers = Record<'openai' | 'gemini', PlanV2Answer>

const NOTHING_NAMED: PlanV2Answer = { answerText: 'No property names are supplied.' }

/**
 * One whole-plan sweep. `exec-nearby` is assigned to both Properties; the
 * branded `exec-brand` query is assigned to Harbor and names only the
 * project brand, so it never moves.
 */
function sweep(runId: string, versionId: string, createdAt: string, nearby: NearbyAnswers, options: { models?: string; status?: typeof RunStatuses.partial } = {}) {
  seedPlanV2Sweep(db, {
    projectId: PROJECT_ID, runId, versionId, plan: measurementPlanV2Fixture(), createdAt, ...options,
    answer: slot => slot.executionId === 'exec-nearby'
      ? nearby[slot.provider as keyof NearbyAnswers]
      : { answerText: 'Northstar is reliable.' },
  })
}

function nearby(provider: 'openai' | 'gemini', property: 'Harbor' | 'Bayside') {
  return { query: 'homes near harbor', queryId: 'q-nearby', provider, location: 'Harbor', queryClass: 'non-brand', markets: [],
    property: property === 'Harbor' ? { key: 'harbor', label: 'Harbor Homes' } : { key: 'bayside', label: 'Bayside Homes' } }
}

it('reports each Property\'s mention and citation changes apart, in both directions', () => {
  const versionId = publishPlanV2(db, PROJECT_ID, measurementPlanV2Fixture(), FIRST)
  sweep('run_1', versionId, FIRST, {
    openai: { answerText: 'Harbor Homes is recommended.', citedUrls: [HARBOR_URL] },
    gemini: NOTHING_NAMED,
  })
  sweep('run_2', versionId, SECOND, {
    openai: { answerText: 'Bayside Homes is recommended.', citedUrls: [BAYSIDE_URL] },
    // Named without a source: a mention gained, no citation.
    gemini: { answerText: 'Harbor Homes is recommended.' },
  })

  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_2')).toEqual({
    state: 'available',
    previousRunId: 'run_1',
    mention: [
      { ...nearby('gemini', 'Harbor'), from: 'not-mentioned', to: 'mentioned' },
      { ...nearby('openai', 'Bayside'), from: 'not-mentioned', to: 'mentioned' },
      { ...nearby('openai', 'Harbor'), from: 'mentioned', to: 'not-mentioned' },
    ],
    citation: [
      { ...nearby('openai', 'Bayside'), from: 'not-cited', to: 'cited' },
      { ...nearby('openai', 'Harbor'), from: 'cited', to: 'not-cited' },
    ],
  })
})

it('reads a Property from the plan, never from the project-level columns', () => {
  const versionId = publishPlanV2(db, PROJECT_ID, measurementPlanV2Fixture(), FIRST)
  // The project-level columns flip on every answer; no Property's answer changes.
  const stored = (citationState: 'cited' | 'not-cited', answerMentioned: boolean): NearbyAnswers => ({
    openai: { ...NOTHING_NAMED, citationState, answerMentioned },
    gemini: { ...NOTHING_NAMED, citationState, answerMentioned },
  })
  sweep('run_1', versionId, FIRST, stored('cited', true))
  sweep('run_2', versionId, SECOND, stored('not-cited', false))
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_2')).toEqual({ state: 'available', previousRunId: 'run_1', mention: [], citation: [] })
})

it('treats an answer whose mention or citation is unknown as no change', () => {
  const versionId = publishPlanV2(db, PROJECT_ID, measurementPlanV2Fixture(), FIRST)
  sweep('run_1', versionId, FIRST, {
    openai: { answerText: 'Harbor Homes is recommended.', citedUrls: [HARBOR_URL] },
    gemini: NOTHING_NAMED,
  })
  sweep('run_2', versionId, SECOND, {
    // No answer text kept, and a source capture that missed sources.
    openai: { answerText: null, captureStatus: 'partial' },
    gemini: NOTHING_NAMED,
  })
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_2')).toEqual({ state: 'available', previousRunId: 'run_1', mention: [], citation: [] })
})

it.each([
  { name: 'the first sweep', setup: (versionId: string) => sweep('run_2', versionId, SECOND, { openai: NOTHING_NAMED, gemini: NOTHING_NAMED }), reason: 'no-previous-check' },
  { name: 'a change of models', setup: (versionId: string) => {
    sweep('run_1', versionId, FIRST, { openai: { answerText: 'Harbor Homes is recommended.' }, gemini: NOTHING_NAMED })
    sweep('run_2', versionId, SECOND, { openai: NOTHING_NAMED, gemini: NOTHING_NAMED }, { models: 'another-model-series' })
  }, reason: 'model-changed' },
  { name: 'a partial sweep', setup: (versionId: string) => {
    sweep('run_1', versionId, FIRST, { openai: { answerText: 'Harbor Homes is recommended.' }, gemini: NOTHING_NAMED })
    sweep('run_2', versionId, SECOND, { openai: NOTHING_NAMED, gemini: NOTHING_NAMED }, { status: RunStatuses.partial })
  }, reason: 'partial-run' },
])('compares nothing after $name', ({ setup, reason }) => {
  setup(publishPlanV2(db, PROJECT_ID, measurementPlanV2Fixture(), FIRST))
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_2')).toEqual({ state: 'unavailable', reason })
})

it('leaves a planless run, or one of a schema v1 revision, to its project-level changes', () => {
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_2')).toBeNull()
  const versionId = publishPlanV2(db, PROJECT_ID, measurementPlanV2Fixture(), FIRST)
  sweep('run_1', versionId, FIRST, { openai: NOTHING_NAMED, gemini: NOTHING_NAMED })
  // A sweep of an older schema v1 revision completing after the v2 plan was published.
  const legacyPlan = compileMeasurementPlan({
    schemaVersion: 1,
    targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'host', host: 'northstar.example' }], aliases: ['Harbor Homes'] }],
    groups: [],
    targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
  }, {
    canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'],
    trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }], locations: [], defaultContext: null, expectedSnapshots: 1,
  })
  db.insert(measurementPlanVersions).values({
    id: 'legacy-version', projectId: PROJECT_ID, revision: 0, canonicalJson: canonicalMeasurementPlanJson(legacyPlan), checksum: 'd'.repeat(64), schemaVersion: 1, createdAt: FIRST,
  }).run()
  db.insert(runs).values({
    id: 'legacy-run', projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: 'legacy-version', createdAt: SECOND, finishedAt: SECOND,
  }).run()
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'legacy-run')).toBeNull()
  // The v2 sweep itself is still read per Property.
  expect(readAdvancedSignalTransitions(db, PROJECT_ID, 'run_1')).toEqual({ state: 'unavailable', reason: 'no-previous-check' })
})
