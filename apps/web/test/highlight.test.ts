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
  it('highlights "Widget IQ" in prose when the term is the slug "widget-iq"', () => {
    const nodes = highlightTermsInText(
      'Widget IQ builds instant quotes for small shops.',
      [{ terms: ['widget-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Widget IQ')
    expect(marks[0].className).toBe('answer-highlight-brand')
  })

  it('highlights "Widget-IQ" hyphen form when the term is the slug', () => {
    const nodes = highlightTermsInText(
      'See the Widget-IQ pricing page.',
      [{ terms: ['widget-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Widget-IQ')
  })

  it('highlights "WidgetIQ" concatenated form', () => {
    const nodes = highlightTermsInText(
      'Visit WidgetIQ for details.',
      [{ terms: ['widget-iq'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('WidgetIQ')
  })

  it('highlights every separator variant given a spaced display name', () => {
    const nodes = highlightTermsInText(
      'Blue Kettle, Blue-Kettle, and BlueKettle are all the same brand.',
      [{ terms: ['Blue Kettle'], className: 'answer-highlight-brand' }],
    )
    const marks = findMarks(nodes)
    expect(marks.map(m => m.children)).toEqual(['Blue Kettle', 'Blue-Kettle', 'BlueKettle'])
  })

  it('still matches a single-word term against itself', () => {
    const nodes = highlightTermsInText(
      'Harborline ships quote widgets.',
      [{ terms: ['Harborline'], className: 'answer-highlight-competitor' }],
    )
    const marks = findMarks(nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0].children).toBe('Harborline')
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
      'Widget IQ partners with Harborline.',
      [
        { terms: ['widget-iq'], className: 'answer-highlight-brand' },
        { terms: ['harborline'], className: 'answer-highlight-competitor' },
      ],
    )
    const marks = findMarks(nodes)
    const byText = Object.fromEntries(marks.map(m => [m.children, m.className]))
    expect(byText['Widget IQ']).toBe('answer-highlight-brand')
    expect(byText['Harborline']).toBe('answer-highlight-competitor')
  })
})
