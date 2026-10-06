import { describe, expect, it } from 'vitest'
import { answerProseForMentions, extractDomainsFromText } from '@ainyc/canonry-contracts'
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
    const answerText = 'Compare rates at rival.com first. ([enemy.com](https://enemy.com/rates?utm_source=chatgpt.com))'
    const ordinary = resolver.resolve({ answerText })
    const reused = resolver.resolve({
      answerText,
      answerDomains: extractDomainsFromText(answerProseForMentions(answerText)),
    })

    expect(ordinary).toEqual({ citedCompetitorDomains: [], mentionedCompetitorDomains: ['rival.com'] })
    expect(reused).toEqual(ordinary)
  })

  it('does not turn a citation chip in the answer text into a mention', () => {
    // OpenAI web search writes its sources into the answer as inline chips.
    // The competitor is cited there, not named.
    const answerText = 'Bayside Flats has the lowest pet fees in the area. ([rival.com](https://rival.com/pets?utm_source=chatgpt.com), [Enemy](https://enemy.com/pets?utm_source=chatgpt.com))'
    expect(resolver.resolve({ answerText, citedDomains: ['rival.com', 'enemy.com'] })).toEqual({
      citedCompetitorDomains: ['rival.com', 'enemy.com'],
      mentionedCompetitorDomains: [],
    })
    expect(resolver.resolve({ answerText: 'Read https://www.rival.com/review before deciding.' }).mentionedCompetitorDomains)
      .toEqual([])
  })

  it('recognizes an exact short domain without treating its generic label as identity', () => {
    const short = compileCompetitiveSignalResolver(['ai.com'])

    expect(short.resolve({ answerText: 'See ai.com for details.' }).mentionedCompetitorDomains)
      .toEqual(['ai.com'])
    expect(short.resolve({ answerText: 'AI tools are improving.' }).mentionedCompetitorDomains)
      .toEqual([])
  })

  it('marks a competitor mentioned by a curated alias its domain never contains', () => {
    const curated = compileCompetitiveSignalResolver([
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] },
      { domain: 'qvx.example', aliases: ['QVX'] },
      'ridgecrestbuildinc.example',
    ])

    expect(curated.resolve({ answerText: 'FoamSeal and QVX both quoted fast.' }).mentionedCompetitorDomains)
      .toEqual(['sealfoamworks.example', 'qvx.example'])
    // Mention never implies citation.
    expect(curated.resolve({ answerText: 'FoamSeal quoted fast.' }).citedCompetitorDomains).toEqual([])
    // Without the curated alias the 3-letter label stays below the domain floor.
    expect(compileCompetitiveSignalResolver(['qvx.example']).resolve({ answerText: 'QVX quoted fast.' }).mentionedCompetitorDomains)
      .toEqual([])
    // Exact brand identity: no substring hits.
    expect(curated.resolve({ answerText: 'Great qvxshop deals here.' }).mentionedCompetitorDomains).toEqual([])
  })

  it('ignores a stored alias below the alias floor', () => {
    const short = compileCompetitiveSignalResolver([{ domain: 'qvx.example', aliases: ['QV'] }])
    expect(short.resolve({ answerText: 'QV is short.' }).mentionedCompetitorDomains).toEqual([])
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
