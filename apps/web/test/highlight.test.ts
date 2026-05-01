import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'

import { highlightTermsInText } from '../src/lib/highlight.js'

interface MarkProps {
  className: string
  children: unknown
}

function findMarks(nodes: ReturnType<typeof highlightTermsInText>): MarkProps[] {
  const marks: MarkProps[] = []
  for (const node of nodes) {
    if (node && typeof node === 'object' && 'type' in node) {
      const el = node as ReactElement<MarkProps>
      if (el.type === 'mark') marks.push(el.props)
    }
  }
  return marks
}

describe('highlightTermsInText separator-tolerant matching', () => {
  it('highlights "Demand IQ" in prose when the term is the slug "demand-iq"', () => {
    const nodes = highlightTermsInText(
      'Demand IQ uses AI-driven instant estimates to attract homeowners.',
      [{ terms: ['demand-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Demand IQ')
    expect(marks[0].className).toBe('answer-highlight-brand')
  })

  it('highlights "Demand-IQ" hyphen form when the term is the slug', () => {
    const nodes = highlightTermsInText(
      'See the Demand-IQ pricing page.',
      [{ terms: ['demand-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Demand-IQ')
  })

  it('highlights "DemandIQ" concatenated form', () => {
    const nodes = highlightTermsInText(
      'Visit DemandIQ for details.',
      [{ terms: ['demand-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('DemandIQ')
  })

  it('highlights every separator variant given a spaced display name', () => {
    const nodes = highlightTermsInText(
      'AZ Coatings, AZ-Coatings, and AZCoatings are all the same brand.',
      [{ terms: ['AZ Coatings'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks.map(m => m.children)).toEqual(['AZ Coatings', 'AZ-Coatings', 'AZCoatings'])
  })

  it('still matches a single-word term against itself', () => {
    const nodes = highlightTermsInText(
      'Roofle ships install quote engines.',
      [{ terms: ['Roofle'], className: 'answer-highlight-competitor' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Roofle')
    expect(marks[0].className).toBe('answer-highlight-competitor')
  })

  it('keeps domain literal matches intact (does not allow separator drift inside dots)', () => {
    // `acme.com` should match the literal domain in prose; it should NOT
    // match the phrase "acme com" (separators don't substitute for the dot).
    const nodes = highlightTermsInText(
      'Visit acme.com for pricing. Acme com is unrelated.',
      [{ terms: ['acme.com'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('acme.com')
  })

  it('routes the matched span back to the right group via brand-key', () => {
    const nodes = highlightTermsInText(
      'Demand IQ partners with Roofle.',
      [
        { terms: ['demand-iq'], className: 'answer-highlight-brand' },
        { terms: ['roofle'], className: 'answer-highlight-competitor' },
      ],
    )
    const marks = findMarks(nodes)
    const byText = Object.fromEntries(marks.map(m => [m.children, m.className]))
    expect(byText['Demand IQ']).toBe('answer-highlight-brand')
    expect(byText['Roofle']).toBe('answer-highlight-competitor')
  })
})
