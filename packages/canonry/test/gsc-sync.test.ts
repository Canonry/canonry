import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeGscSync } from '../src/gsc-sync.js'

type RunUpdate = { status?: string; startedAt?: string; finishedAt?: string; error?: string }

// A mock db that returns project on the first select().from().where().get() call
// and conn on subsequent calls
function makeDbWithProjectAndConn(project: unknown, conn: unknown) {
  const runUpdates: RunUpdate[] = []
  let callCount = 0

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
          get: () => {
            callCount++
            // First call: project lookup, second call: googleConnections lookup
            return callCount === 1 ? project : conn
          },
          all: () => [],
        }),
      }),
    }),
    insert: () => ({ values: () => ({ run: () => ({ changes: 1 }) }) }),
  }
}

describe('executeGscSync', () => {
  it('marks run as running then failed when project is not found', async () => {
    const db = makeDbWithProjectAndConn(null, null)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
        googleClientId: 'id',
        googleClientSecret: 'secret',
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
    const db = makeDbWithProjectAndConn(project, null)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
        googleClientId: 'id',
        googleClientSecret: 'secret',
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
    const conn = {
      id: 'conn-1',
      domain: 'example.com',
      connectionType: 'gsc',
      refreshToken: 'rtoken',
      accessToken: 'atoken',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      propertyId: null,
    }
    const db = makeDbWithProjectAndConn(project, conn)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
        googleClientId: 'id',
        googleClientSecret: 'secret',
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
    const conn = {
      id: 'conn-1',
      domain: 'example.com',
      connectionType: 'gsc',
      refreshToken: null,
      accessToken: 'atoken',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      propertyId: 'sc-domain:example.com',
    }
    const db = makeDbWithProjectAndConn(project, conn)

    await assert.rejects(
      () => executeGscSync(db as never, 'run-1', 'proj-1', {
        googleClientId: 'id',
        googleClientSecret: 'secret',
      }),
      /No GSC connection found or connection is incomplete/,
    )

    assert.ok(db.runUpdates.some((u) => u.status === 'failed'), 'should have set failed')
  })
})
