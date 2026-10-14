import { describe, expect, it, vi } from 'vitest'
import { buildCompetitorSuggestions } from '../src/competitor-suggestions.js'

/**
 * Counts matcher builds and answer-text walks. Walking the text again for
 * every candidate is what stalled a wide scan. A wall-clock limit on that
 * fails on a slow runner, so the bound is on the work itself.
 */
const matcherWork = vi.hoisted(() => ({ builds: 0, textWalks: 0 }))
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return {
    ...actual,
    compileBrandAliases: (...args: Parameters<typeof actual.compileBrandAliases>) => {
      matcherWork.builds++
      return actual.compileBrandAliases(...args)
    },
    aliasOccurrencesAsWritten: (...args: Parameters<typeof actual.aliasOccurrencesAsWritten>) => {
      matcherWork.textWalks++
      return actual.aliasOccurrencesAsWritten(...args)
    },
  }
})

const project = {
  domain: 'subject.example',
  label: 'Subject',
  domains: ['subject.example'],
}

function answer(id: string, runId: string, text: string, citedDomains: string[], createdAt = '2026-01-01T00:00:00.000Z') {
  return { id, runId, createdAt, answerText: text, citedDomains, citedUrls: null, recommendedCompetitors: [] }
}

describe('buildCompetitorSuggestions', () => {
  it.each(['energy', 'Energy', 'ENERGY'])('does not suggest unpaired domain-word matches such as %s', async name => {
    const result = await buildCompetitorSuggestions({
      project,
      minAnswers: 3,
      answers: [
        answer('energy-source', 'run-1', 'A source list only.', ['energy.gov']),
        ...Array.from({ length: 3 }, (_, index) => answer(
          `energy-${index}`,
          'run-1',
          `${name} is a broad category in this answer.`,
          [],
        )),
      ],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })

    expect(result.candidates[0]).toMatchObject({
      domain: 'energy.gov',
      namingAnswers: 3,
      pairedAnswers: 0,
      status: 'excluded',
      reason: 'unpaired-name',
    })
  })

  it('keeps a wide stored suggestion scan bounded while preserving candidate output', async () => {
    const domains = Array.from({ length: 600 }, (_, index) => `stored-rival-${index}.example`)
    const answers = Array.from({ length: 96 }, (_, index) => answer(
      `wide-${index}`,
      `run-${index}`,
      'Stored answer prose contains no candidate business name.',
      domains,
    ))
    matcherWork.builds = 0
    matcherWork.textWalks = 0
    const result = await buildCompetitorSuggestions({
      project,
      minAnswers: 3,
      answers,
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })

    expect(result.candidates).toHaveLength(domains.length)
    expect(result.candidates.every(candidate => candidate.namingAnswers === 0)).toBe(true)
    expect(matcherWork.builds).toBe(1)
    expect(matcherWork.textWalks).toBe(answers.length)
  })

  it('uses stored subdomain classifications and includes naming-only sweeps in the evidence span', async () => {
    const result = await buildCompetitorSuggestions({
      project, minAnswers: 1, tracked: [], claimedCompetitorAdds: new Set(),
      classifications: new Map([['news.publisher.example', 'editorial-media']]),
      answers: [
        answer('early', 'early-run', 'Rival is recommended.', [], '2026-01-01T00:00:00.000Z'),
        answer('middle', 'middle-run', 'Rival and Publisher are recommended.', ['rival.example', 'news.publisher.example'], '2026-01-02T00:00:00.000Z'),
        answer('late', 'late-run', 'Rival is recommended.', [], '2026-01-03T00:00:00.000Z'),
      ],
    })
    expect(result.candidates.find(row => row.domain === 'publisher.example')).toMatchObject({
      surfaceClass: 'editorial-media', status: 'excluded', reason: 'non-competitor-surface',
    })
    expect(result.candidates.find(row => row.domain === 'rival.example')).toMatchObject({
      namingAnswers: 3, citingAnswers: 1, bothAnswers: 1, sweeps: 3,
      firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-03T00:00:00.000Z',
    })
  })

  it('joins named answer text to same-answer sources and counts answers exactly', async () => {
    const result = await buildCompetitorSuggestions({
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

  it('does not treat a citation alone as a competitor and reports unresolved names', async () => {
    const result = await buildCompetitorSuggestions({
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

  it('keeps an anchored alias on the cited domain for operator review', async () => {
    const result = await buildCompetitorSuggestions({
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

  it('keeps anchored names on their own domains and leaves unrelated names unresolved', async () => {
    const result = await buildCompetitorSuggestions({
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

    const withUnresolved = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [{ ...answer('a2', 'run-1', 'Try [Blue Harbor](https://blue.example/).', ['blue.example']), recommendedCompetitors: ['Loose Name'] }],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(withUnresolved.unresolvedNames).toEqual([{ name: 'Loose Name', answerCount: 1 }])
  })

  it('uses the canonical domain-label floor and normalizes tracked subdomains', async () => {
    const shortLabel = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a1', 'run-1', 'QVX is a useful choice.', ['qvx.example'])],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(shortLabel.candidates[0]).toMatchObject({ domain: 'qvx.example', namingAnswers: 0, reason: 'not-named' })

    const tracked = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a2', 'run-1', 'Rival is a useful choice.', ['offers.rival.example'])],
      classifications: new Map(),
      tracked: [{ domain: 'www.rival.example', aliases: ['Rival'] }],
      claimedCompetitorAdds: new Set(),
    })
    expect(tracked.candidates[0]).toMatchObject({ domain: 'rival.example', tracked: true, namingAnswers: 1 })
  })

  it('keeps bare-add matching for untracked domains inside a frozen scope', async () => {
    const result = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [{
        ...answer('a1', 'run-1', 'Regionalonly is a useful choice.', ['regionalonly.example']),
        competitors: [],
      }],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })

    expect(result.candidates[0]).toMatchObject({
      domain: 'regionalonly.example', namingAnswers: 1, status: 'suggested', tracked: false,
      names: [{ name: 'Regionalonly', answerCount: 1 }],
    })
  })

  it('records shared hosts when sources use multiple subdomains', async () => {
    const result = await buildCompetitorSuggestions({
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

  it('counts repeated anchored names per answer and excludes a canonical label from other-name counts', async () => {
    const result = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [
        answer('a1', 'run-1', 'Try [Blue Harbor](https://rival.example/).', ['rival.example']),
        answer('a2', 'run-2', 'Try [Blue Harbor](https://rival.example/).', ['rival.example']),
        answer('a3', 'run-3', 'Try [Rival](https://rival.example/).', ['rival.example']),
      ],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(result.candidates[0]).toMatchObject({ namedByOtherNameAnswers: 2 })
    expect(result.candidates[0]?.names).toEqual(expect.arrayContaining([
      { name: 'Blue Harbor', answerCount: 2, pairedAnswers: 2 },
      { name: 'Rival', answerCount: 1, pairedAnswers: 1 },
    ]))
  })

  it('treats apex and www as one host form', async () => {
    const result = await buildCompetitorSuggestions({
      project,
      minAnswers: 1,
      answers: [answer('a1', 'run-1', 'Rival is useful.', ['www.rival.example', 'rival.example'])],
      classifications: new Map(),
      tracked: [],
      claimedCompetitorAdds: new Set(),
    })
    expect(result.candidates[0]).toMatchObject({ domain: 'rival.example', reason: null })
  })

  it('honors tracked, claimed, own-site, and marketplace exclusions', async () => {
    const result = await buildCompetitorSuggestions({
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
