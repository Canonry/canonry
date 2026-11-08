import { test, expect, onTestFinished } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, queries, projects, querySnapshots, runs } from '@canonry/canonry-db'
import { localAdapter } from '@canonry/canonry-provider-local'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

// A local model has no web access, so its answers carry no sources and whether
// they cite the project is never observed. The sweep must record that as
// `not-measured`, not as a miss, while still measuring the answer-text mention.

const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 }

/** A loopback OpenAI-compatible runtime that answers every request with `content`. */
async function startRuntime(content: string): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1758700000,
        model: 'llama3:8b',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function sweepWithLocal(answer: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-citation-measurability-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const registry = new ProviderRegistry()
  registry.register(localAdapter, { provider: 'local', baseUrl: await startRuntime(answer), model: 'llama3', quotaPolicy })

  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'local-project',
    displayName: 'Acme CRM',
    canonicalDomain: 'acme.example',
    country: 'US',
    language: 'en',
    providers: ['local'],
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: 'best crm for agencies', createdAt: now }).run()
  db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()

  await new JobRunner(db, registry).executeRun(runId, projectId)
  return db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
}

test('a Local sweep records the citation as not measured and still measures the mention', async () => {
  // The answer writes the project's domain in its prose: a mention, never a citation.
  const snapshots = await sweepWithLocal('Acme CRM (acme.example) is a common pick for agencies.')

  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({
    provider: 'local',
    citationState: 'not-measured',
    answerMentioned: true,
    retrievalStatus: 'not-applicable',
    citedDomains: [],
  })
})

test('a Local answer that does not name the project is not mentioned, and its citation is still not measured', async () => {
  const snapshots = await sweepWithLocal('HubSpot and Pipedrive are common picks for agencies.')

  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({ citationState: 'not-measured', answerMentioned: false })
})
