import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.resolve(packageRoot, '..', '..')
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const mcpCli = path.join(packageRoot, 'src', 'mcp', 'cli.ts')

/**
 * The MCP adapter must write NOTHING to stderr (AGENTS.md → MCP adapter
 * boundary), so the assertion below is an exact empty-string match.
 *
 * One Node-generated line would otherwise break it: the subprocess is
 * `node <tsx>/cli.mjs src/mcp/cli.ts`, and tsx's ESM loader calls
 * `module.register()`, deprecated in Node 26 (DEP0205). That is a dev-only
 * transpiler emitting it, not canonry, and it says nothing about the MCP
 * contract.
 *
 * It is silenced at the SOURCE — `--disable-warning=DEP0205` via NODE_OPTIONS
 * on the child, see `startMcpClient` below — rather than by filtering the
 * stream afterwards. A
 * filter is the wrong instrument here: any pattern broad enough to catch
 * Node's `(node:<pid>) ...` prefix also catches `MaxListenersExceededWarning`
 * and `UnhandledPromiseRejectionWarning`, which are exactly the signals this
 * assertion exists to surface. Disabling one warning code by name keeps every
 * other diagnostic — and every byte canonry writes — a test failure.
 *
 * `--disable-warning` landed in Node 21.3, so it is available on every major
 * in this repo's supported range.
 */

/**
 * Budget for spawn through the `initialize` response, which is where the two
 * subprocess cases below spend nearly all of their time. Each one starts
 * `node tsx src/mcp/cli.ts`, and that child transpiles the whole CLI import
 * graph — the API client plus the 188-entry tool registry — before it can write
 * its first frame. Measured: ~1.2-1.9s of handshake on an idle 12-core box,
 * ~10s at 7x CPU oversubscription, against tens of milliseconds for every
 * assertion that follows.
 *
 * That fits inside vitest's 5000ms default only while the machine is idle. Run
 * as part of `pnpm run test` (658 files, one worker per core) both cases timed
 * out in roughly 1 run in 3 — always at the handshake, never with an assertion
 * diff, which is why the failures read as "no output" rather than as a bug.
 *
 * So the ceiling is raised where the cost actually is. There is no sleep to
 * tune: `startMcpClient` waits on the `initialize` response itself, and this
 * budget exists only so a child that never answers reports why.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * Per-case ceiling. Deliberately above `HANDSHAKE_TIMEOUT_MS` so a subprocess
 * that hangs loses the race to the handshake's own error — which names the
 * phase and carries the child's stderr — instead of to vitest's generic "Test
 * timed out" pointing at the `it()`.
 */
const SUBPROCESS_CASE_TIMEOUT_MS = 45_000

describe('canonry-mcp stdio', () => {
  const clients: Client[] = []
  const servers: Array<{ close: () => Promise<void> }> = []

  // Same contention applies to teardown: killing the child and awaiting its
  // exit is fast, but not against the default 10s hook budget on a loaded box.
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()))
    await Promise.all(servers.splice(0).map(server => server.close()))
  }, HANDSHAKE_TIMEOUT_MS)

  it('initializes, lists tools, and calls stubbed read/write tools through stdio frames', async () => {
    const api = await startStubApi()
    servers.push(api)

    const { client, stderr } = await startMcpClient({
      apiOrigin: api.origin,
      configPrefix: 'canonry-mcp-stdio-',
      database: '/tmp/canonry-mcp-stdio.sqlite',
      clientName: 'canonry-mcp-test',
    })
    clients.push(client)

    const list = await client.listTools()
    expect(list.tools).toHaveLength(12)
    const listedNames = list.tools.map(tool => tool.name)
    expect(listedNames).toContain('canonry_projects_list')
    expect(listedNames).toContain('canonry_project_overview')
    expect(listedNames).toContain('canonry_search')
    expect(listedNames).toContain('canonry_doctor')
    expect(listedNames).toContain('canonry_help')
    expect(listedNames).toContain('canonry_load_toolkit')
    expect(listedNames).not.toContain('canonry_insights_list')

    const help = await client.callTool({ name: 'canonry_help', arguments: {} })
    expect(help.isError).not.toBe(true)
    const helpPayload = jsonText(help) as { toolkits: Array<{ name: string; toolCount: number }> }
    expect(helpPayload.toolkits.map(t => t.name)).toEqual(['monitoring', 'setup', 'gsc', 'ga', 'gbp', 'ads', 'google-ads', 'gtm', 'conversion-tracking', 'traffic', 'agent', 'discovery'])

    const projects = await client.callTool({ name: 'canonry_projects_list', arguments: {} })
    expect(projects.isError).not.toBe(true)
    expect(jsonText(projects)).toEqual([{ name: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' }])

    const beforeLoad = await client.callTool({ name: 'canonry_insights_list', arguments: { project: 'acme' } })
    expect(beforeLoad.isError).toBe(true)
    const beforeLoadText = (beforeLoad.content?.[0] as { text?: string } | undefined)?.text ?? ''
    // The pipelining caveat documented on canonry_load_toolkit and in docs/mcp.md must match
    // the error wording the MCP SDK actually emits. If the SDK changes its message, both the
    // tool description and the docs need to be updated together.
    expect(beforeLoadText).toMatch(/MCP error -32602: Tool canonry_insights_list disabled/)
    const loadToolkitTool = list.tools.find(tool => tool.name === 'canonry_load_toolkit')
    expect(loadToolkitTool?.description ?? '').toContain('Tool ... disabled')

    const loaded = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'monitoring' } })
    expect(loaded.isError).not.toBe(true)
    expect(jsonText(loaded)).toMatchObject({ status: 'loaded', name: 'monitoring' })

    const expandedList = await client.listTools()
    expect(expandedList.tools.map(tool => tool.name)).toContain('canonry_insights_list')

    const insights = await client.callTool({ name: 'canonry_insights_list', arguments: { project: 'acme' } })
    expect(insights.isError).not.toBe(true)
    expect(jsonText(insights)).toEqual([])

    const setupLoad = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'setup' } })
    expect(setupLoad.isError).not.toBe(true)

    const addQueries = await client.callTool({
      name: 'canonry_queries_add',
      arguments: { project: 'acme', request: { queries: ['alpha', 'alpha'] } },
    })
    expect(addQueries.isError).not.toBe(true)
    expect(jsonText(addQueries)).toEqual({ ok: true })

    const invalid = await client.callTool({
      name: 'canonry_queries_add',
      arguments: { project: 'acme', request: { queries: [] } },
    })
    expect(invalid.isError).toBe(true)
    const text = invalid.content?.[0]
    expect(text && text.type === 'text').toBe(true)
    expect((text as { text: string }).text).not.toContain('MCP error -32602')
    const envelope = JSON.parse((text as { text: string }).text) as {
      error: { code: string; message: string; details?: { issues?: unknown[] } }
    }
    expect(envelope.error.code).toBe('VALIDATION_ERROR')
    expect(envelope.error.details?.issues).toBeTruthy()

    const trafficLoad = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'traffic' } })
    expect(trafficLoad.isError).not.toBe(true)

    const trafficSources = await client.callTool({
      name: 'canonry_traffic_sources_list',
      arguments: { project: 'acme' },
    })
    expect(trafficSources.isError).not.toBe(true)
    expect(jsonText(trafficSources)).toEqual({ sources: [] })

    const trafficSync = await client.callTool({
      name: 'canonry_traffic_sync',
      arguments: { project: 'acme', sourceId: 'src-1', sinceMinutes: 30 },
    })
    expect(trafficSync.isError).not.toBe(true)
    expect(jsonText(trafficSync)).toMatchObject({ runId: 'run-traffic-1', sourceId: 'src-1' })

    expect(stderr()).toBe('')
  }, SUBPROCESS_CASE_TIMEOUT_MS)

  it('docs/mcp.md documents the same pipelining error wording the SDK emits', () => {
    const docsPath = path.resolve(repoRoot, 'docs', 'mcp.md')
    const docs = fs.readFileSync(docsPath, 'utf8')
    expect(docs).toContain('MCP error -32602: Tool ... disabled')
  })

  it('loads every toolkit at startup when --eager is passed', async () => {
    const api = await startStubApi()
    servers.push(api)

    const { client } = await startMcpClient({
      apiOrigin: api.origin,
      configPrefix: 'canonry-mcp-eager-',
      database: '/tmp/canonry-mcp-eager.sqlite',
      clientName: 'canonry-mcp-eager-test',
      args: ['--eager'],
    })
    clients.push(client)

    const list = await client.listTools()
    // 207 API tools + 2 meta-tools (canonry_help, canonry_load_toolkit).
    expect(list.tools).toHaveLength(209)
    const names = list.tools.map(tool => tool.name)
    expect(names).toContain('canonry_insights_list')
    expect(names).toContain('canonry_project_overview')
    expect(names).toContain('canonry_report')
    expect(names).toContain('canonry_history_global')
    expect(names).toContain('canonry_search')
    expect(names).toContain('canonry_competitor_landscape')
    expect(names).toContain('canonry_backlinks_latest_release')
    expect(names).toContain('canonry_traffic_connect_vercel')
    expect(names).toContain('canonry_ads_operation_resume_activation')
    expect(names).toContain('canonry_google_ads_sync')
    expect(names).toContain('canonry_gtm_sync')
    expect(names).toContain('canonry_conversion_tracking_integrity')
    expect(names).toContain('canonry_gsc_sitemaps_submit')
    expect(names).toContain('canonry_help')

    const draftAction = list.tools.find(tool => tool.name === 'canonry_measurement_draft_action')
    expect(draftAction?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        project: { type: 'string' },
        operation: {},
      },
      required: expect.arrayContaining(['project', 'operation']),
    })

    const draftInput = draftAction?.inputSchema as {
      properties?: {
        operation?: {
          anyOf?: OperationBranch[]
          oneOf?: OperationBranch[]
        }
      }
    }
    type RequestBranch = { properties?: Record<string, unknown> }
    type OperationBranch = {
      properties?: Record<string, {
        const?: unknown
        properties?: Record<string, unknown>
        anyOf?: RequestBranch[]
        oneOf?: RequestBranch[]
      }>
    }
    const operationSchema = draftInput.properties?.operation
    const operationBranches = operationSchema?.oneOf ?? operationSchema?.anyOf ?? []
    const requestFieldsByAction = [
      ['create', 'expectedActiveRevision'],
      ['import-sitemap', 'sitemapUrl'],
      ['apply-sitemap-selection', 'selections'],
      ['upsert-target', 'target'],
      ['rename-target', 'label'],
      ['merge-targets', 'mergedKeys'],
      ['exclude-target', 'targetKey'],
      ['rebind-target', 'discoveredUrl'],
      ['apply-assignments', 'queryIds'],
      ['remove-assignment', 'queryId'],
      ['clear-assignments', 'targetKey'],
      ['classify-assignments', 'assignments'],
      ['upsert-group', 'group'],
      ['remove-group', 'groupKey'],
      ['upsert-competitor', 'competitor'],
      ['remove-competitor', 'competitorKey'],
      ['publish', 'expectedCompiledChecksum'],
    ] as const
    for (const [action, field] of requestFieldsByAction) {
      const branch = operationBranches.find(candidate => candidate.properties?.action?.const === action)
      const request = branch?.properties?.request
      const requestBranches = request?.oneOf ?? request?.anyOf ?? [request]
      expect(
        requestBranches.some(candidate => candidate?.properties && field in candidate.properties),
        `${action}.${field}`,
      ).toBe(true)
    }

    const draftTarget = {
      stableKey: 'target-a',
      label: 'Target A',
      status: 'included',
      aliases: ['Target A'],
      urlMatchers: ['https://acme.example.com/target-a'],
      source: 'manual',
    }
    const missingEtag = await client.callTool({
      name: 'canonry_measurement_draft_action',
      arguments: {
        project: 'acme',
        operation: {
          action: 'upsert-target',
          request: { target: draftTarget },
          idempotencyKey: 'request-missing-etag',
        },
      },
    })
    expect(missingEtag.isError).toBe(true)
    expect(jsonText(missingEtag)).toMatchObject({
      error: {
        code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED',
        details: { httpStatus: 428 },
      },
    })

    const staleEtag = await client.callTool({
      name: 'canonry_measurement_draft_action',
      arguments: {
        project: 'acme',
        operation: {
          action: 'upsert-target',
          request: { target: draftTarget },
          etag: '"mpd_stale"',
          idempotencyKey: 'request-stale-etag',
        },
      },
    })
    expect(staleEtag.isError).toBe(true)
    expect(jsonText(staleEtag)).toMatchObject({
      error: {
        code: 'MEASUREMENT_DRAFT_ETAG_STALE',
        details: { httpStatus: 412 },
      },
    })
  }, SUBPROCESS_CASE_TIMEOUT_MS)
})

/**
 * Spawn the `canonry-mcp` stdio adapter and return a client that has completed
 * the MCP handshake.
 *
 * The wait is on the `initialize` response — `client.connect()` resolves on that
 * frame, so readiness is observed rather than guessed at with a sleep. The race
 * against `HANDSHAKE_TIMEOUT_MS` only bounds a child that never answers, and
 * reports the phase plus whatever the child wrote to stderr; without it, a
 * subprocess that dies during startup surfaces as a bare protocol error with the
 * reason discarded.
 */
async function startMcpClient(options: {
  apiOrigin: string
  configPrefix: string
  database: string
  clientName: string
  args?: readonly string[]
}): Promise<{ client: Client; stderr: () => string }> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), options.configPrefix))
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    `apiUrl: ${options.apiOrigin}`,
    `database: ${options.database}`,
    'apiKey: cnry_test',
    '',
  ].join('\n'))

  const stderrChunks: string[] = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, mcpCli, ...(options.args ?? [])],
    cwd: packageRoot,
    env: {
      ...stringEnv(),
      // NODE_OPTIONS, not a CLI flag: tsx re-execs node with an execArgv of its
      // own (--require preflight.cjs --import loader.mjs) and drops whatever
      // was passed on the original command line, so `node
      // --disable-warning=... tsx cli.ts` never reaches the process that emits
      // the warning. NODE_OPTIONS survives the re-exec. Verified both ways on
      // this repo's tsx; the CLI-flag form shipped green on Node 22 and failed
      // only on the Node 26 lane, which is the whole reason that lane exists.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0205']
        .filter(Boolean)
        .join(' '),
      CANONRY_CONFIG_DIR: configDir,
      CANONRY_BASE_PATH: '',
    },
    stderr: 'pipe',
  })
  // Drain stderr on both paths: it is an assertion in the first case, the only
  // diagnostic in a failed handshake, and an unread pipe the child can block on.
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)))

  const client = new Client({ name: options.clientName, version: '0.0.0' })
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const stderr = stderrChunks.join('').trim()
          reject(new Error(
            `canonry-mcp did not answer initialize within ${HANDSHAKE_TIMEOUT_MS}ms`
            + `${stderr ? `; stderr: ${stderr}` : ' (no stderr output)'}`,
          ))
        }, HANDSHAKE_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    // The caller never received the client, so nothing else can reap the child.
    await client.close().catch(() => {})
    const stderr = stderrChunks.join('').trim()
    if (error instanceof Error && stderr && !error.message.includes(stderr)) {
      error.message = `${error.message}; canonry-mcp stderr: ${stderr}`
    }
    throw error
  } finally {
    clearTimeout(timer)
  }

  return { client, stderr: () => stderrChunks.join('') }
}

async function startStubApi(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start stub API')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
    send(response, [{ name: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' }])
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/projects/acme/insights') {
    send(response, [])
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/projects/acme/queries') {
    request.resume()
    send(response, [{ id: 'k1', query: 'alpha', createdAt: '2026-04-27T00:00:00Z' }])
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/projects/acme/traffic/sources') {
    send(response, { sources: [] })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/projects/acme/traffic/sources/src-1/sync') {
    request.resume()
    send(response, {
      sourceId: 'src-1',
      runId: 'run-traffic-1',
      syncedAt: '2026-05-08T00:00:00Z',
      pulledEvents: 0,
      crawlerHits: 0,
      aiReferralHits: 0,
      unknownHits: 0,
      crawlerBucketRows: 0,
      aiReferralBucketRows: 0,
      sampleRows: 0,
      windowStart: '2026-05-07T23:30:00Z',
      windowEnd: '2026-05-08T00:00:00Z',
    })
    return
  }
  if (
    request.method === 'POST'
    && url.pathname === '/api/v1/projects/acme/measurement-plan/draft/actions/upsert-target'
  ) {
    request.resume()
    if (request.headers['if-match'] === undefined) {
      send(response, {
        error: {
          code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED',
          message: 'Draft ETag is required.',
        },
      }, 428)
      return
    }
    send(response, {
      error: {
        code: 'MEASUREMENT_DRAFT_ETAG_STALE',
        message: 'Draft ETag is stale.',
      },
    }, 412)
    return
  }
  send(response, { error: { code: 'NOT_FOUND', message: `${request.method} ${url.pathname}` } }, 404)
}

function send(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function jsonText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text tool result')
  return JSON.parse(item.text)
}
