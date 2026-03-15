import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      }),
      /Project not found/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'running'), 'should have set running')
    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })

  it('marks run as failed when no GSC connection exists for domain', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      }),
      /No GSC connection found/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'running'), 'should have set running')
    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })

  it('marks run as failed when GSC connection has no propertyId', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      }),
      /No GSC property selected/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })

  it('marks run as failed when GSC connection has no refreshToken', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
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
      }),
      /No GSC connection found or connection is incomplete/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })

  it('marks run as failed when Google OAuth client credentials are missing from config', async () => {
    const project = {
      id: 'proj-1',
      canonicalDomain: 'example.com',
    }
    const db = makeDbWithProject(project)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
          google: {
            connections: [],
          },
        },
      }),
      /Google OAuth is not configured/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })
})
