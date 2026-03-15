import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeInspectSitemap } from '../src/gsc-inspect-sitemap.js'

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
  it('marks run as running then failed when project is not found', async () => {
    const db = makeDbWithProject(null)

    await assert.rejects(
      () => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
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
      (err: Error) => err.message.includes('Project not found'),
    )

    assert.equal(db.runUpdates.length, 2)
    assert.equal(db.runUpdates[0]?.status, 'running')
    assert.equal(db.runUpdates[1]?.status, 'failed')
  })

  it('marks run as failed when no GSC connection exists', async () => {
    const db = makeDbWithProject({
      id: 'proj-1',
      name: 'test',
      canonicalDomain: 'example.com',
    })

    await assert.rejects(
      () => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
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
      (err: Error) => err.message.includes('No GSC connection'),
    )

    assert.equal(db.runUpdates[1]?.status, 'failed')
  })

  it('marks run as failed when Google OAuth is not configured', async () => {
    const db = makeDbWithProject({
      id: 'proj-1',
      name: 'test',
      canonicalDomain: 'example.com',
    })

    await assert.rejects(
      () => executeInspectSitemap(db as never, 'run-1', 'proj-1', {
        config: {
          apiUrl: 'http://localhost:4100',
          database: '/tmp/test.db',
          apiKey: 'cnry_test',
        },
      }),
      (err: Error) => err.message.includes('Google OAuth is not configured'),
    )

    assert.equal(db.runUpdates[1]?.status, 'failed')
  })
})
