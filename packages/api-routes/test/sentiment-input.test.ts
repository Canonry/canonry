import { describe, expect, it } from 'vitest'
import { sentimentSentenceSpans } from '../src/sentiment-input.js'

function texts(text: string): string[] {
  const spans = sentimentSentenceSpans(text)
  let previousEnd = 0
  for (const [index, span] of spans.entries()) {
    // Every span is a verbatim slice, in order, and only whitespace falls between spans.
    expect(span).toMatchObject({ id: `s${index + 1}`, text: text.slice(span.start, span.end) })
    expect(text.slice(previousEnd, span.start).trim()).toBe('')
    previousEnd = span.end
  }
  expect(text.slice(previousEnd).trim()).toBe('')
  return spans.map(span => span.text)
}

describe('sentiment sentence spans', () => {
  it('does not split after common abbreviations', () => {
    expect(texts('Dr. Patel runs North Clinic. It is well reviewed.')).toEqual(['Dr. Patel runs North Clinic.', 'It is well reviewed.'])
    expect(texts('Try St. Mary Roofing, e.g. for flat roofs. Crews are fast.')).toEqual(['Try St. Mary Roofing, e.g. for flat roofs.', 'Crews are fast.'])
    expect(texts('Acme vs. Beta: Acme wins. It is the top U.S. Roofer. Prices are fair.')).toEqual(['Acme vs. Beta: Acme wins.', 'It is the top U.S. Roofer.', 'Prices are fair.'])
    expect(texts('(Dr. Smith) said so. "J. Doe" agreed. As of Sept. 2025 prices rose. It was approx. 30 units.')).toEqual(['(Dr. Smith) said so.', '"J. Doe" agreed.', 'As of Sept. 2025 prices rose.', 'It was approx. 30 units.'])
    expect(texts('Acme Inc. offers free quotes. Call today.')).toEqual(['Acme Inc. offers free quotes.', 'Call today.'])
  })
  it('keeps a single-token list marker with its item', () => {
    expect(texts('1. Acme Roofing is reliable.\n2. Beta Roofing is slow.\niv. Gamma is new.')).toEqual(['1. Acme Roofing is reliable.', '2. Beta Roofing is slow.', 'iv. Gamma is new.'])
  })
  it('still ends sentences at numbers, one-word sentences, other terminators and newlines', () => {
    expect(texts('Acme is rated 4. Beta is rated 5.')).toEqual(['Acme is rated 4.', 'Beta is rated 5.'])
    expect(texts('No. 1 pick is Acme. No. Beta is not.')).toEqual(['No. 1 pick is Acme.', 'No.', 'Beta is not.'])
    expect(texts('North Hall is a great place to live. Parking is expensive! Is it worth it? Yes.')).toEqual(['North Hall is a great place to live.', 'Parking is expensive!', 'Is it worth it?', 'Yes.'])
    expect(texts('Contact Dr.\nPatel is great.\n\n- Mild. Vivid.')).toEqual(['Contact Dr.', 'Patel is great.', '- Mild.', 'Vivid.'])
  })
})
