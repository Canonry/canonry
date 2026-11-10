import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { ProjectSetupDto } from '@canonry/canonry-contracts'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServerWithCatalog } from '../src/mcp/server.js'
import { invokeCliRead, prepareCliReadFixture } from './cli-read-fixture.js'

const SETUP_PATH = '/prefix/api/v1/projects/canonry-ai/setup'
const PROJECT = { name: 'canonry-ai', displayName: 'Canonry', canonicalDomain: 'canonry.ai' }
const NO_QUERIES = { total: 0, nonBrand: 0, branded: 0, unclassified: 0 }

/** A scan checking pages while AI Visibility waits for an engine. */
const scanning: ProjectSetupDto = {
  project: PROJECT,
  complete: false,
  firstResultAt: null,
  nextAction: 'connect_engine',
  tracks: {
    agentReadiness: {
      state: 'running', runId: 'scan-1', startedAt: '2026-11-10T09:00:00.000Z', finishedAt: null,
      progress: { phase: 'checking', pagesFound: 75, pagesChecked: 10, pageLimit: 100, linksFound: 414, pagesFailed: 0 },
      result: null, error: null,
    },
    aiVisibility: {
      state: 'not_started', runId: null, startedAt: null, finishedAt: null, mode: 'simple', blockedBy: 'no_engine',
      engines: [], queries: NO_QUERIES, progress: null, providerFailures: null, result: null, error: null,
    },
  },
}

/** Both tracks finished: a score, and a check whose classes keep their own denominators. */
const finished: ProjectSetupDto = {
  project: PROJECT,
  complete: true,
  firstResultAt: '2026-11-10T09:02:00.000Z',
  nextAction: 'open_project',
  tracks: {
    agentReadiness: {
      state: 'completed', runId: 'scan-1', startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:02:00.000Z',
      progress: null, result: { score: 72, pagesScored: 58 }, error: null,
    },
    aiVisibility: {
      state: 'completed', runId: 'check-1', startedAt: '2026-11-10T09:05:00.000Z', finishedAt: '2026-11-10T09:09:00.000Z',
      mode: 'simple', blockedBy: null, engines: ['gemini', 'openai'], queries: { total: 3, nonBrand: 2, branded: 1, unclassified: 0 },
      progress: null, providerFailures: null,
      result: {
        answers: 6,
        engines: 2,
        queryCounts: { totalQueries: 3, citedQueries: 2, mentionedQueries: 3, citationNotMeasuredQueries: 0 },
        queryCountsByClass: {
          nonBrand: { totalQueries: 2, citedQueries: 1, mentionedQueries: 2, citationNotMeasuredQueries: 0 },
          branded: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
          unclassifiedQueries: 0,
        },
      },
      error: null,
    },
  },
}

/** A check still running with a failing engine, its planned answers recorded when it started. */
const checking: ProjectSetupDto = {
  ...finished,
  complete: false,
  nextAction: 'wait',
  tracks: {
    agentReadiness: finished.tracks.agentReadiness,
    aiVisibility: {
      ...finished.tracks.aiVisibility, state: 'running', finishedAt: null, result: null,
      progress: { answersSaved: 5, answersPlanned: 12 },
      providerFailures: { gemini: { message: 'Gemini rate limit reached.', failedQueries: 2, stopped: true } },
    },
  },
}

describe('project setup transports', () => {
  let cleanup = () => {}
  beforeEach(() => { cleanup = prepareCliReadFixture() })
  afterEach(() => { vi.restoreAllMocks(); cleanup() })

  it('returns the API object unchanged through stored-only CLI JSON and the MCP tool', async () => {
    const cli = await invokeCliRead(['project', 'setup', 'canonry-ai', '--format', 'json', '--stored-only'], checking, { pathname: SETUP_PATH })
    expect(cli.stderr).toBe('')
    expect(cli.exitCode).toBeUndefined()
    expect(JSON.parse(cli.stdout)).toEqual(checking)

    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json(checking)
    }))
    const api = new ApiClient('https://canonry.test/prefix', 'cnry_setup-read', { skipProbe: true })
    const { server } = createCanonryMcpServerWithCatalog({ clientFactory: () => api, scope: 'stored-only', credentialScopes: ['read'], eager: true })
    const mcp = new Client({ name: 'project-setup-test', version: '1' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await mcp.connect(clientTransport)
      const response = await mcp.callTool({ name: 'canonry_project_setup', arguments: { project: 'canonry-ai' } })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      expect(response.structuredContent).toEqual(checking)
    } finally {
      await mcp.close()
      await server.close()
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('GET')
    expect(new URL(requests[0]!.url).pathname).toBe(SETUP_PATH)
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer cnry_setup-read')
  })

  it('prints a running scan and a blocked check as two rows and the command for the next step', async () => {
    const cli = await invokeCliRead(['project', 'setup', 'canonry-ai'], scanning, { pathname: SETUP_PATH })
    expect(cli.exitCode).toBeUndefined()
    expect(cli.stdout).toBe([
      'Canonry (canonry.ai)',
      '  Agent Readiness   Running       Checking pages · 10 of up to 100',
      '  AI Visibility     Not started   Needs an AI engine.',
      'Next: connect an AI engine: cnry settings provider <name> --api-key <key>',
    ].join('\n'))
  })

  it('prints a running check against its planned answers, with each failing engine', async () => {
    const cli = await invokeCliRead(['project', 'setup', 'canonry-ai'], checking, { pathname: SETUP_PATH })
    expect(cli.stdout).toBe([
      'Canonry (canonry.ai)',
      '  Agent Readiness   Complete   Score 72/100 · 58 pages scored',
      '  AI Visibility     Running    Asking gemini, openai · 5 of 12 answers saved',
      '                               gemini: 2 queries failed, so this check stopped asking it. Gemini rate limit reached.',
      'Next: wait for the work in progress, then check again: cnry project setup canonry-ai',
    ].join('\n'))
  })

  it('prints non-brand and branded results on their own lines, never pooled when they split', async () => {
    const cli = await invokeCliRead(['project', 'setup', 'canonry-ai'], finished, { pathname: SETUP_PATH })
    expect(cli.stdout).toBe([
      'Canonry (canonry.ai) · setup complete',
      '  Agent Readiness   Complete   Score 72/100 · 58 pages scored',
      '  AI Visibility     Complete   6 answers from 2 engines',
      '                               Non-brand queries: mentioned in 2 of 2, cited in 1 of 2',
      '                               Branded queries: mentioned in 1 of 1, cited in 1 of 1',
      'Next: read the results: cnry overview canonry-ai',
    ].join('\n'))
  })

  it('exits 1 for an unknown project and 2 when the server fails', async () => {
    const missing = await invokeCliRead(['project', 'setup', 'canonry-ai', '--format', 'json'],
      { error: { code: 'NOT_FOUND', message: 'Project "canonry-ai" not found' } }, { pathname: SETUP_PATH, status: 404 })
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('NOT_FOUND')

    const broken = await invokeCliRead(['project', 'setup', 'canonry-ai', '--format', 'json'],
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { pathname: SETUP_PATH, status: 500 })
    expect(broken.exitCode).toBe(2)
    expect(broken.stdout).toBe('')
  })
})
