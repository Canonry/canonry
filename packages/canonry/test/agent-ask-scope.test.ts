import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { agentAsk } from '../src/commands/agent-ask.js'
import { AeroToolProfiles, AeroToolScopes, type AeroToolProfile, type AeroToolScope } from '../src/agent/tools.js'

/**
 * The dashboard AeroBar can run in `read-only` mode; the CLI defaults to
 * `all` so terminal-initiated turns remain write-capable. When the dashboard
 * copies a turn via "Copy as CLI" it emits `--scope read-only`, which must
 * propagate through `agentAsk` into the POST body. Without this, a
 * read-only UI turn silently becomes write-capable when replayed via CLI.
 */
describe('agent ask scope parity', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `canonry-agent-scope-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const config = {
      apiUrl: 'http://127.0.0.1:9',
      database: path.join(tmpDir, 'data.db'),
      apiKey: 'cnry_test',
      providers: {},
      basePath: '',
    }
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')

    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function captureBody(opts: { scope?: AeroToolScope; profile?: AeroToolProfile }): Promise<string> {
    let captured = ''
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/v1/projects/demo/agent/prompt')) {
        captured = String(init?.body ?? '')
        // Return a trivially-closed SSE stream so the command exits cleanly.
        return new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof globalThis.fetch

    await agentAsk({ project: 'demo', prompt: 'hi', scope: opts.scope, profile: opts.profile })
    return captured
  }

  it('omitted scope defaults to "all" so CLI turns keep write capability', async () => {
    const body = await captureBody({})
    expect(JSON.parse(body)).toMatchObject({ scope: AeroToolScopes.all })
  })

  it('--scope read-only is forwarded to the server', async () => {
    const body = await captureBody({ scope: AeroToolScopes.readOnly })
    expect(JSON.parse(body)).toMatchObject({ scope: AeroToolScopes.readOnly })
  })

  it('--scope all is forwarded to the server', async () => {
    const body = await captureBody({ scope: AeroToolScopes.all })
    expect(JSON.parse(body)).toMatchObject({ scope: AeroToolScopes.all })
  })

  it('--profile ads-operator is forwarded to the server', async () => {
    const body = await captureBody({ profile: AeroToolProfiles.adsOperator })
    expect(JSON.parse(body)).toMatchObject({ scope: AeroToolScopes.all, profile: AeroToolProfiles.adsOperator })
  })

  it('omitted profile stays omitted so the server default remains authoritative', async () => {
    const body = await captureBody({})
    expect(JSON.parse(body)).not.toHaveProperty('profile')
  })
})
