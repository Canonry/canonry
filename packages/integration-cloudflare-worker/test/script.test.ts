import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOT_LIST,
  generateWorkerScript,
  generateWranglerToml,
} from '../src/script.js'

const BASE_OPTS = {
  sourceId: 'src_abc123',
  ingestUrl: 'https://canonry.example.com/api/v1/projects/foo/traffic/cloudflare/ingest',
  bearerToken: 'tok_secret_value',
  hmacSecret: 'hmac_secret_value',
  workerVersion: '1.0.0',
  botList: DEFAULT_BOT_LIST,
}

describe('generateWorkerScript', () => {
  it('produces a non-empty JS string', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/addEventListener\s*\(\s*['"]fetch['"]/)
    expect(script.length).toBeGreaterThan(500)
  })

  it('embeds every required constant', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('src_abc123')
    expect(script).toContain('https://canonry.example.com/api/v1/projects/foo/traffic/cloudflare/ingest')
    expect(script).toContain('tok_secret_value')
    expect(script).toContain('hmac_secret_value')
    expect(script).toContain('1.0.0')
  })

  it('bakes in the bot UA keywords from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const keyword of DEFAULT_BOT_LIST.uaKeywords) {
      expect(script).toContain(keyword)
    }
  })

  it('bakes in the referer host suffixes from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const suffix of DEFAULT_BOT_LIST.refererHostSuffixes) {
      expect(script).toContain(suffix)
    }
  })

  it('records the bot list version somewhere the operator (or doctor) can read it', () => {
    const script = generateWorkerScript({
      ...BASE_OPTS,
      botList: { ...DEFAULT_BOT_LIST, version: '2099-12-31' },
    })
    expect(script).toContain('2099-12-31')
  })

  it('uses event.waitUntil so the forward fetch never blocks the response', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/event\.waitUntil/)
  })

  it('forwards with the documented headers (Authorization, Timestamp, Signature, Version)', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('Authorization')
    expect(script).toContain('Bearer')
    expect(script).toContain('X-Canonry-Timestamp')
    expect(script).toContain('X-Canonry-Signature')
    expect(script).toContain('X-Canonry-Worker-Version')
  })

  it('signs with HMAC-SHA256 via Web Crypto SubtleCrypto', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('HMAC')
    expect(script).toContain('SHA-256')
    expect(script).toMatch(/crypto\.subtle/)
  })

  it('uses POST as the forward method', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/method\s*:\s*['"]POST['"]/)
  })

  it('parses as JavaScript (smoke test)', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(() => new Function(script)).not.toThrow()
  })

  it('treats a custom botScoreMaxForward as the score threshold', () => {
    const script = generateWorkerScript({ ...BASE_OPTS, botScoreMaxForward: 42 })
    expect(script).toContain('42')
  })
})

describe('DEFAULT_BOT_LIST', () => {
  it('includes the canonical AI UA tokens', () => {
    expect(DEFAULT_BOT_LIST.uaKeywords).toEqual(
      expect.arrayContaining(['bot', 'crawler', 'gpt', 'claude', 'perplexity', 'openai', 'anthropic']),
    )
  })

  it('includes the canonical AI referer hosts', () => {
    expect(DEFAULT_BOT_LIST.refererHostSuffixes).toEqual(
      expect.arrayContaining(['.openai.com', '.anthropic.com', '.perplexity.ai']),
    )
  })

  it('has a non-empty, dated version string so the staleness check can compare', () => {
    expect(DEFAULT_BOT_LIST.version).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('generateWranglerToml', () => {
  it('emits a name and a main field for wrangler deploy', () => {
    const toml = generateWranglerToml({ sourceId: 'src_abc123' })
    expect(toml).toMatch(/^name\s*=\s*"canonry-traffic-src_abc123"/m)
    expect(toml).toMatch(/^main\s*=/m)
  })

  it('sets compatibility_date to a recent ISO date', () => {
    const toml = generateWranglerToml({ sourceId: 'src_abc123' })
    expect(toml).toMatch(/compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/)
  })
})
