import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp(opts?: { onProjectDeleted?: (projectId: string) => void }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-export-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, onProjectDeleted: opts?.onProjectDeleted })

  return { app, tmpDir }
}

test('project export includes schedule and notifications for round-tripping', async () => {
  const { app, tmpDir } = buildApp()
  await app.ready()

  try {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/exportable',
      payload: {
        displayName: 'Exportable',
        canonicalDomain: 'example.com',
        ownedDomains: ['docs.example.com'],
        country: 'US',
        language: 'en',
      },
    })

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/exportable/schedule',
      payload: {
        preset: 'daily',
        timezone: 'UTC',
        providers: ['gemini'],
      },
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/exportable/notifications',
      payload: {
        channel: 'webhook',
        url: 'https://8.8.8.8/hook',
        events: ['run.completed'],
      },
    })

    const exportRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/exportable/export',
    })

    assert.equal(exportRes.statusCode, 200)
    const body = JSON.parse(exportRes.body) as {
      spec: {
        ownedDomains: string[]
        schedule?: { preset?: string; cron?: string; timezone: string; providers: string[] }
        notifications: Array<{ channel: string; url: string; events: string[] }>
      }
    }

    assert.deepEqual(body.spec.ownedDomains, ['docs.example.com'])
    assert.deepEqual(body.spec.schedule, {
      preset: 'daily',
      timezone: 'UTC',
      providers: ['gemini'],
    })
    assert.deepEqual(body.spec.notifications, [{
      channel: 'webhook',
      url: 'https://8.8.8.8/hook',
      events: ['run.completed'],
    }])
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('project delete invokes onProjectDeleted callback', async () => {
  const deletedProjectIds: string[] = []
  const { app, tmpDir } = buildApp({
    onProjectDeleted: (projectId) => deletedProjectIds.push(projectId),
  })
  await app.ready()

  try {
    const createRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/to-delete',
      payload: {
        displayName: 'Delete Me',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    const created = JSON.parse(createRes.body) as { id: string }

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/to-delete',
    })

    assert.equal(deleteRes.statusCode, 204)
    assert.deepEqual(deletedProjectIds, [created.id])
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
