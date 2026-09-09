import { describe, expect, it } from 'vitest'
import { compileCompetitiveSignalResolver } from '../src/competitive-signals.js'

describe('compileCompetitiveSignalResolver', () => {
  const resolver = compileCompetitiveSignalResolver(['rival.com', 'enemy.com'])

  it('keeps source citations and answer mentions independent', () => {
    expect(resolver.resolve({
      citedDomains: ['rival.com'],
      answerText: 'Enemy is the strongest alternative.',
    })).toEqual({
      citedCompetitorDomains: ['rival.com'],
      mentionedCompetitorDomains: ['enemy.com'],
    })
  })

  it('treats grounding-source hosts as citations and deduplicates source forms', () => {
    expect(resolver.resolve({
      citedDomains: ['www.rival.com'],
      groundingSources: [
        { uri: 'https://blog.rival.com/review' },
        { uri: 'https://unrelated.example/article' },
      ],
    }).citedCompetitorDomains).toEqual(['rival.com'])
  })

  it('does not turn a mention into a citation', () => {
    expect(resolver.resolve({ answerText: 'Rival is recommended.' })).toEqual({
      citedCompetitorDomains: [],
      mentionedCompetitorDomains: ['rival.com'],
    })
  })

  it('keeps supplied prose domains equivalent to ordinary extraction', () => {
    const answerText = 'Read https://www.rival.com/review before deciding.'
    const ordinary = resolver.resolve({ answerText })
    const reused = resolver.resolve({ answerText, answerDomains: ['www.rival.com'] })

    expect(reused).toEqual(ordinary)
  })

  it('recognizes an exact short domain without treating its generic label as identity', () => {
    const short = compileCompetitiveSignalResolver(['ai.com'])

    expect(short.resolve({ answerText: 'See ai.com for details.' }).mentionedCompetitorDomains)
      .toEqual(['ai.com'])
    expect(short.resolve({ answerText: 'AI tools are improving.' }).mentionedCompetitorDomains)
      .toEqual([])
  })

  it('normalizes and deduplicates configured competitor domains', () => {
    const duplicate = compileCompetitiveSignalResolver([
      'https://www.Rival.com/path',
      'rival.com',
    ])

    expect(duplicate.resolve({ citedDomains: ['shop.rival.com'] }).citedCompetitorDomains)
      .toEqual(['rival.com'])
  })
})
