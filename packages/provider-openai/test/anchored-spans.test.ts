import { describe, expect, it } from 'vitest'
import { extractAnchoredSpans } from '../src/index.js'

// A `url_citation` span is the citation chip itself; the name it cites sits
// before it on the same line. Fictional response with the stored shape.

function annotated(text: string, chips: { chip: string; url: string }[]) {
  const annotations = chips.map(({ chip, url }) => {
    const start = text.indexOf(chip)
    return { type: 'url_citation', start_index: start, end_index: start + chip.length, url, title: 'Fictional page' }
  })
  return {
    output: [
      { type: 'web_search_call', action: { type: 'search', query: 'bike tune-ups' } },
      { type: 'message', content: [{ type: 'output_text', text, annotations, logprobs: [] }] },
    ],
  }
}

describe('extractAnchoredSpans (OpenAI)', () => {
  it('reads the text before each chip, from the line start or the previous chip', () => {
    const tuneChip = ' ([spoketuneworks.example](https://spoketuneworks.example/?utm_source=openai))'
    const rimChip = ' ([rimdoctor.example](https://rimdoctor.example/truing?utm_source=openai))'
    const text = `Top shops:\n- **TuneSpoke** - mobile tune-ups${tuneChip}; **Rim Doctor** for wheels${rimChip}.\n`
    expect(extractAnchoredSpans(annotated(text, [
      { chip: rimChip, url: 'https://rimdoctor.example/truing?utm_source=openai' },
      { chip: tuneChip, url: 'https://spoketuneworks.example/?utm_source=openai' },
    ]))).toEqual([
      { text: '- **TuneSpoke** - mobile tune-ups', source: 'https://spoketuneworks.example/?utm_source=openai', kind: 'window', via: 'openai-annotation' },
      { text: '; **Rim Doctor** for wheels', source: 'https://rimdoctor.example/truing?utm_source=openai', kind: 'window', via: 'openai-annotation' },
    ])
  })

  it('slices by UTF-16 offsets, so text after an emoji stays aligned', () => {
    const chip = ' ([qvx.example](https://qvx.example/))'
    const text = `\u{1F6B2} **QVX** stocks parts${chip}`
    expect(extractAnchoredSpans(annotated(text, [{ chip, url: 'https://qvx.example/' }]))[0]!.text).toBe('\u{1F6B2} **QVX** stocks parts')
  })

  it('yields nothing for answers without annotations or with malformed ones', () => {
    expect(extractAnchoredSpans(annotated('No citations here.', []))).toEqual([])
    expect(extractAnchoredSpans({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', start_index: 5, end_index: 99, url: 'https://qvx.example/' }] }] }] })).toEqual([])
    expect(extractAnchoredSpans({})).toEqual([])
  })
})
