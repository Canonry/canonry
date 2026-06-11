import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, auditLog, notifications, projects, runs } from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'

/**
 * Delivery-time SSRF policy threading. Registration validates webhook URLs
 * with the host's `allowLoopback` / `allowPrivateNetworks` policy, but the
 * Notifier used to resolve targets with NO options — so a webhook that
 * registration accepted (localhost test endpoint, or the Hosted v1
 * Docker-internal control-plane callback) was silently `webhook.ssrf-blocked`
 * at delivery. The Notifier now takes the same policy.
 */

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function buildDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-notifier-policy-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

async function startCaptureServer(): Promise<{ port: number; received: Array<{ event?: string }> }> {
  const received: Array<{ event?: string }> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      try { received.push(JSON.parse(body) as { event?: string }) } catch { received.push({}) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('no port')
  return { port: address.port, received }
}

function seedRunWithSubscriber(db: ReturnType<typeof buildDb>, webhookUrl: string) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'policy-test',
    displayName: 'Policy Test',
    canonicalDomain: 'policy-test.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
    finishedAt: now,
  }).run()
  db.insert(notifications).values({
    id: crypto.randomUUID(),
    projectId,
    channel: 'webhook',
    config: { url: webhookUrl, events: ['run.completed'] },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }).run()
  return { projectId, runId }
}

describe('Notifier webhook policy', () => {
  it('delivers to a loopback target when the host policy allows loopback', async () => {
    const db = buildDb()
    const { port, received } = await startCaptureServer()
    const { projectId, runId } = seedRunWithSubscriber(db, `http://127.0.0.1:${port}/hook`)

    const notifier = new Notifier(db, 'http://localhost:4100', { allowLoopback: true })
    await notifier.onRunCompleted(runId, projectId)

    expect(received).toHaveLength(1)
    expect(received[0]!.event).toBe('run.completed')
  })

  it('still blocks loopback delivery under the default (no-policy) posture', async () => {
    const db = buildDb()
    const { port, received } = await startCaptureServer()
    const { projectId, runId } = seedRunWithSubscriber(db, `http://127.0.0.1:${port}/hook`)

    const notifier = new Notifier(db, 'http://localhost:4100')
    await notifier.onRunCompleted(runId, projectId)

    expect(received).toHaveLength(0)
    // The block is visible in the delivery audit trail, not silent.
    const failures = db.select().from(auditLog).all()
      .filter(row => row.action === 'notification.failed')
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]!.diff ?? '').toContain('SSRF')
  })
})
