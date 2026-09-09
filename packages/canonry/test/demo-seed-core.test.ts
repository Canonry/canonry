import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createDemoSeedContext } from '../src/demo/types.js'
import { seedDemoCore } from '../src/demo/seed-core.js'

const NOW = new Date('2026-09-09T12:00:00.000Z')

describe('seedDemoCore', () => {
  let directory: string
  let db: DatabaseClient
  let app: FastifyInstance

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-core-'))
    db = createClient(path.join(directory, 'demo.db'))
    migrate(db)
    seedDemoCore(db, createDemoSeedContext(NOW))
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    db?.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('populates the simple report with classified questions, cited and missing answers, and six weekly snapshots', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/summit-roofing/visibility-report?queryClass=all' })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      selection: { mode: string }
      populations: Array<{ queryClass: string; trend: unknown[]; summary: { citationCoverage: { rate: number | null } } }>
    }
    expect(body.selection.mode).toBe('simple')
    expect(body.populations.every(population => population.trend.length === 6)).toBe(true)
    expect(new Set(body.populations.map(population => population.queryClass))).toEqual(new Set(['branded', 'non-brand', 'unknown']))
    expect(body.populations.find(population => population.queryClass === 'non-brand')!.summary.citationCoverage.rate).toBeLessThan(1)
  })

  it('keeps the portfolio history comparable under its unchanged engine and model selection', async () => {
    const response = await app.inject('/api/v1/projects/harbor-resorts/visibility-report?queryClass=non-brand')
    expect(response.statusCode).toBe(200)
    const trend = response.json().populations[0].trend as Array<{ continuity: { state: string } }>
    expect(trend).toHaveLength(6)
    expect(trend.slice(1).map(point => point.continuity.state)).toEqual(Array(5).fill('comparable'))
  })

  it('populates the custom portfolio overview and property evidence from a reviewed v2 plan', async () => {
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-resorts/measurement-overview?scope=property&targetKey=harbor-key-west-1',
    })
    const evidence = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-resorts/measurement-property-evidence?targetKey=harbor-key-west-1&queryClass=non-brand&shape=answers',
    })

    expect(overview.statusCode).toBe(200)
    expect(evidence.statusCode).toBe(200)
    const overviewBody = overview.json() as { scope: { kind: string }; properties: { items: Array<{ targetKey: string }> } }
    const evidenceBody = evidence.json() as {
      queryClass: string
      measurement: { state: string }
      answers: { items: Array<{ provider: string; cited: boolean | null }> }
    }
    expect(overviewBody.scope.kind).toBe('property')
    expect(overviewBody.properties.items.map(target => target.targetKey)).toContain('harbor-key-west-1')
    expect(evidenceBody.queryClass).toBe('non-brand')
    expect(evidenceBody.measurement.state).toBe('complete')
    expect(evidenceBody.answers.items.map(answer => answer.provider)).toEqual(expect.arrayContaining(['openai', 'gemini', 'claude']))
    expect(evidenceBody.answers.items.some(answer => answer.cited === false)).toBe(true)
  })
})
