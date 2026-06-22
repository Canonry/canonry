import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, insights, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import type { InsightDto } from '@ainyc/canonry-contracts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })

// Five insights with distinct types/severities + ascending createdAt so the
// newest-first ordering (and `limit`) is deterministic. One is dismissed.
function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-insights-filters-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example.com',
    country: 'US', language: 'en', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
  }).run()

  const ins = (type: string, severity: string, t: string, dismissed = false) => ({
    id: crypto.randomUUID(), projectId, runId: null, type, severity,
    title: `${type} title`, query: 'q', provider: 'test', recommendation: null, cause: null,
    dismissed, createdAt: t,
  })
  db.insert(insights).values([
    ins('regression', 'critical', '2026-06-10T00:00:01.000Z'),
    ins('gbp-keyword-drop', 'high', '2026-06-10T00:00:02.000Z'),
    ins('gbp-cta-gap', 'medium', '2026-06-10T00:00:03.000Z'),
    ins('gbp-description-missing', 'low', '2026-06-10T00:00:04.000Z'),
    ins('gain', 'low', '2026-06-10T00:00:05.000Z'),
    ins('gbp-metric-drop', 'medium', '2026-06-10T00:00:06.000Z', true), // dismissed
  ]).run()

  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return { app }
}

async function list(app: ReturnType<typeof buildApp>['app'], qs: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/demo/insights${qs}` })
  return { status: res.statusCode, body: res.json() as InsightDto[] }
}

describe('GET /insights filters', () => {
  it('returns all non-dismissed insights with no filter', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '')
    expect(body.map((i) => i.type).sort()).toEqual(['gain', 'gbp-cta-gap', 'gbp-description-missing', 'gbp-keyword-drop', 'regression'])
  })

  it('--type exact returns only that type', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '?type=gbp-keyword-drop')
    expect(body.map((i) => i.type)).toEqual(['gbp-keyword-drop'])
  })

  it('--type prefix (gbp-*) returns only the gbp family (excludes dismissed)', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '?type=gbp-*')
    expect(body.map((i) => i.type).sort()).toEqual(['gbp-cta-gap', 'gbp-description-missing', 'gbp-keyword-drop'])
  })

  it('--severity is a minimum level (high returns high + critical)', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '?severity=high')
    expect(body.map((i) => i.severity).sort()).toEqual(['critical', 'high'])
  })

  it('--limit caps the newest-first result', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '?limit=2')
    // Newest two non-dismissed: gain (…05) then gbp-description-missing (…04).
    expect(body.map((i) => i.type)).toEqual(['gain', 'gbp-description-missing'])
  })

  it('combines type + severity', async () => {
    const { app } = buildApp()
    const { body } = await list(app, '?type=gbp-*&severity=medium')
    expect(body.map((i) => i.type).sort()).toEqual(['gbp-cta-gap', 'gbp-keyword-drop'])
  })

  it('rejects an invalid severity with 400', async () => {
    const { app } = buildApp()
    const { status } = await list(app, '?severity=urgent')
    expect(status).toBe(400)
  })

  it('rejects a non-positive / non-integer limit with 400', async () => {
    const { app } = buildApp()
    expect((await list(app, '?limit=0')).status).toBe(400)
    expect((await list(app, '?limit=abc')).status).toBe(400)
  })
})
