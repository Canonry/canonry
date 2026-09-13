import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, eq, inArray } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { compileQueryClassifier, determineAnswerMentioned, effectiveBrandNames, effectiveDomains } from '@ainyc/canonry-contracts'
import { createClient, healthSnapshots, insights, migrate, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { seedDemoCore } from '../src/demo/seed-core.js'
import { summitRoofingInventory } from '../src/demo/site-inventories/summit-roofing.js'
import { createDemoSeedContext } from '../src/demo/types.js'

const context = createDemoSeedContext(new Date('2026-09-09T12:00:00.000Z'))
const DOMAIN = context.simple.domain
const ENGINES = ['openai', 'gemini', 'claude'] as const
const COMPETITORS = [{ name: 'RoofCraft', domain: 'roofcraft.example' }, { name: 'Everlast Roofing', domain: 'everlast-roofing.example' }]
const brandNames = effectiveBrandNames({ displayName: context.simple.displayName, aliases: ['Summit'], canonicalDomain: DOMAIN, ownedDomains: [DOMAIN] })
const classify = compileQueryClassifier(brandNames)!

type Row = typeof querySnapshots.$inferSelect

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let sweeps: Array<typeof runs.$inferSelect>
let rowsBySweep: Row[][]

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-summit-'))
  db = createClient(path.join(directory, 'demo.db'))
  migrate(db)
  seedDemoCore(db, context)
  sweeps = db.select().from(runs).where(eq(runs.projectId, context.simple.id)).orderBy(asc(runs.createdAt)).all()
  const rows = db.select().from(querySnapshots).where(inArray(querySnapshots.runId, sweeps.map(sweep => sweep.id))).all()
  rowsBySweep = sweeps.map(sweep => rows.filter(row => row.runId === sweep.id))
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  db?.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

const isCited = (row: Row) => row.citationState === 'cited'
const nonBrand = (rows: Row[]) => rows.filter(row => classify.classify(row.queryText) === 'non-brand')
const branded = (rows: Row[]) => rows.filter(row => classify.classify(row.queryText) === 'branded')

/** Per engine, per sweep (oldest first): share of that engine's non-brand answers with the signal. */
function nonBrandSeries(signal: (row: Row) => boolean): Record<string, number[]> {
  return Object.fromEntries(ENGINES.map(engine => [engine, rowsBySweep.map(rows => {
    const answers = nonBrand(rows).filter(row => row.provider === engine)
    return answers.filter(signal).length / answers.length
  })]))
}

async function read<T>(url: string): Promise<T> {
  const response = await app.inject(`/api/v1/projects/summit-roofing/${url}`)
  expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
  return response.json() as T
}

describe('Summit Roofing sweep history', () => {
  it('stores six sweeps of three engines over eight non-brand and two branded queries', () => {
    expect(sweeps.map(sweep => sweep.kind)).toEqual(Array(6).fill('answer-visibility'))
    for (const rows of rowsBySweep) {
      for (const engine of ENGINES) {
        expect(nonBrand(rows).filter(row => row.provider === engine)).toHaveLength(8)
        expect(branded(rows).filter(row => row.provider === engine)).toHaveLength(2)
      }
    }
  })

  it('produces these exact non-brand mention and citation rates per sweep and engine', () => {
    expect(nonBrandSeries(row => row.answerMentioned === true)).toEqual({
      openai: [0.25, 0.375, 0.375, 0.5, 0.625, 0.75],
      gemini: [0.5, 0.5, 0.5, 0.25, 0.375, 0.625],
      claude: [0.375, 0.125, 0.5, 0.25, 0.5, 0.375],
    })
    expect(nonBrandSeries(isCited)).toEqual({
      openai: [0.125, 0.25, 0.25, 0.375, 0.5, 0.625],
      gemini: [0.375, 0.375, 0.375, 0.125, 0.25, 0.375],
      claude: [0.25, 0.125, 0.25, 0.125, 0.375, 0.25],
    })
  })

  it('moves over time, differs by engine, and keeps mention and citation apart', () => {
    const mentioned = nonBrandSeries(row => row.answerMentioned === true)
    const cited = nonBrandSeries(isCited)
    for (const engine of ENGINES) {
      expect(new Set(mentioned[engine]).size, `${engine} mention series is constant`).toBeGreaterThan(1)
      expect(new Set(cited[engine]).size, `${engine} citation series is constant`).toBeGreaterThan(1)
      expect(mentioned[engine], `${engine} mention and citation series are identical`).not.toEqual(cited[engine])
    }
    expect(new Set(ENGINES.map(engine => JSON.stringify(mentioned[engine]))).size).toBeGreaterThanOrEqual(2)
    expect(new Set(ENGINES.map(engine => JSON.stringify(cited[engine]))).size).toBeGreaterThanOrEqual(2)
    const all = rowsBySweep.flat()
    expect(all.some(row => row.answerMentioned === true && !isCited(row))).toBe(true)
    expect(all.some(row => row.answerMentioned === false && isCited(row))).toBe(true)
  })

  it('keeps branded queries separate and nearly always mentioned', async () => {
    expect([...new Set(branded(rowsBySweep[0]!).map(row => row.queryText))].sort()).toEqual(['Summit Roofing reviews', 'Summit Roofing warranty'])
    const brandedRows = rowsBySweep.flatMap(branded)
    expect(brandedRows.filter(row => row.answerMentioned === true)).toHaveLength(35)
    expect(brandedRows).toHaveLength(36)

    const report = await read<{ populations: Array<{ queryClass: string; summary: { queryCount: number; mentionCoverage: { numerator: number; denominator: number } } }> }>('visibility-report?queryClass=all')
    const population = (queryClass: string) => report.populations.find(item => item.queryClass === queryClass)!.summary
    expect(population('branded')).toMatchObject({ queryCount: 2, mentionCoverage: { numerator: 6, denominator: 6 } })
    expect(population('non-brand')).toMatchObject({ queryCount: 8, mentionCoverage: { numerator: 14, denominator: 24 } })

    const metrics = await read<{ buckets: Array<{ mentionShare: { scope: string; projectMentionSnapshots: number } }> }>('analytics/metrics')
    expect(metrics.buckets.map(bucket => bucket.mentionShare.scope)).toEqual(Array(6).fill('non-brand'))
    expect(metrics.buckets.map(bucket => bucket.mentionShare.projectMentionSnapshots))
      .toEqual(rowsBySweep.map(rows => nonBrand(rows).filter(row => row.answerMentioned === true).length))
  })

  it('keeps every answer consistent with its flags, sources and named competitors', () => {
    const domains = effectiveDomains({ canonicalDomain: DOMAIN, ownedDomains: [DOMAIN] })
    const htmlPages = new Set(summitRoofingInventory().pages.filter(page => page.kind === 'html').map(page => page.path))
    for (const row of rowsBySweep.flat()) {
      const label = `${row.runId} ${row.provider} ${row.queryText}`
      const text = row.answerText!
      expect(determineAnswerMentioned(text, brandNames, domains), label).toBe(row.answerMentioned)
      if (!row.answerMentioned) expect(text, label).not.toMatch(/summit/i)
      expect(row.citedDomains.includes(DOMAIN), label).toBe(isCited(row))
      expect(row.citedUrls!.map(url => new URL(url).hostname), label).toEqual(row.citedDomains)
      expect(row.sourceCount, label).toBe(row.citedUrls!.length)
      for (const url of row.citedUrls!.filter(value => new URL(value).hostname === DOMAIN)) {
        expect(htmlPages.has(new URL(url).pathname), `${label} cites a missing page ${url}`).toBe(true)
      }
      for (const competitor of COMPETITORS) {
        const named = text.includes(competitor.name)
        expect(row.recommendedCompetitors.includes(competitor.name), `${label} ${competitor.name}`).toBe(named)
        expect(row.competitorOverlap.includes(competitor.domain), `${label} ${competitor.domain}`).toBe(named || row.citedDomains.includes(competitor.domain))
      }
    }
  })

  it('stores health and insights that agree with the stored answers', async () => {
    const health = db.select().from(healthSnapshots).where(eq(healthSnapshots.projectId, context.simple.id)).orderBy(asc(healthSnapshots.createdAt)).all()
    expect(health.map(row => row.runId)).toEqual(sweeps.map(sweep => sweep.id))
    for (const [index, row] of health.entries()) {
      const answers = rowsBySweep[index]!
      expect(row.mentionedPairs).toBe(answers.filter(answer => answer.answerMentioned === true).length)
      expect(row.citedPairs).toBe(answers.filter(isCited).length)
      for (const engine of ENGINES) {
        const engineAnswers = answers.filter(answer => answer.provider === engine)
        expect(row.providerBreakdown[engine]).toMatchObject({
          mentioned: engineAnswers.filter(answer => answer.answerMentioned === true).length,
          cited: engineAnswers.filter(isCited).length,
          total: 10,
        })
      }
    }
    const latestHealth = await read<{ runId: string; mentionedPairs: number; citedPairs: number }>('health/latest')
    expect(latestHealth).toMatchObject({ runId: sweeps.at(-1)!.id, mentionedPairs: health.at(-1)!.mentionedPairs, citedPairs: health.at(-1)!.citedPairs })

    const [previous, latest] = rowsBySweep.slice(-2) as [Row[], Row[]]
    const pair = (rows: Row[], query: string, provider: string) => rows.find(row => row.queryText === query && row.provider === provider)!
    const latestInsights = db.select().from(insights).where(eq(insights.runId, sweeps.at(-1)!.id)).all()
    const ofType = (type: string) => latestInsights.filter(insight => insight.type === type)
    expect(ofType('gain').length).toBeGreaterThan(0)
    expect(ofType('regression').length).toBeGreaterThan(0)
    expect(ofType('first-citation').length).toBeGreaterThan(0)
    for (const gain of ofType('gain')) {
      expect(isCited(pair(latest, gain.query, gain.provider)) && !isCited(pair(previous, gain.query, gain.provider)), gain.title).toBe(true)
    }
    for (const loss of ofType('regression')) {
      expect(!isCited(pair(latest, loss.query, loss.provider)) && isCited(pair(previous, loss.query, loss.provider)), loss.title).toBe(true)
    }
    for (const first of ofType('first-citation')) {
      expect(previous.some(row => row.queryText === first.query && isCited(row)), first.title).toBe(false)
    }
    expect(db.select().from(insights).where(eq(insights.runId, sweeps[0]!.id)).all()).toHaveLength(0)
  })

  it('reports real movement on the overview instead of a steady read', async () => {
    const [previous, latest] = rowsBySweep.slice(-2) as [Row[], Row[]]
    const queriesWith = (rows: Row[], signal: (row: Row) => boolean) => new Set(rows.filter(signal).map(row => row.queryText!))
    const moved = (signal: (row: Row) => boolean) => {
      const before = queriesWith(previous, signal)
      const after = queriesWith(latest, signal)
      return { gained: [...after].filter(query => !before.has(query)).sort(), lost: [...before].filter(query => !after.has(query)).sort() }
    }
    const overview = await read<{ mentionMovement: { gained: number; lost: number; tone: string; gainedQueries: string[]; lostQueries: string[] }; citationMovement: { gained: number; lost: number; tone: string; gainedQueries: string[]; lostQueries: string[] } }>('overview')
    for (const [movement, signal] of [[overview.mentionMovement, (row: Row) => row.answerMentioned === true], [overview.citationMovement, isCited]] as const) {
      const expected = moved(signal)
      expect([...movement.gainedQueries].sort()).toEqual(expected.gained)
      expect([...movement.lostQueries].sort()).toEqual(expected.lost)
      expect(movement.gained + movement.lost).toBeGreaterThan(0)
    }

    const metrics = await read<{ buckets: Array<{ byProvider: Record<string, { mentionRate: number; citationRate: number }> }> }>('analytics/metrics')
    for (const engine of ENGINES) {
      const stored = rowsBySweep.map(rows => rows.filter(row => row.provider === engine))
      expect(metrics.buckets.map(bucket => bucket.byProvider[engine]!.mentionRate)).toEqual(stored.map(rows => rows.filter(row => row.answerMentioned === true).length / rows.length))
      expect(metrics.buckets.map(bucket => bucket.byProvider[engine]!.citationRate)).toEqual(stored.map(rows => rows.filter(isCited).length / rows.length))
    }
  })
})
