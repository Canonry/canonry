/**
 * The Aero eval harness (eval/aero), without a model call anywhere: the SSE
 * turn capture against a stub server, the truncation reader, the live-database
 * guard, the request guard, and an in-process target on a throwaway database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  apiKeys,
  createClient,
  llmUsageEvents,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  users,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import {
  TurnCollector,
  createRunner,
  detectPartialLists,
  detectTruncation,
  fillPrompt,
  type CostReader,
  type RunnerTarget,
} from '../eval/aero/runner.js'
import {
  EVAL_BLOCKED_MESSAGE,
  assertSafeDatabasePath,
  buildRequestPolicy,
  createDbCostReader,
  detectProjectKind,
  discoverLiveDatabases,
  processesHoldingFile,
  startTarget,
  type LiveDatabaseDiscovery,
} from '../eval/aero/target.js'

const NO_LIVE: LiveDatabaseDiscovery = { databases: [], referencedPaths: [], notes: [] }

// A structured trim, as mcp-to-agent-tool.ts renders it.
const STRUCTURED = JSON.stringify({
  weakestProperties: [{ label: 'Harbor' }],
  __truncated: true,
  __omittedRows: 29,
  __truncation: { droppedKeys: [], keptItems: { weakestProperties: '21 of 50' } },
}, null, 2)
// A plain slice: cut text, the summary line, then the closing note.
const SLICE = `{\n  "metrics": {"mentioned": 91},\n  "weakestProperties": [\n    {"label": "Har\n__truncation: {"cutAt":"weakestProperties[21]","droppedKeys":["markets","mentionRanking"],"keptItems":{"weakestProperties":"21 of 50","markets":"0 of 120"}}\n... (truncated, result too large)`

function sse(frames: unknown[]): string {
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function turnFrames(opts: { answer?: string; toolText?: string; reason?: string } = {}): unknown[] {
  return [
    { type: 'stream_open' },
    { type: 'agent_start' },
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'canonry_measurement_portfolio_summary', args: { limit: 50, queryClass: 'non-brand' }, label: 'Portfolio' },
    { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'canonry_measurement_portfolio_summary', result: { content: [{ type: 'text', text: 'ignored when message_end arrives' }] }, isError: false },
    {
      type: 'message_end',
      message: {
        role: 'toolResult', toolCallId: 'c1', toolName: 'canonry_measurement_portfolio_summary', isError: false,
        content: [{ type: 'text', text: opts.toolText ?? SLICE }], details: { huge: 'x'.repeat(5000) },
        aeroToolLabel: 'Portfolio', aeroDurationMs: 42,
      },
    },
    { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'canonry_measurement_overview', args: {} },
    { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'canonry_measurement_overview', result: { content: [{ type: 'text', text: '{"error":"boom"}' }] }, isError: true },
    { type: 'message_end', message: { role: 'assistant', provider: 'deepinfra', model: 'test-model', content: [{ type: 'text', text: 'Let me look.' }, { type: 'toolCall', id: 'c1' }] } },
    { type: 'message_end', message: { role: 'assistant', provider: 'deepinfra', model: 'test-model', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: opts.answer ?? 'Harbor is weakest: 0 of 24 answers.' }] } },
    { type: 'aero_turn_status', status: { reason: opts.reason ?? 'completed', toolCalls: 2, modelCalls: 2, durationMs: 1234, limits: {} } },
    { type: 'stream_close' },
  ]
}

describe('detectTruncation', () => {
  it('reads the structured __truncation field', () => {
    const result = detectTruncation(STRUCTURED)
    expect(result.truncated).toBe(true)
    expect(result.note).toContain('weakestProperties 21 of 50')
  })

  it('reads the plain-slice summary line, naming what was cut', () => {
    const result = detectTruncation(SLICE)
    expect(result.truncated).toBe(true)
    expect(result.note).toContain('plain slice')
    expect(result.note).toContain('cut at weakestProperties[21]')
    expect(result.note).toContain('dropped markets, mentionRanking')
  })

  it('flags a slice with no summary line', () => {
    const result = detectTruncation(`${'x'.repeat(100)}\n... (truncated, result too large)`)
    expect(result).toEqual({ truncated: true, note: expect.stringContaining('no summary') })
  })

  it('leaves whole results alone', () => {
    expect(detectTruncation('{"rows": [1, 2, 3]}')).toEqual({ truncated: false })
    expect(detectTruncation('Loaded toolkit measurement.')).toEqual({ truncated: false })
  })

  it('finds a nested trim in compact tool text, the form the product now sends', () => {
    const compact = JSON.stringify({ comparison: { changedProperties: [{ label: 'Harbor' }], __truncated: true } })
    expect(detectTruncation(compact)).toEqual({ truncated: true, note: 'nested collections trimmed' })
  })

  it('names a cursor the trim made skip rows', () => {
    const text = JSON.stringify({
      rows: [{ label: 'Harbor' }],
      nextCursor: 'abc',
      __truncated: true,
      __truncation: { keptItems: { rows: '1 of 5' }, cursors: { nextCursor: 'skips the 4 rows cut from rows; to read them, call again with limit <= 1' } },
    })
    expect(detectTruncation(text).note).toContain('cursor nextCursor skips the cut rows')
  })

  it('is not fooled by a tool that only reports its own partial lists', () => {
    const text = JSON.stringify({ __partialLists: { weakestProperties: '4 of 40' }, weakestProperties: [{ label: 'Harbor' }], totalProperties: 40 })
    expect(detectTruncation(text)).toEqual({ truncated: false })
  })
})

describe('detectPartialLists', () => {
  it("reads the tool's own partial lists from compact and indented results", () => {
    const value = { __partialLists: { weakestProperties: '4 of 40', mentionRanking: 'the tool cut the lists here' }, weakestProperties: [] }
    const expected = 'weakestProperties 4 of 40; mentionRanking the tool cut the lists here'
    expect(detectPartialLists(JSON.stringify(value))).toBe(expected)
    expect(detectPartialLists(JSON.stringify(value, null, 2))).toBe(expected)
  })

  it('reads the field off a plain slice, and ignores results without it', () => {
    const sliced = `{"__partialLists":{"rows":"10 of 12"},"rows":[{"label":"Har\n... (truncated, result too large)`
    expect(detectPartialLists(sliced)).toBe('rows 10 of 12')
    expect(detectPartialLists('{"rows":[1,2]}')).toBeUndefined()
    expect(detectPartialLists('{"note":"__partialLists"}')).toBeUndefined()
    expect(detectPartialLists('Loaded toolkit measurement.')).toBeUndefined()
  })
})

describe('TurnCollector', () => {
  it('folds a turn into the answer, the tool trace and the status', () => {
    const collector = new TurnCollector()
    for (const frame of turnFrames()) collector.push(frame)
    const turn = collector.result()
    expect(turn.answer).toBe('Harbor is weakest: 0 of 24 answers.')
    expect(turn.status).toBe('completed')
    expect(turn.toolCalls).toBe(2)
    expect(turn.modelCalls).toBe(2)
    expect(turn.durationMs).toBe(1234)
    expect(turn.error).toBeUndefined()
    expect(turn.models).toEqual(['deepinfra/test-model'])
    expect(turn.tools).toHaveLength(2)
    const [summary, overview] = turn.tools
    // The text the model read (message_end), not the raw execution result.
    expect(summary).toMatchObject({
      name: 'canonry_measurement_portfolio_summary',
      args: { limit: 50, queryClass: 'non-brand' },
      isError: false,
      resultChars: SLICE.length,
      resultText: SLICE,
      truncated: true,
      durationMs: 42,
    })
    expect(summary!.resultPreview).toBe(SLICE.slice(0, 400))
    expect(summary!.truncationNote).toContain('dropped markets, mentionRanking')
    // No tool-result frame arrived: the execution result stands in.
    expect(overview).toMatchObject({ name: 'canonry_measurement_overview', isError: true, resultText: '{"error":"boom"}', truncated: false })
    expect(summary!.requestedName).toBeUndefined()
  })

  it('records the name the model wrote when the runtime corrected a misspelled call, and the partial lists', () => {
    const collector = new TurnCollector()
    const text = JSON.stringify({ __partialLists: { rows: '2 of 9' }, rows: [1, 2] })
    collector.push({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'canonry_measurement_overview', args: {} })
    collector.push({
      type: 'message_end',
      message: {
        role: 'toolResult', toolCallId: 'c1', toolName: 'canonry_measurement_overview', isError: false,
        content: [{ type: 'text', text }], aeroRequestedToolName: 'canrony_measurement_overview',
      },
    })
    collector.push({ type: 'stream_close' })
    const [trace] = collector.result().tools
    expect(trace).toMatchObject({ name: 'canonry_measurement_overview', requestedName: 'canrony_measurement_overview', partialNote: 'rows 2 of 9', truncated: false })
  })

  it('reports a stream error and a stream that never closed', () => {
    const errored = new TurnCollector()
    errored.push({ type: 'error', message: 'provider said no' })
    errored.push({ type: 'aero_turn_status', status: { reason: 'error', toolCalls: 0, modelCalls: 1, durationMs: 5 } })
    errored.push({ type: 'stream_close' })
    expect(errored.result()).toMatchObject({ status: 'error', error: 'provider said no', answer: '' })

    const cut = new TurnCollector()
    for (const frame of turnFrames().slice(0, 4)) cut.push(frame)
    expect(cut.result()).toMatchObject({ status: 'error', error: expect.stringContaining('before stream_close') })
  })
})

describe('fillPrompt', () => {
  it('fills known placeholders and names the missing ones', () => {
    expect(fillPrompt('Why is {property} behind {metro}?', { property: 'Harbor' })).toEqual({
      text: 'Why is Harbor behind {metro}?',
      missing: ['metro'],
    })
  })
})

describe('createRunner against a stub server', () => {
  let server: http.Server
  let baseUrl: string
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = []
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void

  beforeEach(async () => {
    requests.length = 0
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, headers: req.headers, body })
        respond(req, res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  function stubTarget(cost: number | null = 0.0123): RunnerTarget & { marks: number } {
    const reader: CostReader & { marks: number } = {
      marks: 0,
      mark() { this.marks++; return 7 },
      since(mark) { expect(mark).toBe(7); return { costUsd: cost, models: ['deepinfra/test-model'] } },
    }
    return {
      baseUrl,
      headers: (lane): Record<string, string> => lane === 'admin'
        ? { authorization: 'Bearer cnry_stub' }
        : { cookie: 'canonry_user_session=abc', origin: baseUrl },
      costReader: reader,
      get marks() { return reader.marks },
    }
  }

  it('resets the lane, prompts read-only, and captures the streamed turn, split across chunks', async () => {
    respond = (req, res) => {
      if (req.method === 'DELETE') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"reset"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const body = sse(turnFrames())
      // Deliberately awkward chunking: frame boundaries land mid-chunk.
      let offset = 0
      const step = () => {
        if (offset >= body.length) return res.end()
        res.write(body.slice(offset, offset + 97))
        offset += 97
        setImmediate(step)
      }
      step()
    }
    const target = stubTarget()
    const runner = createRunner(target, { project: 'acme co' })
    const capture = await runner.ask({ questionId: 'q1', prompt: 'Which properties are worst?', lane: 'viewer', attempt: 2 })

    expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
      'DELETE /api/v1/projects/acme%20co/agent/transcript',
      'POST /api/v1/projects/acme%20co/agent/prompt',
    ])
    for (const r of requests) {
      expect(r.headers.cookie).toBe('canonry_user_session=abc')
      expect(r.headers.origin).toBe(baseUrl)
    }
    expect(JSON.parse(requests[1]!.body)).toEqual({ prompt: 'Which properties are worst?', scope: 'read-only' })
    expect(capture).toMatchObject({
      questionId: 'q1',
      lane: 'viewer',
      attempt: 2,
      prompt: 'Which properties are worst?',
      answer: 'Harbor is weakest: 0 of 24 answers.',
      status: 'completed',
      toolCalls: 2,
      modelCalls: 2,
      durationMs: 1234,
      costUsd: 0.0123,
    })
    expect(capture.error).toBeUndefined()
    expect(capture.tools[0]!.truncated).toBe(true)
    expect(target.marks).toBe(1)
    expect([...runner.modelsSeen]).toEqual(['deepinfra/test-model'])
  })

  it("records the target's system context on the capture, and asks without it when it cannot be read", async () => {
    respond = (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(turnFrames()))
    }
    const withContext = { ...stubTarget(), systemContext: () => '\n\nProject shape: a Simple project with 12 tracked queries.' }
    const capture = await createRunner(withContext, { project: 'acme' }).ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    expect(capture.systemContext).toBe('Project shape: a Simple project with 12 tracked queries.')
    const broken = { ...stubTarget(), systemContext: () => { throw new Error('no such table') } }
    const without = await createRunner(broken, { project: 'acme' }).ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    expect(without.status).toBe('completed')
    expect(without).not.toHaveProperty('systemContext')
  })

  it('stops before prompting when the reset fails, so no attempt reads an earlier one', async () => {
    respond = (_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'AGENT_BUSY', message: 'Aero is busy' } }))
    }
    const capture = await createRunner(stubTarget(), { project: 'acme', resetRetryMs: 1 }).ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    // A busy lane is retried, then the ask gives up without prompting.
    expect(requests.map(r => r.method)).toEqual(Array(11).fill('DELETE'))
    expect(requests[0]!.headers.authorization).toBe('Bearer cnry_stub')
    expect(capture).toMatchObject({ status: 'error', answer: '', tools: [], costUsd: null })
    expect(capture.error).toContain('Could not reset the admin conversation')
    expect(capture.error).toContain('AGENT_BUSY')
  })

  it('waits out a lane still winding down from a stopped turn', async () => {
    let deletes = 0
    respond = (req, res) => {
      if (req.method === 'DELETE') {
        deletes++
        res.writeHead(deletes < 3 ? 409 : 200, { 'content-type': 'application/json' })
        res.end(deletes < 3 ? '{"error":{"code":"AGENT_BUSY","message":"busy"}}' : '{"status":"reset"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(turnFrames()))
    }
    const capture = await createRunner(stubTarget(), { project: 'acme', resetRetryMs: 1 }).ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    expect(requests.map(r => r.method)).toEqual(['DELETE', 'DELETE', 'DELETE', 'POST'])
    expect(capture.status).toBe('completed')
  })

  it('records an HTTP refusal of the prompt and a stream cut short', async () => {
    let calls = 0
    respond = (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200); res.end('{}'); return }
      calls++
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED', message: 'daily limit' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(turnFrames().slice(0, 5)))
    }
    const runner = createRunner(stubTarget(null), { project: 'acme' })
    const refused = await runner.ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    expect(refused).toMatchObject({ status: 'error', error: expect.stringContaining('QUOTA_EXCEEDED: daily limit'), costUsd: null })
    const cut = await runner.ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 2 })
    expect(cut.status).toBe('error')
    expect(cut.error).toContain('before stream_close')
    expect(cut.tools).toHaveLength(1)
  })

  it('gives up on a turn that outlives the client timeout', async () => {
    respond = (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(200); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse([{ type: 'stream_open' }]))
      // Never ends.
    }
    const capture = await createRunner(stubTarget(), { project: 'acme', timeoutMs: 200 }).ask({ questionId: 'q1', prompt: 'x', lane: 'admin', attempt: 1 })
    expect(capture.status).toBe('error')
    expect(capture.error).toContain('stopped waiting')
  })
})

describe('buildRequestPolicy', () => {
  const policy = buildRequestPolicy([
    { name: 'overview', access: 'read', openApiOperations: ['GET /api/v1/projects/{name}/overview'] },
    { name: 'ads_account', access: 'read', annotations: { openWorldHint: true }, openApiOperations: ['GET /api/v1/projects/{name}/ads/account'] },
    { name: 'harvest', access: 'read', openApiOperations: ['GET /api/v1/projects/{name}/discover/harvest'] },
    { name: 'replace_preview', access: 'read', openApiOperations: ['POST /api/v1/projects/{name}/queries/replace-preview'] },
    { name: 'run_trigger', access: 'write', openApiOperations: ['POST /api/v1/projects/{name}/runs'] },
  ], new Set(['harvest']))

  it('lets reads and the agent routes through', () => {
    expect(policy.check('GET', '/api/v1/projects/acme/overview?since=2026-01-01')).toEqual({ allow: true })
    expect(policy.check('GET', '/health')).toEqual({ allow: true })
    expect(policy.check('POST', '/api/v1/projects/acme/agent/prompt')).toEqual({ allow: true })
    expect(policy.check('DELETE', '/api/v1/projects/acme%20co/agent/transcript')).toEqual({ allow: true })
    expect(policy.check('POST', '/api/v1/projects/acme/queries/replace-preview')).toEqual({ allow: true })
  })

  it('refuses writes, live provider reads, and named extra tools', () => {
    expect(policy.check('POST', '/api/v1/projects/acme/runs')).toEqual({ allow: false, reason: 'write' })
    expect(policy.check('PUT', '/api/v1/projects/acme/agent/memory')).toEqual({ allow: false, reason: 'write' })
    expect(policy.check('POST', '/api/v1/session/setup')).toEqual({ allow: false, reason: 'write' })
    expect(policy.check('GET', '/api/v1/projects/acme/ads/account')).toEqual({ allow: false, reason: 'live provider read' })
    expect(policy.check('GET', '/api/v1/projects/acme/discover/harvest?x=1')).toEqual({ allow: false, reason: 'live provider read' })
  })
})

describe('live-database guard', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aero-eval-guard-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function file(rel: string): string {
    const p = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'db')
    return p
  }

  const none = () => [] as number[]

  it('accepts a plain copy', () => {
    const copy = file('work/copy.db')
    expect(assertSafeDatabasePath(copy, { discovery: NO_LIVE, home: path.join(tmp, 'home'), holders: none })).toBe(copy)
  })

  it('refuses a live database by path, by hard link, and by pm2 reference', () => {
    const live = file('live/data.db')
    const discovery = { ...NO_LIVE, databases: [live] }
    expect(() => assertSafeDatabasePath(live, { discovery, holders: none })).toThrow(/a Canonry config points at/)
    const link = path.join(tmp, 'work/link.db')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.linkSync(live, link)
    expect(() => assertSafeDatabasePath(link, { discovery, holders: none })).toThrow(/hard link/)
    const referenced = file('pm2/data.db')
    expect(() => assertSafeDatabasePath(referenced, { discovery: { ...NO_LIVE, referencedPaths: [referenced] }, holders: none })).toThrow(/pm2 process/)
  })

  it("refuses the source config's own database", () => {
    const live = file('cfg-live/data.db')
    const configDir = path.join(tmp, 'cfg')
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'config.yaml'), `database: ${live}\n`)
    expect(() => assertSafeDatabasePath(live, { discovery: NO_LIVE, configDirs: [configDir], holders: none })).toThrow(/config points at/)
  })

  it('accepts a scratch copy of a whole config dir, database inside it', () => {
    const copiedDir = path.join(tmp, 'copied-config')
    const copy = file('copied-config/data.db')
    fs.writeFileSync(path.join(copiedDir, 'config.yaml'), `database: ${copy}\n`)
    expect(assertSafeDatabasePath(copy, { discovery: NO_LIVE, configDirs: [copiedDir], holders: none })).toBe(copy)
  })

  it('refuses ~/.canonry* paths unless they sit in a tmp or scratch folder', () => {
    const home = path.join(tmp, 'home')
    expect(() => assertSafeDatabasePath(file('home/.canonry-client/data.db'), { discovery: NO_LIVE, home, holders: none })).toThrow(/~\/\.canonry\* directory/)
    expect(() => assertSafeDatabasePath(file('home/.canonry/backups/old.db'), { discovery: NO_LIVE, home, holders: none })).toThrow(/~\/\.canonry\* directory/)
    const scratch = file('home/.canonry-evals/scratch/copy.db')
    expect(assertSafeDatabasePath(scratch, { discovery: NO_LIVE, home, holders: none })).toBe(scratch)
  })

  it('refuses a file another process holds open', () => {
    const copy = file('work/busy.db')
    expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: () => [4242] })).toThrow(/pid 4242/)
  })

  it('refuses when it cannot check who has the file open', () => {
    const copy = file('work/unknown.db')
    const cannotTell = () => {
      throw new Error('lsof is not installed')
    }
    expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: cannotTell }))
      .toThrow(/could not check whether another process has the database open \(lsof is not installed\); refusing/)
  })

  describe('open-file detection with lsof (macOS and other non-Linux platforms)', () => {
    const exitError = (status: number, stdout: string, stderr = '') =>
      Object.assign(new Error(`Command failed: lsof (exit ${status})`), { status, stdout, stderr })
    const lsof = (exec: (command: string, args: string[]) => string) => (target: string) =>
      processesHoldingFile(target, { platform: 'darwin', exec })

    it('refuses a file lsof reports another pid holding, and checks the WAL files that exist', () => {
      const copy = file('work/held.db')
      fs.writeFileSync(`${copy}-wal`, '')
      const calls: string[][] = []
      const holders = lsof((command, args) => {
        calls.push([command, ...args])
        return `4242\n${process.pid}\n`
      })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders })).toThrow(/another process \(pid 4242\) has it open/)
      expect(calls).toEqual([['lsof', '-w', '-t', '--', copy, `${copy}-wal`]])
    })

    it('accepts a file when lsof exits 1 with no output', () => {
      const copy = file('work/idle.db')
      const holders = lsof(() => {
        throw exitError(1, '')
      })
      expect(assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders })).toBe(copy)
    })

    it('refuses when lsof is missing, fails, or errors without output', () => {
      const copy = file('work/unchecked.db')
      const missing = lsof(() => {
        throw Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' })
      })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: missing })).toThrow(/could not check .*\(lsof is not installed\); refusing/)
      const crashed = lsof(() => {
        throw exitError(2, '')
      })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: crashed })).toThrow(/could not check .*\(lsof failed \(exit status 2\)\)/)
      const errored = lsof(() => {
        throw exitError(1, '', 'lsof: status error on the file\n')
      })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: errored })).toThrow(/could not check .*\(lsof reported an error\)/)
      // Pids beside an error still count as holders.
      expect(lsof(() => {
        throw exitError(1, '4242\n', 'lsof: status error on a sibling\n')
      })(copy)).toEqual([4242])
    })
  })

  describe('open-file detection with /proc (Linux)', () => {
    it('finds a process holding only the shared-memory file', () => {
      const copy = file('work/shm.db')
      const tree: Record<string, string[]> = { '/proc': ['self', String(process.pid), '4242'], '/proc/4242/fd': ['0', '7'] }
      const links: Record<string, string> = { '/proc/4242/fd/0': '/dev/null', '/proc/4242/fd/7': `${copy}-shm` }
      const holders = processesHoldingFile(copy, {
        platform: 'linux',
        readdir: dir => tree[dir] ?? [],
        readlink: link => links[link] ?? '',
      })
      expect(holders).toEqual([4242])
    })

    it('finds a process holding the file under another name, by device and inode', () => {
      const copy = file('work/linked.db')
      const tree: Record<string, string[]> = { '/proc': [String(process.pid), '4242', '4343'], '/proc/4242/fd': ['3'], '/proc/4343/fd': ['3'] }
      const links: Record<string, string> = { '/proc/4242/fd/3': '/elsewhere/live.db', '/proc/4343/fd/3': '/elsewhere/other.db' }
      const inode = fs.statSync(copy).ino
      const identities: Record<string, { dev: number; ino: number }> = {
        '/proc/4242/fd/3': { dev: fs.statSync(copy).dev, ino: inode },
        '/proc/4343/fd/3': { dev: fs.statSync(copy).dev, ino: inode + 1 },
      }
      const holders = processesHoldingFile(copy, {
        platform: 'linux',
        readdir: dir => tree[dir] ?? [],
        readlink: link => links[link] ?? '',
        stat: p => identities[p] ?? fs.statSync(p),
      })
      expect(holders).toEqual([4242])
    })

    it('refuses when /proc cannot be listed or does not show this process', () => {
      const copy = file('work/noproc.db')
      const unreadable = (target: string) => processesHoldingFile(target, {
        platform: 'linux',
        readdir: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        },
      })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: unreadable })).toThrow(/could not check .*\(\/proc could not be listed\); refusing/)
      const empty = (target: string) => processesHoldingFile(target, { platform: 'linux', readdir: () => [] })
      expect(() => assertSafeDatabasePath(copy, { discovery: NO_LIVE, holders: empty })).toThrow(/could not check .*\(\/proc does not list this process\)/)
    })
  })

  describe('open-file detection against a real process', () => {
    const lsofInstalled = !spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error

    async function holdOpen(target: string): Promise<ChildProcess> {
      const fd = fs.openSync(target, 'r')
      try {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: [fd, 'ignore', 'ignore'] })
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        return child
      } finally {
        fs.closeSync(fd)
      }
    }

    it.runIf(process.platform === 'linux')('sees a child process holding the file through /proc', async () => {
      const copy = file('work/proc-held.db')
      const child = await holdOpen(copy)
      try {
        expect(processesHoldingFile(copy)).toEqual([child.pid])
        expect(processesHoldingFile(file('work/proc-idle.db'))).toEqual([])
      } finally {
        child.kill()
      }
    })

    it.runIf(process.platform === 'linux')('sees a child process holding the file through a hard link, through /proc', async () => {
      const held = file('work/proc-original.db')
      const link = path.join(tmp, 'work/proc-hardlink.db')
      fs.linkSync(held, link)
      const child = await holdOpen(held)
      try {
        expect(processesHoldingFile(link)).toEqual([child.pid])
        expect(() => assertSafeDatabasePath(link, { discovery: NO_LIVE })).toThrow(new RegExp(`another process \\(pid ${child.pid}\\) has it open`))
      } finally {
        child.kill()
      }
    })

    it.runIf(lsofInstalled)('sees a child process holding the file through a hard link, through the real lsof', async () => {
      const held = file('work/lsof-original.db')
      const link = path.join(tmp, 'work/lsof-hardlink.db')
      fs.linkSync(held, link)
      const child = await holdOpen(held)
      try {
        expect(processesHoldingFile(link, { platform: 'darwin' })).toEqual([child.pid])
      } finally {
        child.kill()
      }
    })

    it.runIf(lsofInstalled)('sees a child process holding the file through the real lsof', async () => {
      const copy = file('work/lsof-held.db')
      const child = await holdOpen(copy)
      try {
        expect(processesHoldingFile(copy, { platform: 'darwin' })).toEqual([child.pid])
        expect(processesHoldingFile(file('work/lsof-idle.db'), { platform: 'darwin' })).toEqual([])
      } finally {
        child.kill()
      }
    })
  })

  it('discovers databases from pm2 config dirs and every ~/.canonry* config, keeping only paths', () => {
    const home = path.join(tmp, 'home')
    const fromPm2 = path.join(tmp, 'pm2-config')
    fs.mkdirSync(fromPm2, { recursive: true })
    fs.writeFileSync(path.join(fromPm2, 'config.yaml'), 'database: ./engine.db\napiKey: cnry_secret\n')
    fs.mkdirSync(path.join(home, '.canonry-side'), { recursive: true })
    fs.writeFileSync(path.join(home, '.canonry-side', 'config.yaml'), `database: ${path.join(tmp, 'side.db')}\n`)
    const discovery = discoverLiveDatabases({
      home,
      pm2: () => [{ name: 'engine', pm2_env: { pm_cwd: '/srv/engine', args: ['serve', '--port', '4100'], env: { CANONRY_CONFIG_DIR: fromPm2, SOME_TOKEN: 'not-a-path' } } }],
    })
    expect(discovery.databases).toEqual(expect.arrayContaining([path.join(fromPm2, 'engine.db'), path.join(tmp, 'side.db')]))
    expect(discovery.referencedPaths).toEqual(expect.arrayContaining(['/srv/engine', fromPm2]))
    expect(JSON.stringify(discovery)).not.toContain('not-a-path')
    expect(JSON.stringify(discovery)).not.toContain('cnry_secret')
    expect(discoverLiveDatabases({ home, pm2: () => null }).notes[0]).toMatch(/pm2 is not available/)
  })
})

describe('database helpers', () => {
  let tmp: string
  let db: DatabaseClient

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-eval-db-'))
    db = createClient(path.join(tmp, 'copy.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'p1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function usage(id: string, costMillicents: number, totalTokens: number, projectId = 'p1', feature = 'aero.turn') {
    db.insert(llmUsageEvents).values({
      id, projectId, feature, provider: 'deepinfra', model: 'test-model', totalTokens, costMillicents, createdAt: new Date().toISOString(),
    }).run()
  }

  it('prices an Aero turn from the usage rows written after the mark, and says unknown when it cannot', () => {
    usage('before', 99_000, 10)
    const reader = createDbCostReader(db, 'p1')
    const mark = reader.mark()
    expect(reader.since(mark)).toMatchObject({ costUsd: null, models: [] })
    usage('a', 1_500, 100)
    usage('b', 500, 50)
    usage('other-project', 7_000, 10, 'p1', 'discovery.seed')
    expect(reader.since(mark)).toMatchObject({ costUsd: 0.02, models: ['deepinfra/test-model'], tokens: 150 })
    const next = reader.mark()
    usage('unpriced', 0, 400)
    expect(reader.since(next).costUsd).toBeNull()
  })

  it('detects the project kind the way the project-shape prompt does', () => {
    expect(detectProjectKind(db, 'p1')).toBe('simple')
    const now = new Date().toISOString()
    db.insert(measurementPlanVersions).values({ id: 'v1', projectId: 'p1', revision: 1, canonicalJson: JSON.stringify({ schemaVersion: 1 }), checksum: 'c1', schemaVersion: 1, createdAt: now }).run()
    db.insert(measurementPlans).values({ projectId: 'p1', activeVersionId: 'v1', createdAt: now, updatedAt: now }).run()
    expect(detectProjectKind(db, 'p1')).toBe('legacy')
    db.insert(measurementPlanVersions).values({ id: 'v2', projectId: 'p1', revision: 2, canonicalJson: JSON.stringify({ schemaVersion: 2 }), checksum: 'c2', schemaVersion: 2, createdAt: now }).run()
    db.update(measurementPlans).set({ activeVersionId: 'v2' }).where(eq(measurementPlans.projectId, 'p1')).run()
    expect(detectProjectKind(db, 'p1')).toBe('advanced')
  })
})

describe('startTarget on a throwaway database', () => {
  let tmp: string
  let dbPath: string
  let configDir: string
  const KEY = 'cnry_aero_eval_fixture_key'

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aero-eval-target-')))
    dbPath = path.join(tmp, 'copy.db')
    const db = createClient(dbPath)
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'p1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(apiKeys).values({ id: 'install', name: 'install', keyHash: hashApiKey(KEY), keyPrefix: KEY.slice(0, 9), scopes: ['*'], createdAt: now }).run()
    db.$client.close()
    configDir = path.join(tmp, 'source-config')
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'apiUrl: http://localhost:4100',
      `database: ${path.join(tmp, 'live.db')}`,
      `apiKey: ${KEY}`,
      'basePath: /canonry/',
      'agent:',
      '  allowViewers: true',
      '',
    ].join('\n'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('serves the copy with the guard on, both lanes signed in, and cleans up after itself', async () => {
    const sourceBefore = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8')
    const promptOnlyBefore = process.env.CANONRY_AGENT_PROMPT_ONLY
    const target = await startTarget({ db: dbPath, sourceConfigDir: configDir, project: 'acme', guard: { discovery: NO_LIVE } })
    try {
      expect(target.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(target.projectId).toBe('p1')
      expect(process.env.CANONRY_AGENT_PROMPT_ONLY).toBe('1')
      expect(fs.statSync(path.join(target.workDir, 'config', 'config.yaml')).mode & 0o777).toBe(0o600)

      const list = await fetch(`${target.baseUrl}/api/v1/projects`, { headers: target.adminHeaders })
      expect(list.status).toBe(200)
      expect(JSON.stringify(await list.json())).toContain('acme')

      const run = await fetch(`${target.baseUrl}/api/v1/projects/acme/runs`, { method: 'POST', headers: { ...target.adminHeaders, 'content-type': 'application/json' }, body: '{}' })
      expect(run.status).toBe(403)
      expect(await run.json()).toEqual({ error: { code: 'EVAL_BLOCKED', message: EVAL_BLOCKED_MESSAGE } })
      const live = await fetch(`${target.baseUrl}/api/v1/projects/acme/ads/account`, { headers: target.adminHeaders })
      expect(live.status).toBe(403)
      expect(target.blocked.map(entry => `${entry.method} ${entry.path}`)).toEqual(['POST /api/v1/projects/acme/runs', 'GET /api/v1/projects/acme/ads/account'])

      // The project-shape text Aero's system prompt carries, read from the copy.
      expect(target.systemContext?.()).toMatch(/^Project shape: a Simple project with 0 tracked queries/)

      expect(target.laneAvailable('viewer')).toBe(true)
      const viewer = target.headers('viewer')
      const transcript = await fetch(`${target.baseUrl}/api/v1/projects/acme/agent/transcript`, { headers: viewer })
      expect(transcript.status).toBe(200)
      expect(await transcript.json()).toMatchObject({ messages: [], modelProvider: null })
      const reset = await fetch(`${target.baseUrl}/api/v1/projects/acme/agent/transcript`, { method: 'DELETE', headers: viewer })
      expect(reset.status).toBe(200)
      // The viewer is a real viewer: the operator's memory stays closed to it.
      const memory = await fetch(`${target.baseUrl}/api/v1/projects/acme/agent/memory`, { headers: viewer })
      expect(memory.status).toBe(403)
      const adminReset = await fetch(`${target.baseUrl}/api/v1/projects/acme/agent/transcript`, { method: 'DELETE', headers: target.adminHeaders })
      expect(adminReset.status).toBe(200)
    } finally {
      await target.close()
    }
    expect(fs.existsSync(target.workDir)).toBe(false)
    expect(process.env.CANONRY_AGENT_PROMPT_ONLY).toBe(promptOnlyBefore)
    expect(fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8')).toBe(sourceBefore)
    const db = createClient(dbPath)
    try {
      expect(db.select().from(users).all()).toEqual([])
      expect(db.select({ id: apiKeys.id }).from(apiKeys).all()).toEqual([{ id: 'install' }])
    } finally {
      db.$client.close()
    }
  }, 60_000)

  it('refuses to serve the database the source config points at', async () => {
    fs.copyFileSync(dbPath, path.join(tmp, 'live.db'))
    await expect(startTarget({ db: path.join(tmp, 'live.db'), sourceConfigDir: configDir, guard: { discovery: NO_LIVE } })).rejects.toThrow(/config points at/)
  })

  it('marks the viewer lane unavailable when the config does not allow viewers', async () => {
    fs.writeFileSync(path.join(configDir, 'config.yaml'), `apiUrl: http://localhost:4100\ndatabase: ${path.join(tmp, 'live.db')}\napiKey: ${KEY}\n`)
    const target = await startTarget({ db: dbPath, sourceConfigDir: configDir, project: 'acme', guard: { discovery: NO_LIVE } })
    try {
      expect(target.laneAvailable('viewer')).toBe(false)
      expect(target.viewerHeaders).toBeNull()
      expect(target.viewerUnavailableReason).toMatch(/allowViewers/)
      expect(() => target.headers('viewer')).toThrow(/allowViewers/)
    } finally {
      await target.close()
    }
  }, 60_000)
})
