import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries } from '@ainyc/canonry-db'
import { buildSimpleMeasurementDefinition, effectiveBrandNames, type QueryClass } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { proposeQueryClass } from '../src/measurement-draft-compile.js'
import { projectQueryClassifier } from '../src/mention-share-inputs.js'

/**
 * ONE CLASSIFIER, CHECKED FROM THE OUTSIDE.
 *
 * Several server surfaces class the same tracked query: the query list, the
 * mention share inputs, the definition a simple sweep freezes, and the class an
 * advanced draft proposes. They are all meant to be `compileQueryClassifier`
 * over `effectiveBrandNames`. A surface that grows its own matching rule keeps
 * working and quietly moves queries between the branded and non-brand figures.
 *
 * `canonry-guards/no-second-query-classifier` catches that in source. This is
 * the other half: every surface is asked about one basket and compared with a
 * hand-written answer key, so the surfaces are never compared with each other's
 * output or with the classifier's own.
 */

// Stored raw, as project upsert and apply store it.
const IDENTITY = {
  displayName: 'Vexlo IQ',
  aliases: ['Vexlo'],
  canonicalDomain: 'https://www.VexloIQ.example/path',
  ownedDomains: ['quartzline.example'],
}

const BASKET: ReadonlyArray<readonly [query: string, expected: QueryClass]> = [
  ['is Vexlo IQ worth it', 'branded'], // the display name as written
  ['vexloiq pricing', 'branded'], // joined into one word
  ['is VEXLO-IQ legit', 'branded'], // hyphenated, upper case
  ['vexlo alternatives', 'branded'], // an alias
  ['quartzline login', 'branded'], // an owned domain's label
  ['is vexloiq.example down', 'branded'], // the host written out
  ['vexlology explained', 'non-brand'], // a longer word that starts with the alias
  ['what are alternatives to rivalone', 'non-brand'], // names only a competitor
  ['best widget shops near me', 'non-brand'],
]
const EXPECTED = BASKET.map(([, expected]) => expected)
const QUERY_TEXTS = BASKET.map(([query]) => query)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function classesFromQueryList(): Promise<unknown[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-class-parity-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  const now = '2026-09-01T12:00:00.000Z'
  const projectId = crypto.randomUUID()
  db.insert(projects).values({ id: projectId, name: 'parity', country: 'US', language: 'en', createdAt: now, updatedAt: now, ...IDENTITY }).run()
  QUERY_TEXTS.forEach((query, index) => {
    db.insert(queries).values({ id: `q-${index}`, projectId, query, provenance: 'test', createdAt: now }).run()
  })
  await app.ready()
  const response = await app.inject({ method: 'GET', url: '/api/v1/projects/parity/queries' })
  expect(response.statusCode).toBe(200)
  const classByText = new Map(response.json<Array<{ query: string; queryClass?: QueryClass | null }>>().map(row => [row.query, row.queryClass]))
  return QUERY_TEXTS.map(query => classByText.get(query))
}

const SURFACES: ReadonlyArray<readonly [name: string, classify: () => unknown[] | Promise<unknown[]>]> = [
  ['the query list (GET /projects/:name/queries)', classesFromQueryList],
  ['mention share inputs (projectQueryClassifier)', () => {
    const classify = projectQueryClassifier(IDENTITY)
    return QUERY_TEXTS.map(query => classify?.(query) ?? null)
  }],
  ['the frozen simple sweep definition (buildSimpleMeasurementDefinition)', () => buildSimpleMeasurementDefinition({
    capturedAt: '2026-09-01T12:00:00.000Z',
    identity: IDENTITY,
    country: 'US',
    language: 'en',
    location: null,
    engines: [{ provider: 'openai', requestedModel: null }],
    queries: QUERY_TEXTS.map((queryText, index) => ({ queryId: `q-${index}`, queryText, provenance: null })),
  }).queries.map(query => query.queryClass)],
  ['the advanced draft proposal (proposeQueryClass)', () => QUERY_TEXTS.map(query => proposeQueryClass(query, effectiveBrandNames(IDENTITY)))],
]

describe('query class parity across server surfaces', () => {
  it.each(SURFACES)('%s classes the fixture basket by the answer key', async (_name, classify) => {
    expect(await classify()).toEqual(EXPECTED)
  })
})
