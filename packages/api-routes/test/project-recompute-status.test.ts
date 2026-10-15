import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects } from '@canonry/canonry-db'
import { projectDtoSchema } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
let db: ReturnType<typeof createClient>
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  db = createClient(':memory:'); migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.test', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  app = Fastify(); await app.register(apiRoutes, { db, skipAuth: true }); await app.ready()
})
afterEach(async () => { await app.close(); db.$client.close() })
it.each([null, 'competitors', 'full'] as const)('exposes stored recomputation state %s on project reads', async answerFieldsRecompute => {
  db.update(projects).set({ answerFieldsRecompute }).where(eq(projects.id, 'project')).run()
  const response = await app.inject({ url: '/api/v1/projects/example' })
  expect(response.statusCode).toBe(200)
  expect(response.json().answerFieldsRecompute).toBe(answerFieldsRecompute)
  expect(projectDtoSchema.parse(response.json()).answerFieldsRecompute).toBe(answerFieldsRecompute)
  const legacy = response.json(); delete legacy.answerFieldsRecompute
  expect(projectDtoSchema.safeParse(legacy).success).toBe(true)
})
