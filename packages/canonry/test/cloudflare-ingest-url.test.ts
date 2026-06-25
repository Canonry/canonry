import { describe, expect, it } from 'vitest'
import { buildCloudflareIngestUrlTemplate } from '../src/cloudflare-ingest-url.js'

const SUFFIX = '/api/v1/projects/{name}/traffic/cloudflare/ingest'

describe('buildCloudflareIngestUrlTemplate', () => {
  it('appends the ingest path to apiUrl when no base path is configured', () => {
    expect(buildCloudflareIngestUrlTemplate({ apiUrl: 'http://localhost:4100' })).toBe(
      `http://localhost:4100${SUFFIX}`,
    )
  })

  it('does NOT double-prefix the base path (apiUrl already includes it)', () => {
    // loadConfig() folds basePath into apiUrl, so apiUrl is base-path-inclusive.
    // The template must keep a single `/canonry`, never `/canonry/canonry`.
    const url = buildCloudflareIngestUrlTemplate({ apiUrl: 'http://localhost:4100/canonry' })
    expect(url).toBe(`http://localhost:4100/canonry${SUFFIX}`)
    expect(url).not.toContain('/canonry/canonry')
  })

  it('prefers publicUrl over apiUrl when both are set', () => {
    expect(
      buildCloudflareIngestUrlTemplate({
        publicUrl: 'https://canonry.example.com/canonry',
        apiUrl: 'http://localhost:4100/canonry',
      }),
    ).toBe(`https://canonry.example.com/canonry${SUFFIX}`)
  })

  it('trims a trailing slash before appending the ingest path', () => {
    expect(buildCloudflareIngestUrlTemplate({ apiUrl: 'http://localhost:4100/canonry/' })).toBe(
      `http://localhost:4100/canonry${SUFFIX}`,
    )
  })

  it('keeps the {name} placeholder for per-project substitution', () => {
    expect(buildCloudflareIngestUrlTemplate({ apiUrl: 'http://localhost:4100' })).toContain(
      '/projects/{name}/traffic/cloudflare/ingest',
    )
  })
})
