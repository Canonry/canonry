import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { AppError, googleConnectionDtoSchema } from '@ainyc/canonry-contracts'
import { googleRoutes, type GoogleConnectionRecord } from '../src/google.js'

const NOW = '2026-10-14T00:00:00.000Z'

describe('Google property and sitemap updates', () => {
  const connections: GoogleConnectionRecord[] = []
  const db = createClient(':memory:')
  const app = Fastify()

  beforeAll(async () => {
    migrate(db)
    db.insert(projects).values({
      id: 'proj-1',
      name: 'acme',
      displayName: 'Acme',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    connections.push({
      domain: 'acme.example',
      connectionType: 'gsc',
      propertyId: 'sc-domain:old.example',
      sitemapUrl: 'https://acme.example/old.xml',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      tokenExpiresAt: NOW,
      scopes: ['https://www.googleapis.com/auth/webmasters'],
      createdByProjectId: 'proj-1',
      createdAt: NOW,
      updatedAt: NOW,
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      throw error
    })
    app.decorate('db', db)
    await app.register(googleRoutes, {
      googleConnectionStore: {
        listConnections: domain => connections.filter(connection => connection.domain === domain),
        getConnection: (domain, type) => connections.find(connection => connection.domain === domain && connection.connectionType === type),
        upsertConnection: connection => connection,
        updateConnection: (domain, type, patch) => {
          const existing = connections.find(connection => connection.domain === domain && connection.connectionType === type)
          if (!existing) return undefined
          Object.assign(existing, patch)
          return existing
        },
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    db.$client.close()
  })

  it('returns the stored connection after a property or sitemap change, without tokens', async () => {
    const property = await app.inject({
      method: 'PUT',
      url: '/projects/acme/google/connections/gsc/property',
      payload: { propertyId: 'sc-domain:acme.example' },
    })
    const propertyBody = googleConnectionDtoSchema.parse(property.json())

    expect(property.statusCode).toBe(200)
    expect(propertyBody).toMatchObject({
      id: 'acme.example:gsc',
      domain: 'acme.example',
      connectionType: 'gsc',
      propertyId: 'sc-domain:acme.example',
      sitemapUrl: 'https://acme.example/old.xml',
      scopes: ['https://www.googleapis.com/auth/webmasters'],
      createdAt: NOW,
    })
    expect(propertyBody.updatedAt).not.toBe(NOW)
    expect(Object.keys(property.json()).sort()).toEqual([
      'connectionType', 'createdAt', 'domain', 'id', 'propertyId', 'scopes', 'sitemapUrl', 'updatedAt',
    ])

    const sitemap = await app.inject({
      method: 'PUT',
      url: '/projects/acme/google/connections/gsc/sitemap',
      payload: { sitemapUrl: 'https://acme.example/sitemap.xml' },
    })
    const sitemapBody = googleConnectionDtoSchema.parse(sitemap.json())

    expect(sitemap.statusCode).toBe(200)
    expect(sitemapBody).toMatchObject({
      id: 'acme.example:gsc',
      propertyId: 'sc-domain:acme.example',
      sitemapUrl: 'https://acme.example/sitemap.xml',
      scopes: ['https://www.googleapis.com/auth/webmasters'],
    })
    expect(sitemap.json()).not.toHaveProperty('accessToken')
    expect(sitemap.json()).not.toHaveProperty('refreshToken')
  })

  it('does not invent a connection when the update has nothing to change', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/projects/acme/google/connections/ga4/property',
      payload: { propertyId: '123' },
    })

    expect(res.statusCode).toBe(404)
  })
})
