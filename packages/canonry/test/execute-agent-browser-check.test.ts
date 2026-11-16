import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentBrowserChecks, agentBrowserResults, createClient, migrate, projects, runs } from '@canonry/canonry-db'
import { agentBrowserRequestIdentity, normalizeAgentBrowserCheckRequest } from '@canonry/canonry-contracts'
import type { AgentBrowserCheckRequest } from '@canonry/canonry-contracts'
import { agentBrowserEgress, agentBrowserRunStatus, executeAgentBrowserCheck } from '../src/execute-agent-browser-check.js'

let tmpDir: string
let db: ReturnType<typeof createClient>
let projectId: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-browser-exec-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({ id: projectId, name: 'site', displayName: 'Site', canonicalDomain: '1.1.1.1', country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now }).run()
  // No key may come from the test machine's environment.
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'GEMINI_API_KEY']) vi.stubEnv(name, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function queueCheck(request: AgentBrowserCheckRequest, status = 'queued'): string {
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  const effective = normalizeAgentBrowserCheckRequest(request, { property: null, siteHosts: ['1.1.1.1'], defaultStartUrl: 'https://1.1.1.1/' })
  db.insert(runs).values({ id: runId, projectId, kind: 'agent-browser-check', status, trigger: 'manual', createdAt: now }).run()
  db.insert(agentBrowserChecks).values({ runId, projectId, identityKey: agentBrowserRequestIdentity(effective), request: effective, createdAt: now }).run()
  return runId
}

const runRow = (runId: string) => db.select().from(runs).where(eq(runs.id, runId)).get()
const resultRows = (runId: string) => db.select().from(agentBrowserResults).where(eq(agentBrowserResults.runId, runId)).all()

describe('executeAgentBrowserCheck', () => {
  it('records each run of an agent with no API key as errored and fails the check, without opening a browser', async () => {
    const runId = queueCheck({ task: 'Find the pricing page', agents: ['openai', 'claude-a11y'], repeats: 2 })
    await executeAgentBrowserCheck(db, runId, projectId, { config: { providers: {} } })
    const results = resultRows(runId).sort((a, b) => a.agent.localeCompare(b.agent) || a.attempt - b.attempt)
    expect(results.map((r) => [r.agent, r.attempt, r.status, r.perception, r.error])).toEqual([
      ['claude-a11y', 1, 'errored', 'accessibility-tree', 'No claude API key is configured for this Canonry.'],
      ['claude-a11y', 2, 'errored', 'accessibility-tree', 'No claude API key is configured for this Canonry.'],
      ['openai', 1, 'errored', 'screenshots', 'No openai API key is configured for this Canonry.'],
      ['openai', 2, 'errored', 'screenshots', 'No openai API key is configured for this Canonry.'],
    ])
    const run = runRow(runId)
    expect(run?.status).toBe('failed')
    expect(run?.error).toBe('No agent run could be judged: every one errored.')
    expect(run?.startedAt).not.toBeNull()
    expect(run?.finishedAt).not.toBeNull()
  })

  it('refuses a start page that is not a public web address', async () => {
    const runId = queueCheck({ task: 'x', startUrl: 'http://127.0.0.1/admin', agents: ['openai'] })
    await expect(executeAgentBrowserCheck(db, runId, projectId, { config: { providers: { openai: { apiKey: 'sk-test' } } } })).rejects.toThrow('not a public web address')
    expect(runRow(runId)?.status).toBe('failed')
    expect(runRow(runId)?.error).toContain('The start URL is not a public web address')
    expect(resultRows(runId)).toHaveLength(0)
  })

  it('leaves a run another worker already claimed untouched', async () => {
    const runId = queueCheck({ task: 'x', agents: ['openai'] }, 'running')
    await executeAgentBrowserCheck(db, runId, projectId, { config: { providers: {} } })
    expect(runRow(runId)?.status).toBe('running')
    expect(resultRows(runId)).toHaveLength(0)
  })
})

describe('agentBrowserRunStatus', () => {
  // A failed agent run is a finding about the site; only runs nobody could judge fail the check.
  it.each([
    [[], 2, 'failed'],
    [['errored', 'errored'], 2, 'failed'],
    [['passed', 'errored'], 2, 'partial'],
    [['passed'], 2, 'partial'],
    [['passed', 'failed'], 2, 'completed'],
    [['failed', 'failed'], 2, 'completed'],
  ] as const)('%j of %i → %s', (statuses, expected, want) => {
    expect(agentBrowserRunStatus(statuses, expected)).toBe(want)
  })
})

// The check browser's proxy asks this for every host and port before anything leaves the
// browser, and dials the address it returns. Address literals only: the policy reads them without DNS.
describe('agentBrowserEgress', () => {
  it.each([
    ['the cloud metadata service', '169.254.169.254', 80, 'which is link-local'],
    ['a loopback port', '127.0.0.1', 4100, 'which is loopback'],
    ['a private network', '10.0.0.5', 443, 'which is private space'],
    ['IPv6 loopback', '::1', 4100, 'which is reserved IPv6 space'],
  ])('refuses %s', async (_label, host, port, reason) => {
    const verdict = await agentBrowserEgress(host, port)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toContain(reason)
  })

  it('lets a public address through and names the address to dial', async () => {
    expect(await agentBrowserEgress('1.1.1.1', 443)).toEqual({ ok: true, address: '1.1.1.1' })
  })
})
