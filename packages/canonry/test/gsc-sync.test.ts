import { describe, it, expect } from 'vitest'
import { executeGscSync } from '../src/gsc-sync.js'

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
  }
}

describe('executeGscSync', () => {
  it('marks run as running then failed when project is not found', async () => {
    const db = makeDbWithProject(null)

    await expect(() => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      })).rejects.toThrow(/Project not found/)

    expect(db.runUpdates.some((u) => u.status === 'running'), 'should have set running').toBeTruthy()
    expect(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed').toBeTruthy()
  })

  it('marks run as failed when no GSC connection exists for domain', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await expect(() => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      })).rejects.toThrow(/No GSC connection found/)

    expect(db.runUpdates.some((u) => u.status === 'running'), 'should have set running').toBeTruthy()
    expect(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed').toBeTruthy()
  })

  it('marks run as failed when GSC connection has no propertyId', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await expect(() => executeGscSync(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            clientId: 'id',
            clientSecret: 'secret',
            connections: [{
              domain: 'example.com',
              connectionType: 'gsc',
              refreshToken: 'rtoken',
              accessToken: 'atoken',
              tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
              propertyId: null,
              scopes: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
          },
        },
      })).rejects.toThrow(/No GSC property selected/)

    expect(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed').toBeTruthy()
  })

  it('marks run as failed when GSC connection has no refreshToken', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await expect(() => executeGscSync(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            clientId: 'id',
            clientSecret: 'secret',
            connections: [{
              domain: 'example.com',
              connectionType: 'gsc',
              refreshToken: null,
              accessToken: 'atoken',
              tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
              propertyId: 'sc-domain:example.com',
              scopes: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
          },
        },
      })).rejects.toThrow(/No GSC connection found or connection is incomplete/)

    expect(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed').toBeTruthy()
  })

  it('marks run as failed when Google OAuth client credentials are missing from config', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await expect(() => executeGscSync(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            connections: [],
          },
        },
      })).rejects.toThrow(/Google OAuth is not configured/)

    expect(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed').toBeTruthy()
  })
})
