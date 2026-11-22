import { describe, it, expect, vi } from 'vitest'
import { executeInspectSitemap } from '../src/gsc-inspect-sitemap.js'
import * as sitemaps from '../src/sitemap-parser.js'

type RunUpdate = { status?: string; startedAt?: string; finishedAt?: string; error?: string }

function makeDbWithProject(project: unknown) {
  const runUpdates: RunUpdate[] = []

  return {
    runUpdates,
    update: (_table: unknown) => ({
      set: (vals: RunUpdate) => ({
        where: () => ({
          run: () => {
            runUpdates.push(vals)
            return { changes: 1 }
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => project,
          all: () => [],
        }),
      }),
    }),
    insert: () => ({ values: () => ({ run: () => ({ changes: 1 }) }) }),
    delete: () => ({ where: () => ({ run: () => ({ changes: 0 }) }) }),
  }
}

describe('executeInspectSitemap', () => {
  it.each([
    ['https://shop.example.com/catalog', 'https://retail.example.com', 'https://shop.example.com/catalog/sitemap.xml'],
    ['sc-domain:example.com', 'https://shop.example.com/', 'https://shop.example.com/sitemap.xml'],
  ])('fetches the default sitemap inside the selected property %s', async (propertyId, canonicalDomain, expectedSitemap) => {
    const db = makeDbWithProject({ id: 'p', name: 'test', canonicalDomain })
    const fetchSitemap = vi.spyOn(sitemaps, 'fetchAndParseSitemap').mockResolvedValue([])
    try {
      await expect(executeInspectSitemap(db as never, 'r', 'p', { config: {
        apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test',
        google: {
          clientId: 'id', clientSecret: 'secret',
          connections: [{ domain: canonicalDomain, connectionType: 'gsc', propertyId, refreshToken: 'refresh', accessToken: 'access', tokenExpiresAt: '2099-01-01T00:00:00Z', createdAt: '', updatedAt: '' }],
        },
      } })).rejects.toThrow('No URLs found in sitemap')
      expect(fetchSitemap).toHaveBeenCalledWith(expectedSitemap)
    } finally {
      fetchSitemap.mockRestore()
    }
  })

  it('marks run as running then failed when project is not found', async () => {
    const db = makeDbWithProject(null)

    await expect(() => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            clientId: 'id',
            clientSecret: 'secret',
            connections: [],
          },
        },
      })).rejects.toThrow('Project not found')

    expect(db.runUpdates.length).toBe(2)
    expect(db.runUpdates[0]?.status).toBe('running')
    expect(db.runUpdates[1]?.status).toBe('failed')
  })

  it('marks run as failed when no GSC connection exists', async () => {
    const db = makeDbWithProject({
      id: 'proj-1',
      name: 'test',
      canonicalDomain: 'example.com',
    })

    await expect(() => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            clientId: 'id',
            clientSecret: 'secret',
            connections: [],
          },
        },
      })).rejects.toThrow('No GSC connection')

    expect(db.runUpdates[1]?.status).toBe('failed')
  })

  it('marks run as failed when Google OAuth is not configured', async () => {
    const db = makeDbWithProject({
      id: 'proj-1',
      name: 'test',
      canonicalDomain: 'example.com',
    })

    await expect(() => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
        },
      })).rejects.toThrow('Google OAuth is not configured')

    expect(db.runUpdates[1]?.status).toBe('failed')
  })
})
