import { describe, expect, it } from 'vitest'
import { buildCompetitorSuggestions } from '../src/competitor-suggestions.js'

const project = {
  domain: 'subject.example',
  label: 'Subject',
  domains: ['subject.example'],
}

function answer(id: string, runId: string, text: string, citedDomains: string[], createdAt = '2026-01-01T00:00:00.000Z') {
  return { id, runId, createdAt, answerText: text, citedDomains, citedUrls: null, recommendedCompetitors: [] }
}

describe('buildCompetitorSuggestions', () => {
  it('joins named answer text to same-answer sources and counts answers exactly', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 3,
      answers: [
        answer('a1', 'run-1', 'Northstar is a useful choice.', ['northstar.example']),
        answer('a2', 'run-1', 'Northstar is a useful choice.', ['northstar.example']),
        answer('a3', 'run-2', 'Northstar is a useful choice.', ['northstar.example']),
        answer('a4', 'run-2', 'A source list only.', ['northstar.example', 'unrelated.example']),
      ],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })

    const northstar = result.candidates.find(candidate => candidate.domain === 'northstar.example')
    expect(northstar).toMatchObject({
      namingAnswers: 3,
      citingAnswers: 4,
      bothAnswers: 3,
      pairedAnswers: 3,
      status: 'suggested',
      tracked: false,
    })
    expect(northstar?.names).toEqual([{ name: 'Northstar', answerCount: 3, pairedAnswers: 3 }])
    expect(result.candidates.find(candidate => candidate.domain === 'unrelated.example')).toMatchObject({
      status: 'excluded',
      reason: 'not-named',
    })
    expect(result.unresolvedNames).toEqual([])
  })

  it('does not treat a citation alone as a competitor and reports unresolved names', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [
        { ...answer('a1', 'run-1', 'A business called North Star is recommended.', ['unrelated.example']), recommendedCompetitors: ['North Star'] },
      ],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ domain: 'unrelated.example', status: 'excluded', reason: 'not-named' })
    expect(result.unresolvedNames).toEqual([{ name: 'North Star', answerCount: 1 }])
  })

  it('keeps an anchored alias on the cited domain for operator review', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a1', 'run-1', 'A provider recommends [Blue Harbor](https://rival.example/home).', ['rival.example'])],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(result.candidates[0]).toMatchObject({
      domain: 'rival.example', namingAnswers: 0, pairedAnswers: 1,
      namedByOtherNameAnswers: 1,
      names: [{ name: 'Blue Harbor', answerCount: 1, pairedAnswers: 1 }],
    })
    expect(result.unresolvedNames).toEqual([])
  })

  it('keeps anchored names on their own domains and leaves unrelated names unresolved', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer(
        'a1',
        'run-1',
        'Try [Blue Harbor](https://blue.example/) or [Red Peak](https://red.example/).',
        ['blue.example', 'red.example'],
      )],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(result.candidates.find(candidate => candidate.domain === 'blue.example')?.names).toEqual(expect.arrayContaining([
      { name: 'Blue Harbor', answerCount: 1, pairedAnswers: 1 },
    ]))
    expect(result.candidates.find(candidate => candidate.domain === 'blue.example')?.names).not.toEqual(expect.arrayContaining([
      { name: 'Red Peak', answerCount: 1, pairedAnswers: 1 },
    ]))
    expect(result.candidates.find(candidate => candidate.domain === 'red.example')?.names).toEqual(expect.arrayContaining([
      { name: 'Red Peak', answerCount: 1, pairedAnswers: 1 },
    ]))
    expect(result.candidates.find(candidate => candidate.domain === 'red.example')?.names).not.toEqual(expect.arrayContaining([
      { name: 'Blue Harbor', answerCount: 1, pairedAnswers: 1 },
    ]))
    expect(result.unresolvedNames).toEqual([])

    const withUnresolved = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [{ ...answer('a2', 'run-1', 'Try [Blue Harbor](https://blue.example/).', ['blue.example']), recommendedCompetitors: ['Loose Name'] }],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(withUnresolved.unresolvedNames).toEqual([{ name: 'Loose Name', answerCount: 1 }])
  })

  it('uses the canonical domain-label floor and normalizes tracked subdomains', () => {
    const shortLabel = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a1', 'run-1', 'QVX is a useful choice.', ['qvx.example'])],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(shortLabel.candidates[0]).toMatchObject({ domain: 'qvx.example', namingAnswers: 0, reason: 'not-named' })

    const tracked = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a2', 'run-1', 'Rival is a useful choice.', ['offers.rival.example'])],
      classifications: new Map(),
      tracked: [{ domain: 'www.rival.example', aliases: ['Rival'] }],
      claimedCompetitorAdds: new Set(),
    })
    expect(tracked.candidates[0]).toMatchObject({ domain: 'rival.example', tracked: true, namingAnswers: 1 })
  })

  it('records shared hosts when sources use multiple subdomains', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [
        answer('a1', 'run-1', 'Rival is useful.', ['offers.rival.example']),
        answer('a2', 'run-1', 'Rival is useful.', ['booking.rival.example']),
      ],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(result.candidates.find(candidate => candidate.domain === 'rival.example')).toMatchObject({ reason: 'shared-host' })
  })

  it('honors tracked, claimed, own-site, and marketplace exclusions', () => {
    const result = buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [
        answer('a1', 'run-1', 'Tracked and Claimed are named.', ['tracked.example', 'claimed.example', 'subject.example', 'apartments.com']),
      ],
      classifications: new Map(),
      tracked: [{ domain: 'www.tracked.example', aliases: [] }],
      claimedCompetitorAdds: new Set(['claimed.example']),
    })

    expect(result.candidates.find(candidate => candidate.domain === 'tracked.example')).toMatchObject({ status: 'tracked', tracked: true })
    expect(result.candidates.find(candidate => candidate.domain === 'claimed.example')).toMatchObject({ status: 'excluded', reason: 'claimed-by-alias' })
    expect(result.candidates.some(candidate => candidate.domain === 'subject.example')).toBe(false)
    expect(result.candidates.some(candidate => candidate.domain === 'apartments.com')).toBe(false)
  })
})
