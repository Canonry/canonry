import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { invokeCli } from './cli-test-utils.js'

// A newer CLI pointed at a server that predates competitor aliases: its
// competitor DTO has no `aliases` field and it has no alias routes. The CLI
// treats such a competitor as having no aliases and keeps JSON output equal to
// the server's response.

const OLDER_SERVER_COMPETITORS = [
  { id: 'c1', domain: 'rival-one.example', createdAt: '2026-04-01T00:00:00.000Z' },
  { id: 'c2', domain: 'rival-two.example', createdAt: '2026-04-02T00:00:00.000Z' },
]

interface RecordedRequest {
  method: string
  url: string
  body: string
}

describe('competitor CLI against a server that predates aliases', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let server: http.Server
  let requests: RecordedRequest[]

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-competitor-older-server-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    requests = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body })
        if (req.method === 'GET' && req.url === '/api/v1/projects/rotorwise/competitors') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(OLDER_SERVER_COMPETITORS))
          return
        }
        // The older server has no alias route: Fastify's default not-found reply.
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

  it('lists competitors in text, json and jsonl, with JSON equal to the server response', async () => {
    const text = await invokeCli(['competitor', 'list', 'rotorwise'])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toBe('Competitors for "rotorwise" (2):\n\n  rival-one.example\n  rival-two.example')

    const json = await invokeCli(['competitor', 'list', 'rotorwise', '--format', 'json'])
    expect(json.exitCode, json.stderr).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual(OLDER_SERVER_COMPETITORS)

    // jsonl writes through `process.stdout.write`, which invokeCli does not capture.
    let written = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk)
      return true
    })
    const jsonl = await invokeCli(['competitor', 'list', 'rotorwise', '--format', 'jsonl']).finally(() => spy.mockRestore())
    expect(jsonl.exitCode, jsonl.stderr).toBeUndefined()
    expect(written.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown))
      .toEqual(OLDER_SERVER_COMPETITORS.map(row => ({ project: 'rotorwise', ...row })))
  })

  it('reads a competitor\'s aliases as none, with JSON equal to the server\'s row', async () => {
    const text = await invokeCli(['competitor', 'aliases', 'rotorwise', 'rival-one.example'])
    expect(text.exitCode, text.stderr).toBeUndefined()
    // Auto-detected and blocked names are newer fields too, read as none.
    expect(text.stdout).toBe([
      'Aliases for rival-one.example: (none)',
      'Auto-detected from stored answers: (none)',
      'Blocked from auto-detection: (none)',
    ].join('\n'))

    const json = await invokeCli(['competitor', 'aliases', 'rotorwise', 'rival-one.example', '--format', 'json'])
    expect(json.exitCode, json.stderr).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual(OLDER_SERVER_COMPETITORS[0])
  })

  it('--remove edits an empty list and reports the missing alias route as a user error', async () => {
    const result = await invokeCli(['competitor', 'aliases', 'rotorwise', 'rival-one.example', '--remove', 'Rival One', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'API_ERROR', message: 'HTTP 404: Not Found' })
    const write = requests.find(r => r.method === 'PUT')
    expect(write).toEqual({
      method: 'PUT',
      url: '/api/v1/projects/rotorwise/competitors/rival-one.example/aliases',
      body: JSON.stringify({ aliases: [] }),
    })
  })
})
