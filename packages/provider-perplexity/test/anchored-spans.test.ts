import { describe, expect, it } from 'vitest'
import { extractAnchoredSpans } from '../src/index.js'

// `[N]` markers cite the text before them on the same line. Agent responses
// resolve N to the search result with that id; Sonar history resolves it to
// `citations[N - 1]`. Fictional responses with the stored shapes.

const TEXT = 'Shops:\n- **TuneSpoke**: mobile tune-ups.[1][3] Also **Rim Doctor** for wheels.[2]\n- QVX stocks parts [9]'

describe('extractAnchoredSpans (Perplexity)', () => {
  it('maps Agent markers to result ids, which run on across search_results items', () => {
    const response = {
      output: [
        { type: 'search_results', queries: ['bike tune-ups'], results: [
          { id: 1, url: 'https://spoketuneworks.example/', title: 't', snippet: 's', source: 'web' },
          { id: 2, url: 'https://rimdoctor.example/', title: 't', snippet: 's', source: 'web' },
        ] },
        { type: 'search_results', queries: ['bike parts'], results: [
          { id: 3, url: 'https://reviews.example/tunespoke', title: 't', snippet: 's', source: 'web' },
        ] },
        { type: 'message', content: [{ type: 'output_text', text: TEXT, annotations: [] }] },
      ],
    }
    expect(extractAnchoredSpans(response)).toEqual([
      { text: '- **TuneSpoke**: mobile tune-ups.', source: 'https://spoketuneworks.example/', kind: 'window', via: 'perplexity-marker' },
      { text: '- **TuneSpoke**: mobile tune-ups.', source: 'https://reviews.example/tunespoke', kind: 'window', via: 'perplexity-marker' },
      { text: ' Also **Rim Doctor** for wheels.', source: 'https://rimdoctor.example/', kind: 'window', via: 'perplexity-marker' },
    ])
  })

  it('maps Sonar markers to citations[N - 1], wrapped as the job runner stores it', () => {
    const stored = {
      apiResponse: {
        choices: [{ message: { content: TEXT } }],
        citations: ['https://spoketuneworks.example/', 'https://rimdoctor.example/', 'https://reviews.example/tunespoke'],
        search_results: [],
      },
    }
    expect(extractAnchoredSpans(stored).map(span => span.source)).toEqual([
      'https://spoketuneworks.example/',
      'https://reviews.example/tunespoke',
      'https://rimdoctor.example/',
    ])
  })

  it('yields nothing without markers', () => {
    expect(extractAnchoredSpans({ choices: [{ message: { content: 'No markers.' } }], citations: ['https://qvx.example/'] })).toEqual([])
  })
})
