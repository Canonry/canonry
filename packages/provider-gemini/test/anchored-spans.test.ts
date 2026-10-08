import { describe, expect, it } from 'vitest'
import { extractAnchoredSpans } from '../src/index.js'

// Gemini ties `segment.text` to grounding chunks. The chunk URI is an opaque
// redirect that is never resolved; the title holds the site. Fictional
// response with the stored shape.

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC'

describe('extractAnchoredSpans (Gemini)', () => {
  it('pairs each support segment with every distinct site its chunks name', () => {
    // The first support follows a multibyte character, so its byte offsets
    // differ from character offsets; the segment text is used, never the offsets.
    const text = 'Caf\u00e9 riders say:\n* **TuneSpoke:** mobile tune-ups\n* **Rim Doctor:** truing'
    const response = {
      candidates: [{
        content: { parts: [{ text }] },
        groundingMetadata: {
          webSearchQueries: ['bike tune-ups'],
          groundingChunks: [
            { web: { uri: REDIRECT, title: 'spoketuneworks.example' } },
            { web: { uri: REDIRECT, title: 'reviews.example' } },
            { web: { uri: 'https://rimdoctor.example/truing', title: 'Rim Doctor | Truing' } },
            { web: { uri: REDIRECT, title: 'Not a domain' } },
          ],
          groundingSupports: [
            { segment: { startIndex: 18, endIndex: 50, text: '* **TuneSpoke:** mobile tune-ups' }, groundingChunkIndices: [0, 1, 0] },
            { segment: { endIndex: 23, text: '* **Rim Doctor:** truing' }, groundingChunkIndices: [2, 3, 9] },
          ],
        },
      }],
    }
    expect(extractAnchoredSpans(response)).toEqual([
      { text: '* **TuneSpoke:** mobile tune-ups', source: 'spoketuneworks.example', kind: 'window', via: 'gemini-support' },
      { text: '* **TuneSpoke:** mobile tune-ups', source: 'reviews.example', kind: 'window', via: 'gemini-support' },
      { text: '* **Rim Doctor:** truing', source: 'https://rimdoctor.example/truing', kind: 'window', via: 'gemini-support' },
    ])
  })

  it('yields nothing for rows stored before grounding supports existed', () => {
    expect(extractAnchoredSpans({
      candidates: [{ content: { parts: [{ text: 'x' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: REDIRECT, title: 'qvx.example' } }] } }],
    })).toEqual([])
    expect(extractAnchoredSpans({})).toEqual([])
  })
})
