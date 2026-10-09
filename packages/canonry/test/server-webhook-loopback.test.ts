import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { apiKeys, auditLog, createClient, migrate, notifications, projects, runs } from '@ainyc/canonry-db'
import type { AnalysisResult } from '@ainyc/canonry-intelligence'
import type { Notifier } from '../src/notifier.js'
import { createServer } from '../src/server.js'

// `canonry serve` reads CANONRY_ALLOW_LOOPBACK_WEBHOOKS once and hands it to
// both webhook create/test (api-routes) and scheduled delivery (the Notifier),
// so a hook that was accepted is not refused when an event fires. The server
// builds its own Notifier; keep a handle on it so the test can fire an event
// through that instance, with the real egress check and the real send.
const built = vi.hoisted(() => ({ notifiers: [] as Notifier[] }))
vi.mock('../src/notifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notifier.js')>()
  class RecordedNotifier extends actual.Notifier {
    constructor(...args: ConstructorParameters<typeof actual.Notifier>) {
      super(...args)
      built.notifiers.push(this)
    }
  }
  return { ...actual, Notifier: RecordedNotifier }
})

const NOW = '2026-10-08T00:00:00.000Z'
let cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const step of cleanup.reverse()) await step()
  cleanup = []
  built.notifiers.length = 0
})

async function startReceiver() {
  const received: string[] = []
  const server = http.createServer((request, response) => {
    received.push(`${request.method} ${request.url}`)
    request.resume()
    request.on('end', () => response.writeHead(204).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received }
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-webhook-loopback-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const database = path.join(dir, 'data.db')
  const db = createClient(database)
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'local', displayName: 'Local', canonicalDomain: 'local.example',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'default', scopes: ['*'], createdAt: NOW,
    keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), keyPrefix: apiKey.slice(0, 9),
  }).run()
  const app = await createServer({ config: { apiUrl: 'http://127.0.0.1:4100', database, apiKey, providers: {} }, db, logger: false })
  cleanup.push(() => app.close())

  const runId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, status: 'completed', createdAt: NOW, finishedAt: NOW }).run()
  const result: AnalysisResult = {
    insights: [{
      id: crypto.randomUUID(), type: 'gbp-keyword-drop', severity: 'high', title: 'Impressions down 40%',
      query: 'locations/local', provider: 'google', createdAt: NOW,
    }],
    regressions: [], gains: [], firstCitations: [], providerPickups: [],
    persistentGaps: [], competitorGains: [], competitorLosses: [],
    health: { overallCitedRate: 0, overallMentionRate: 0, totalPairs: 0, citedPairs: 0, mentionedPairs: 0, providerBreakdown: {} },
  }
  expect(built.notifiers).toHaveLength(1)
  const notifier = built.notifiers[0]!

  return {
    createWebhook: (url: string) => app.inject({
      method: 'POST',
      url: '/api/v1/projects/local/notifications',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { channel: 'webhook', url, events: ['insight.high'] },
    }),
    storeWebhook: (url: string) => db.insert(notifications).values({
      id: crypto.randomUUID(), projectId, channel: 'webhook', config: { url, events: ['insight.high'] },
      enabled: true, createdAt: NOW, updatedAt: NOW,
    }).run(),
    fireInsight: () => notifier.dispatchInsightWebhooks(runId, projectId, result),
    deliveries: () => db.select().from(auditLog).all()
      .filter((row) => row.action.startsWith('notification.') && row.action !== 'notification.created')
      .map((row) => ({ action: row.action, error: (JSON.parse(row.diff!) as { error: string | null }).error })),
  }
}

it('delivers to a loopback webhook that canonry serve accepted, by default', async () => {
  const receiver = await startReceiver()
  const server = await startServer()

  expect((await server.createWebhook(receiver.url)).statusCode).toBe(201)
  await server.fireInsight()

  expect(receiver.received).toEqual(['POST /hook'])
  expect(server.deliveries()).toEqual([{ action: 'notification.sent', error: null }])
})

it('refuses a loopback webhook at create and at delivery with CANONRY_ALLOW_LOOPBACK_WEBHOOKS=0', async () => {
  vi.stubEnv('CANONRY_ALLOW_LOOPBACK_WEBHOOKS', '0')
  const receiver = await startReceiver()
  const server = await startServer()

  const created = await server.createWebhook(receiver.url)
  expect(created.statusCode).toBe(400)
  expect(created.json().error.message).toBe('"url" must not resolve to a private or loopback address')
  // A hook stored before the setting changed is refused when an event fires.
  server.storeWebhook(receiver.url)
  await server.fireInsight()

  expect(receiver.received).toEqual([])
  expect(server.deliveries()).toEqual([
    { action: 'notification.failed', error: 'SSRF: "url" must not resolve to a private or loopback address' },
  ])
})
