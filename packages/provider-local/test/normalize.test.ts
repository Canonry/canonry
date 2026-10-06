import { describe, it, expect } from 'vitest'
import { normalizeResult } from '../src/normalize.js'
import type { LocalRawResult } from '../src/types.js'

describe('normalizeResult', () => {
  it.each([
    'The domain is canonry.io',
    'Check out example.com and https://test.org',
  ])('does not fabricate citations from answer prose: %s', (answerText) => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: {
        choices: [
          {
            message: {
              content: answerText
            }
          }
        ]
      },
      groundingSources: [],
      searchQueries: []
    }
    const normalized = normalizeResult(raw)
    expect(normalized.answerText).toBe(answerText)
    expect(normalized.citedDomains).toEqual([])
    expect(normalized.groundingSources).toEqual([])
  })

  it('derives cited domains only from structured grounding sources', () => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: { choices: [{ message: { content: 'See the sources.' } }] },
      groundingSources: [
        { uri: 'https://www.example.com/article', title: 'Example' },
        { uri: 'https://docs.example.com/guide', title: 'Guide' },
      ],
      searchQueries: [],
    }
    const normalized = normalizeResult(raw)
    expect(normalized.citedDomains).toEqual(['example.com', 'docs.example.com'])
    expect(normalized.groundingSources).toEqual(raw.groundingSources)
  })
})
