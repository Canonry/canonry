import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverWebhook } from '@canonry/canonry-api-routes'
import type { WebhookPayload } from '@canonry/canonry-contracts'
import { createClient, migrate, notifications, projects, queries, type DatabaseClient } from '@canonry/canonry-db'
import { measurementPlanV2Fixture, publishPlanV2, seedPlanV2Sweep, type PlanV2Answer } from '../../api-routes/test/measurement-plan-v2-fixture.js'
import { Notifier } from '../src/notifier.js'

vi.mock('@canonry/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@canonry/canonry-api-routes')>()
  return {
    ...actual,
    resolveWebhookTarget: vi.fn(async (url: string) => ({
      ok: true, target: { url: new URL(url), address: '203.0.113.1', family: 4 },
    })),
    deliverWebhook: vi.fn(),
  }
})

/**
 * Change webhooks on a custom portfolio: each transition is one Property's
 * answer read from the frozen plan, never the project-level snapshot columns,
 * which describe the project's own brand and domain.
 */

const FIRST = '2026-09-01T00:00:00.000Z'
const SECOND = '2026-09-08T00:00:00.000Z'
const PROJECT_ID = 'proj_northstar'
const HARBOR_URL = 'https://northstar.example/locations/harbor/details'
const NOTHING_NAMED: PlanV2Answer = { answerText: 'No property names are supplied.' }

let directory: string
let db: DatabaseClient

beforeEach(() => {
  vi.mocked(deliverWebhook).mockReset().mockResolvedValue({ status: 204, error: null })
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-notifier-advanced-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    country: 'US', language: 'en', createdAt: FIRST, updatedAt: FIRST,
  }).run()
  db.insert(queries).values([
    { id: 'q-nearby', projectId: PROJECT_ID, query: 'homes near harbor', createdAt: FIRST },
    { id: 'q-brand', projectId: PROJECT_ID, query: 'northstar reviews', createdAt: FIRST },
  ]).run()
  db.insert(notifications).values({
    id: 'hook', projectId: PROJECT_ID, channel: 'webhook', enabled: true,
    config: { url: 'https://hooks.example/canonry', events: ['run.completed', 'citation.lost', 'citation.gained', 'mention.lost', 'mention.gained'] },
    createdAt: FIRST, updatedAt: FIRST,
  }).run()
})

afterEach(() => {
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

/**
 * Two sweeps in which OpenAI stops naming and citing Harbor Homes, while every
 * project-level column flips: an alert read from those columns would name
 * both queries, and the branded one moved for no Property.
 */
function seedSweeps(secondModels?: string) {
  const plan = measurementPlanV2Fixture()
  const versionId = publishPlanV2(db, PROJECT_ID, plan, FIRST)
  const sweep = (runId: string, createdAt: string, harborNamed: boolean, models?: string) => seedPlanV2Sweep(db, {
    projectId: PROJECT_ID, runId, versionId, plan, createdAt, withQueryIds: true, ...(models ? { models } : {}),
    answer: slot => {
      const projectLevel = { citationState: harborNamed ? 'cited' : 'not-cited', answerMentioned: harborNamed } as const
      if (slot.executionId === 'exec-nearby' && slot.provider === 'openai' && harborNamed) {
        return { answerText: 'Harbor Homes is recommended.', citedUrls: [HARBOR_URL], ...projectLevel }
      }
      return { ...NOTHING_NAMED, ...projectLevel }
    },
  })
  sweep('run_1', FIRST, true)
  sweep('run_2', SECOND, false, secondModels)
}

function payload(event: WebhookPayload['event'], transitions: WebhookPayload['transitions']): WebhookPayload {
  return {
    source: 'canonry', event,
    project: { name: 'northstar', canonicalDomain: 'northstar.example' },
    run: { id: 'run_2', status: 'completed', finishedAt: SECOND },
    transitions, dashboardUrl: 'https://canonry.test/projects/northstar',
  }
}

const HARBOR_OPENAI = {
  query: 'homes near harbor', provider: 'openai', location: 'Harbor', queryClass: 'non-brand' as const,
  property: { key: 'harbor', label: 'Harbor Homes' }, markets: [],
}

it('sends each Property\'s lost citation and lost mention, not the project-level changes', async () => {
  seedSweeps()
  await new Notifier(db, 'https://canonry.test').onRunCompleted('run_2', PROJECT_ID)
  const lostCitation = [{ ...HARBOR_OPENAI, from: 'cited', to: 'not-cited' }]
  expect(vi.mocked(deliverWebhook).mock.calls.map(([, body]) => body)).toEqual([
    payload('run.completed', lostCitation),
    payload('citation.lost', lostCitation),
    payload('mention.lost', [{ ...HARBOR_OPENAI, from: 'mentioned', to: 'not-mentioned' }]),
  ])
})

it('sends no change when the sweep cannot be compared with the one before it', async () => {
  seedSweeps('another-model-series')
  await new Notifier(db, 'https://canonry.test').onRunCompleted('run_2', PROJECT_ID)
  expect(vi.mocked(deliverWebhook).mock.calls.map(([, body]) => body)).toEqual([payload('run.completed', [])])
})
