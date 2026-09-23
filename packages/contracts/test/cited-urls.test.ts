import { expect, test } from 'vitest'
import {
  CITED_URL_CAPTURE_VERSION,
  deriveCitedUrlCandidates,
  filterCapturedCitedUrls,
} from '../src/index.js'

test('pre-resolution candidates retain direct full-path URLs and the exact Vertex proxy only', () => {
  const candidates = deriveCitedUrlCandidates([
    { uri: 'https://publisher.example/guides/claude?tab=ts#sources', title: 'Claude-cited publisher URL' },
    { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'Vertex wrapper' },
    { uri: 'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/abc', title: 'Lookalike' },
    { uri: 'ftp://example.com/file', title: 'Wrong scheme' },
    { uri: 'mailto:hello@example.com', title: 'Not HTTP' },
    { uri: 'https://api.openai.com/v1/responses', title: 'Provider infrastructure' },
    { uri: 'https://docs.anthropic.com/en/docs/build-with-claude', title: 'Provider infrastructure' },
    { uri: 'https://claude.ai/new', title: 'Engine self URL' },
    { uri: 'https://www.perplexity.ai/search?q=canonry', title: 'Engine self URL' },
    { uri: 'https://www.meta.ai/search?q=canonry', title: 'Muse surface, a source for every other provider' },
    { uri: 'not a URL', title: 'Invalid' },
  ])

  expect(candidates).toEqual([
    'https://publisher.example/guides/claude?tab=ts',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
    'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/abc',
    'https://www.meta.ai/search?q=canonry',
  ])
})

test('post-resolution filtering removes remaining infrastructure, strips fragments, and dedupes full URLs', () => {
  expect(filterCapturedCitedUrls([
    'https://example.com/a?x=1#first',
    'https://example.com/a?x=1#second',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
    'https://api.openai.com/v1/responses',
    'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/abc',
  ])).toEqual([
    'https://example.com/a?x=1',
    'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/abc',
  ])
  expect(CITED_URL_CAPTURE_VERSION).toBe(1)
})
