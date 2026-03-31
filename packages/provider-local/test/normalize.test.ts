import { describe, it, expect } from 'vitest'
import { extractDomainMentions, normalizeResult } from '../src/normalize.js'
import type { LocalRawResult } from '../src/types.js'

describe('normalizeResult', () => {
  it('extracts domain mentions from answer text', () => {
    const text = 'Check out example.com and https://another-site.org/path. Also sub.domain.co.uk.'
    const domains = extractDomainMentions(text)
    expect(domains).toContain('example.com')
    expect(domains).toContain('another-site.org')
    expect(domains).toContain('sub.domain.co.uk')
    expect(domains).not.toContain('www.example.com')
  })

  it('normalizes a full local result', () => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: {
        choices: [
          {
            message: {
              content: 'The domain is canonry.io'
            }
          }
        ]
      },
      groundingSources: [],
      searchQueries: []
    }
    const normalized = normalizeResult(raw)
    expect(normalized.answerText).toBe('The domain is canonry.io')
    expect(normalized.citedDomains).toContain('canonry.io')
  })
})
