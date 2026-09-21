import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { readVisibilityReport } from '../src/visibility-report.js'

// Pass-through spy: the report build still runs the real reader, and the test
// sees the options it passed. The DTO alone cannot show the opt-out, because
// the report keeps only queryClass, summary and trend either way.
vi.mock('../src/visibility-report.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/visibility-report.js')>()
  return { ...actual, readVisibilityReport: vi.fn(actual.readVisibilityReport) }
})

let directory: string
let app: FastifyInstance

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-opt-out-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'opt-out',
    displayName: 'Opt Out',
    canonicalDomain: 'opt-out.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
  vi.mocked(readVisibilityReport).mockClear()
})

it('builds the report without the change since the previous sweep or its predecessor read', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/projects/opt-out/report' })

  expect(response.statusCode, response.body).toBe(200)
  expect(vi.mocked(readVisibilityReport).mock.calls.map(call => [call[2], call[3]])).toEqual([
    [{ queryClass: 'all', scope: 'project' }, { includeComparison: false }],
  ])
})
