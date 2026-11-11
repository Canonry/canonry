import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeSourcePayload,
  manifestNeedsUpdate,
  runRefresh,
  SOURCES,
} from '../scripts/refresh-ip-ranges.js'
import type { FetchResult, Source } from '../scripts/refresh-ip-ranges.js'
import { validateIpRangeManifestPayload } from '../src/ip-range-manifest.js'

const rangesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ip-ranges')

describe('refresh-ip-ranges', () => {
  it('returns a failing exit code after retaining successful source results', async () => {
    const sources: Source[] = [
      { file: 'fresh.json', url: 'https://example.test/fresh.json', label: 'Fresh' },
      { file: 'stale.json', url: 'https://example.test/stale.json', label: 'Stale' },
    ]
    const completed: string[] = []
    const refresh = vi.fn(async (source: Source): Promise<FetchResult> => {
      completed.push(source.file)
      return source.file === 'fresh.json'
        ? { source, ok: true, prefixCount: 2 }
        : { source, ok: false, error: 'HTTP 503' }
    })
    const output: string[] = []

    const exitCode = await runRefresh(sources, refresh, message => output.push(message))

    expect(exitCode).toBe(1)
    expect(completed).toEqual(['fresh.json', 'stale.json'])
    expect(output.join('')).toContain('fresh.json  (2 prefixes)')
    expect(output.join('')).toContain('stale.json  HTTP 503')
    expect(output.join('')).toContain('Done. 1 updated, 0 unchanged, 1 failed.')
    expect(output.join('')).toContain('Failed sources kept their previous JSON')
  })

  it('returns success only when every source refresh succeeds', async () => {
    const source: Source = {
      file: 'fresh.json',
      url: 'https://example.test/fresh.json',
      label: 'Fresh',
    }

    await expect(runRefresh(
      [source],
      async () => ({ source, ok: true, prefixCount: 1 }),
      () => undefined,
    )).resolves.toBe(0)
  })

  it('reports a successful metadata-only refresh as unchanged', async () => {
    const source: Source = {
      file: 'same.json',
      url: 'https://example.test/same.json',
      label: 'Same',
    }
    const output: string[] = []

    await expect(runRefresh(
      [source],
      async () => ({ source, ok: true, prefixCount: 1, changed: false }),
      message => output.push(message),
    )).resolves.toBe(0)

    expect(output.join('')).toContain('same.json  (1 prefixes, unchanged)')
    expect(output.join('')).toContain('Done. 0 updated, 1 unchanged, 0 failed.')
  })
})

describe('publisher payload normalization', () => {
  it('normalizes Amazon embedded JSON, legacy fields, and bare host addresses', () => {
    const source: Source = {
      file: 'amazon.json',
      url: 'https://developer.amazon.com/example',
      label: 'Amazon',
      format: 'amazon-html',
    }
    const body = `<html><pre><code class="container">${JSON.stringify({
      creationTime: 'version-1',
      prefixes: [
        { ipv4Prefix: '192.0.2.10' },
        { ip_prefix: '198.51.100.0/24' },
        { ipv6Prefix: '2001:db8::1' },
      ],
    })}</code></pre></html>`

    expect(decodeSourcePayload(source, body)).toEqual({
      creationTime: 'version-1',
      prefixes: [
        { ipv4Prefix: '192.0.2.10/32' },
        { ipv4Prefix: '198.51.100.0/24' },
        { ipv6Prefix: '2001:db8::1/128' },
      ],
    })
  })

  const sailSource: Source = {
    file: 'claude-agent.json',
    url: 'https://example.test/.well-known/sail',
    label: 'SAIL',
    format: 'sail-toml',
    sailService: 'Claude-Agent',
  }
  // The shape Anthropic publishes at https://claude.com/.well-known/sail, plus
  // a second service and prefix set the decoder must leave out. The reader
  // rejects documentation ranges (they are not globally reachable), so these
  // are ordinary public cloud addresses.
  const sailBody = `schema        = "draft-kelley-webbotauth-sail-00"
modified      = 2026-10-22T18:36:00Z
expires_after = 3600  # seconds

[[prefix_sets]]
name          = "agentic-browser-use"
# \`exclusive=true\` means that all traffic from these ranges will be documented in this file.
exclusive     = true
ipv4_prefixes = [
  "34.120.0.10",
  "35.190.0.0/24", # a range, kept as published
]
ipv6_prefixes = ["2600:1900:4000::1"]

[[prefix_sets]]
name          = "other-service"
ipv4_prefixes = ["34.120.9.9"]
ipv6_prefixes = []

[[services]]
name        = "Claude-Agent"
exhaustive  = true
prefix_sets = ["agentic-browser-use"]

[[services]]
name        = "Other"
prefix_sets = ["other-service"]
`

  it('reads the prefix sets one SAIL service lists, normalizing host addresses', () => {
    expect(decodeSourcePayload(sailSource, sailBody)).toEqual({
      creationTime: '2026-10-22T18:36:00Z',
      prefixes: [
        { ipv4Prefix: '34.120.0.10/32' },
        { ipv4Prefix: '35.190.0.0/24' },
        { ipv6Prefix: '2600:1900:4000::1/128' },
      ],
    })
  })

  it('reads a service\'s own prefixes, matches names without case, and allows tabs in strings', () => {
    // Draft-00: prefixes listed on a service act as an anonymous prefix set,
    // and identifiers compare ASCII-case-insensitively. TOML allows a raw tab
    // inside a basic string.
    const body = sailBody
      .replace('name        = "Claude-Agent"', 'name        = "claude-agent"\nipv4_prefixes = ["34.121.0.1", "34.120.0.10"]')
      .replace('prefix_sets = ["agentic-browser-use"]', 'prefix_sets = ["Agentic-Browser-Use"]')
      .replace('expires_after', 'note          = "tab\there"\nexpires_after')
    expect(decodeSourcePayload(sailSource, body)).toEqual({
      creationTime: '2026-10-22T18:36:00Z',
      prefixes: [
        { ipv4Prefix: '34.121.0.1/32' },
        { ipv4Prefix: '34.120.0.10/32' },
        { ipv4Prefix: '35.190.0.0/24' },
        { ipv6Prefix: '2600:1900:4000::1/128' },
      ],
    })
    const direct = sailBody.replace('prefix_sets = ["agentic-browser-use"]', 'ipv6_prefixes = ["2600:1900:4000::/48"]')
    expect(decodeSourcePayload(sailSource, direct)).toEqual({
      creationTime: '2026-10-22T18:36:00Z',
      prefixes: [{ ipv6Prefix: '2600:1900:4000::/48' }],
    })
  })

  it.each([
    ['a newer SAIL draft', sailBody.replace('sail-00', 'sail-01'), /SAIL schema draft-kelley-webbotauth-sail-01 is not/],
    ['a missing service', sailBody.replace('"Claude-Agent"', '"Someone-Else"'), /lists service Claude-Agent 0 times/],
    ['a missing prefix set', sailBody.replace('["agentic-browser-use"]', '["missing"]'), /prefix set missing appears 0 times/],
    ['a dangling reference in another service', sailBody.replace('["other-service"]', '["nowhere"]'), /prefix set nowhere appears 0 times/],
    ['a file with no expiry', sailBody.replace('expires_after = 3600  # seconds\n', ''), /no expires or expires_after/],
    ['a prefix covering private space', sailBody.replace('"35.190.0.0/24"', '"0.0.0.0/0"'), /not globally reachable/],
    ['a documentation prefix', sailBody.replace('"2600:1900:4000::1"', '"2001:db8::1"'), /not globally reachable/],
    ['a carve-out by another service', sailBody.replace('["34.120.9.9"]', '["35.190.0.7"]'), /carve-outs are not supported/],
    ['an IPv6 address among IPv4 prefixes', sailBody.replace('"34.120.0.10"', '"2600:1900:4000::2"'), /is not IPv4/],
    ['a padded prefix', sailBody.replace('"34.120.0.10"', '" 34.120.0.10"'), /is not a valid IP prefix/],
    ['an escape TOML does not define', sailBody.replace('expires_after', 'note          = "a\\/b"\nexpires_after'), /unsupported string/],
    ['a plain table', sailBody.replace('[[services]]\nname        = "Other"', '[meta]\nname        = "Other"'), /unsupported syntax/],
    ['an unclosed array', `${sailBody}extra = [\n  "34.120.0.99",\n`, /array extra is never closed/],
  ])('fails the refresh on %s rather than guessing', (_case, body, error) => {
    expect(() => decodeSourcePayload(sailSource, body)).toThrow(error)
  })

  it('ignores version and ordering churn when executable prefixes are unchanged', () => {
    const source: Source = {
      file: 'same.json',
      url: 'https://example.test/same.json',
      label: 'Same',
    }
    const current = {
      _source: source.url,
      creationTime: 'old-version',
      prefixes: [
        { ipv4Prefix: '192.0.2.99/24' },
        { ipv6Prefix: '2001:DB8::1/32' },
      ],
    }
    const equivalent = {
      creationTime: 'new-version',
      prefixes: [
        { ipv6Prefix: '2001:db8::/32' } as const,
        { ipv4Prefix: '192.0.2.0/24' } as const,
      ],
    }

    expect(manifestNeedsUpdate(source, current, equivalent)).toBe(false)
    expect(manifestNeedsUpdate({ ...source, url: 'https://example.test/new.json' }, current, equivalent))
      .toBe(true)
    expect(manifestNeedsUpdate(source, current, {
      creationTime: 'new-version',
      prefixes: [{ ipv4Prefix: '203.0.113.0/24' }],
    })).toBe(true)
  })
})

describe('publisher source catalog', () => {
  it('has unique URLs/files backed by valid non-empty vendored manifests', () => {
    expect(new Set(SOURCES.map(source => source.file)).size).toBe(SOURCES.length)
    expect(new Set(SOURCES.map(source => source.url)).size).toBe(SOURCES.length)

    for (const source of SOURCES) {
      const raw = JSON.parse(fs.readFileSync(path.join(rangesDirectory, source.file), 'utf-8')) as unknown
      expect(raw).toMatchObject({ _source: source.url })
      const validation = validateIpRangeManifestPayload(raw)
      expect(validation, source.file).toMatchObject({ ok: true })
      if (validation.ok) expect(validation.value.prefixes.length, source.file).toBeGreaterThan(0)
    }
  })
})
