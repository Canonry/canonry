import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { invokeCli } from './cli-test-utils.js'

// A newer CLI pointed at a server that predates competitor aliases. Its promote
// preview has no `skippedCompetitors` and its suggested competitors carry no
// `sources`; its promote result has no `competitorDetails`, and every name in
// `skipped.competitors` is one the project already tracks. Text mode reads
// those fields as absent, and JSON output stays equal to the server's response.

const SESSION_ID = 'sess-older'
const PROMOTE_PATH = `/api/v1/projects/rotorwise/discover/sessions/${SESSION_ID}/promote`

const OLDER_SERVER_PREVIEW = {
  sessionId: SESSION_ID,
  projectId: 'proj-1',
  queriesByBucket: {
    cited: ['best rotor repair shop'],
    aspirational: ['rotor blade inspection cost'],
    'wasted-surface': [],
  },
  suggestedCompetitors: [
    { domain: 'rival-one.example', hits: 3, competitorType: 'direct-competitor' },
    { domain: 'offers.rival-two.example', hits: 2, competitorType: 'editorial-media' },
  ],
  status: 'completed',
}

const OLDER_SERVER_PROMOTE_RESULT = {
  sessionId: SESSION_ID,
  projectId: 'proj-1',
  promoted: { queries: ['best rotor repair shop'], competitors: ['rival-one.example', 'rival-four.example'] },
  skipped: { queries: ['rotor blade inspection cost'], competitors: ['rival-three.example'] },
}

interface RecordedRequest {
  method: string
  url: string
  body: string
}

/** The recorded requests minus the CLI's `/health` base-path probe. */
function promoteRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter(r => r.url !== '/health')
}

describe('discover promote CLI against a server that predates competitor aliases', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let server: http.Server
  let requests: RecordedRequest[]
  let promoteResponse: unknown

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-discover-older-server-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    requests = []
    promoteResponse = OLDER_SERVER_PROMOTE_RESULT
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body })
        if (req.url === PROMOTE_PATH && (req.method === 'GET' || req.method === 'POST')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(req.method === 'GET' ? OLDER_SERVER_PREVIEW : promoteResponse))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const config = {
      apiUrl: `http://127.0.0.1:${port}`,
      database: path.join(tmpDir, 'data.db'),
      apiKey: `cnry_${crypto.randomBytes(16).toString('hex')}`,
      providers: {},
    }
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('previews a promote with no skipped competitors and no merged hosts, with JSON equal to the server response', async () => {
    const text = await invokeCli(['discover', 'promote', 'preview', 'rotorwise', SESSION_ID])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toBe([
      `Promote preview for session ${SESSION_ID} (status: completed):`,
      '  Cited (1)',
      '    + best rotor repair shop',
      '  Wasted-surface (0)',
      '  Aspirational (1)',
      '    + rotor blade inspection cost',
      '  Suggested new competitors:',
      '    - rival-one.example (3 hits, direct-competitor)',
      '    - offers.rival-two.example (2 hits, editorial-media)',
      '    Only direct-competitor is promoted by default \u2014 pass --competitor-types to include other types.',
      `\n  Run \`canonry discover promote rotorwise ${SESSION_ID}\` to merge cited + aspirational queries.`,
      '  Add `--bucket wasted-surface` only when off-ICP competitor gaps should be tracked.',
    ].join('\n'))

    for (const format of ['json', 'jsonl']) {
      const machine = await invokeCli(['discover', 'promote', 'preview', 'rotorwise', SESSION_ID, '--format', format])
      expect(machine.exitCode, machine.stderr).toBeUndefined()
      expect(JSON.parse(machine.stdout)).toEqual(OLDER_SERVER_PREVIEW)
    }
    expect(promoteRequests(requests).map(r => `${r.method} ${r.url}`)).toEqual([
      `GET ${PROMOTE_PATH}`,
      `GET ${PROMOTE_PATH}`,
      `GET ${PROMOTE_PATH}`,
    ])
  })

  it('reports a promote from the plain domain lists, counting every skipped competitor as already tracked', async () => {
    const text = await invokeCli(['discover', 'promote', 'rotorwise', SESSION_ID])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toBe([
      `Promoted discovery session ${SESSION_ID} into "rotorwise":`,
      '  Queries:     1 added, 1 already tracked',
      '    + best rotor repair shop',
      '  Competitors: 2 added, 1 already tracked, 0 left out',
      '    + rival-one.example',
      '    + rival-four.example',
    ].join('\n'))

    for (const format of ['json', 'jsonl']) {
      const machine = await invokeCli(['discover', 'promote', 'rotorwise', SESSION_ID, '--format', format])
      expect(machine.exitCode, machine.stderr).toBeUndefined()
      expect(JSON.parse(machine.stdout)).toEqual(OLDER_SERVER_PROMOTE_RESULT)
    }
    expect(promoteRequests(requests)).toEqual([
      { method: 'POST', url: PROMOTE_PATH, body: '{}' },
      { method: 'POST', url: PROMOTE_PATH, body: '{}' },
      { method: 'POST', url: PROMOTE_PATH, body: '{}' },
    ])
  })

  it('reports a promote that added nothing as nothing new', async () => {
    promoteResponse = {
      sessionId: SESSION_ID,
      projectId: 'proj-1',
      promoted: { queries: [], competitors: [] },
      skipped: { queries: ['best rotor repair shop', 'rotor blade inspection cost'], competitors: [] },
    }
    const text = await invokeCli(['discover', 'promote', 'rotorwise', SESSION_ID, '--no-competitors'])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toBe([
      `Promoted discovery session ${SESSION_ID} into "rotorwise":`,
      '  Queries:     0 added, 2 already tracked',
      '  Competitors: 0 added, 0 already tracked, 0 left out',
      "  Nothing new \u2014 the project's basket already covers this session.",
    ].join('\n'))
    expect(promoteRequests(requests)).toEqual([
      { method: 'POST', url: PROMOTE_PATH, body: JSON.stringify({ includeCompetitors: false }) },
    ])
  })
})
