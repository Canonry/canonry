import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { DEFAULT_MEASUREMENT_CONFIG, projectConfigSchema, projectDtoSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-measurement-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, tmpDir }
}

let ctx: ReturnType<typeof buildApp>
beforeEach(async () => {
  ctx = buildApp()
  await ctx.app.ready()
})
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

const baseProject = {
  displayName: 'Example Solar',
  canonicalDomain: 'example.com',
  country: 'US',
  language: 'en',
}

const expectedDefaultMeasurement = {
  marketingHosts: [],
  brandTerms: [],
  leadEventNames: ['generate_lead'],
}

describe('project measurement config', () => {
  it('creates with safe defaults and returns them on every project read', async () => {
    const created = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/default-measurement',
      payload: baseProject,
    })
    expect(created.statusCode).toBe(201)
    expect(projectDtoSchema.parse(JSON.parse(created.body)).measurement)
      .toEqual(expectedDefaultMeasurement)
    expect(DEFAULT_MEASUREMENT_CONFIG).toEqual(expectedDefaultMeasurement)

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/default-measurement',
    })
    expect(projectDtoSchema.parse(JSON.parse(fetched.body)).measurement)
      .toEqual(expectedDefaultMeasurement)
  })

  it('normalizes explicit config and preserves it when an older client omits the field on update', async () => {
    const created = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/preserve-measurement',
      payload: {
        ...baseProject,
        measurement: {
          marketingHosts: ['HTTPS://WWW.Offers.Example.com/quote'],
          brandTerms: [' Example Pro '],
          leadEventNames: ['generate_lead', 'book_demo'],
        },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(projectDtoSchema.parse(JSON.parse(created.body)).measurement).toEqual({
      marketingHosts: ['offers.example.com'],
      brandTerms: ['Example Pro'],
      leadEventNames: ['generate_lead', 'book_demo'],
    })

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/preserve-measurement',
      payload: { ...baseProject, displayName: 'Example Solar Updated' },
    })
    expect(updated.statusCode).toBe(200)
    expect(projectDtoSchema.parse(JSON.parse(updated.body)).measurement).toEqual({
      marketingHosts: ['offers.example.com'],
      brandTerms: ['Example Pro'],
      leadEventNames: ['generate_lead', 'book_demo'],
    })
  })

  it('round-trips explicit measurement config through project export and config apply', async () => {
    const measurement = {
      marketingHosts: ['offers.example.com'],
      brandTerms: ['Example Pro'],
      leadEventNames: ['generate_lead', 'book_demo'],
    }
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/export-measurement',
      payload: { ...baseProject, measurement },
    })

    const exported = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/export-measurement/export',
    })
    expect(exported.statusCode).toBe(200)
    const config = projectConfigSchema.parse(JSON.parse(exported.body))
    expect(config.spec.measurement).toEqual(measurement)

    config.metadata.name = 'applied-measurement'
    const applied = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config,
    })
    expect(applied.statusCode).toBe(200)
    expect(projectDtoSchema.parse(JSON.parse(applied.body)).measurement).toEqual(measurement)
  })

  it('rejects invalid marketing hosts and event names at the route boundary', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/invalid-measurement',
      payload: {
        ...baseProject,
        measurement: {
          marketingHosts: ['example.com/pricing'],
          leadEventNames: ['generate-lead'],
        },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    })
  })
})
