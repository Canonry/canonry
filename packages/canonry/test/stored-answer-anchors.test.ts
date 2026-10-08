import { describe, expect, it } from 'vitest'
import { extractStoredAnswerAnchors } from '../src/stored-answer-anchors.js'

// The dispatcher detection uses to read a stored snapshot's citation
// structure: it unwraps the stored envelope (or a bare provider body from
// older rows) and hands it to the provider that owns that shape.

const SONAR_BODY = {
  choices: [{ message: { content: '- **TuneSpoke**: mobile tune-ups.[1]' } }],
  citations: ['https://spoketuneworks.example/'],
  search_results: [],
}

describe('extractStoredAnswerAnchors', () => {
  it('unwraps the stored envelope and dispatches by provider', () => {
    const envelope = JSON.stringify({ model: 'sonar', groundingSources: [], searchQueries: [], apiResponse: SONAR_BODY })
    expect(extractStoredAnswerAnchors('perplexity', envelope)).toEqual([
      { text: '- **TuneSpoke**: mobile tune-ups.', source: 'https://spoketuneworks.example/', kind: 'window', via: 'perplexity-marker' },
    ])
  })

  it('reads a bare provider body stored by an older build', () => {
    expect(extractStoredAnswerAnchors('perplexity', JSON.stringify(SONAR_BODY))).toHaveLength(1)
  })

  it('yields nothing for an unknown provider, a missing row body, or unreadable JSON', () => {
    const envelope = JSON.stringify({ apiResponse: SONAR_BODY })
    expect(extractStoredAnswerAnchors('muse', envelope)).toEqual([])
    expect(extractStoredAnswerAnchors('perplexity', null)).toEqual([])
    expect(extractStoredAnswerAnchors('perplexity', '{not json')).toEqual([])
    expect(extractStoredAnswerAnchors('openai', JSON.stringify({ apiResponse: { output: 'not-an-array' } }))).toEqual([])
  })
})
