import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, measurementPlans, measurementPlanVersions, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { parseStoredMeasurementPlanAnyVersion, type MeasurementPlanV2 } from '@ainyc/canonry-contracts'
import { createDemoSeedContext } from '../src/demo/types.js'
import { seedDemoCore } from '../src/demo/seed-core.js'
import { HARBOR_MARKETS } from '../src/demo/portfolio.js'

const NOW = new Date('2026-09-09T12:00:00.000Z')

describe('demo scope nesting (O5)', () => {
  let directory: string
  let db: DatabaseClient
  let app: FastifyInstance

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-scope-'))
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

  function loadPlan(): MeasurementPlanV2 {
    const project = db.select().from(projects).where(eq(projects.name, 'harbor-resorts')).get()!
    const planRow = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, project.id)).get()!
    const versionRow = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, planRow.activeVersionId)).get()!
    return parseStoredMeasurementPlanAnyVersion(versionRow.canonicalJson) as MeasurementPlanV2
  }

  it('nests every demo market reportingScope under its matching Group', () => {
    const plan = loadPlan()
    expect(plan.reportingScopes).toHaveLength(3)
    const groupKeyByStableKey = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, scope.groupKey]))
    expect(groupKeyByStableKey).toEqual(new Map([
      ['market-key-west', 'market-key-west'],
      ['market-coastal-maine', 'market-coastal-maine'],
      ['market-pacific-northwest', 'market-pacific-northwest'],
    ]))
    // Sanity: every market's groupKey names a Group that actually exists, holding exactly its market's properties.
    for (const market of HARBOR_MARKETS) {
      const scope = plan.reportingScopes!.find(candidate => candidate.stableKey === `market-${market.key}`)!
      const group = plan.groups.find(candidate => candidate.stableKey === scope.groupKey)!
      expect(group).toBeDefined()
      expect(new Set(scope.usageEdges.map(edge => edge.targetKey))).toEqual(new Set(group.targetKeys))
    }
  })

  it('reports scopeOptions with markets nested under their group and no duplicate root markets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/harbor-resorts/visibility-report?queryClass=non-brand' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      scopeOptions: Array<{ id: string; kind: string; parentGroupIds?: string[]; marketKeys?: string[] }>
    }

    const marketOptions = body.scopeOptions.filter(option => option.kind === 'market')
    expect(marketOptions).toHaveLength(3)
    for (const market of HARBOR_MARKETS) {
      const option = marketOptions.find(candidate => candidate.id === `market-${market.key}`)!
      expect(option).toBeDefined()
      expect(option.parentGroupIds).toEqual([`market-${market.key}`])
    }

    const groupOptions = body.scopeOptions.filter(option => option.kind === 'group')
    expect(groupOptions).toHaveLength(3)
    for (const market of HARBOR_MARKETS) {
      const option = groupOptions.find(candidate => candidate.id === `market-${market.key}`)!
      expect(option).toBeDefined()
      expect(option.marketKeys).toEqual([`market-${market.key}`])
    }

    const rootOptions = body.scopeOptions.filter(option => (option.parentGroupIds ?? []).length === 0 && option.kind !== 'project')
    const rootGroups = rootOptions.filter(option => option.kind === 'group')
    const rootMarkets = rootOptions.filter(option => option.kind === 'market')
    expect(rootGroups).toHaveLength(3)
    expect(rootMarkets).toHaveLength(0)
  })
})
