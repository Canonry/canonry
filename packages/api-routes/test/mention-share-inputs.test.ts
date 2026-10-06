import { describe, expect, it } from 'vitest'
import { formatPercent, percentOf } from '@ainyc/canonry-contracts'
import { buildMentionShare } from '@ainyc/canonry-intelligence'
import { buildMentionShareInputs, mentionShareCompetitors } from '../src/mention-share-inputs.js'

describe('mention-share input identity', () => {
  it('recomputes project mentions from answer text against the current identity', () => {
    const inputs = buildMentionShareInputs({
      project: { displayName: 'Current Acme', canonicalDomain: 'acme.com' },
      competitors: [],
      snapshots: [
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'Current Acme is recommended.' },
        { queryText: 'best automation tools', answerMentioned: true, answerText: 'No tracked brand is named.' },
        { queryText: 'best automation tools', answerMentioned: true, answerText: null },
      ],
    })

    expect(inputs.snapshots.map(snapshot => snapshot.projectMentioned)).toEqual([true, false, true])
  })

  it('accepts request-scoped prose domains without changing project mentions', () => {
    const answerDomainsByText = new Map<string, readonly string[]>()
    const answerText = 'See acme.com/pricing for details.'
    const inputs = buildMentionShareInputs({
      project: { displayName: 'Acme', canonicalDomain: 'acme.com' },
      competitors: [],
      snapshots: [{ queryText: 'pricing', answerMentioned: false, answerText }],
      answerDomainsByText,
    })

    expect(inputs.snapshots[0]!.projectMentioned).toBe(true)
    expect(answerDomainsByText.get(answerText)).toEqual(['acme.com'])
  })

  it('caches prose domains only, so a citation chip never becomes a project mention', () => {
    // Shape of an OpenAI web-search answer: the project appears only in its
    // inline source chips. The shared cache feeds both project mentions and
    // competitor signals, so it must hold the prose's hosts, not the chips'.
    const answerDomainsByText = new Map<string, readonly string[]>()
    const answerText = 'Plans start at $20 a month with a free trial. ([acme.com](https://acme.com/pricing?utm_source=chatgpt.com), [rival.com](https://rival.com/compare?utm_source=chatgpt.com))'
    const inputs = buildMentionShareInputs({
      project: { displayName: 'Acme Automation', canonicalDomain: 'acme.com' },
      competitors: [{ domain: 'rival.com' }],
      snapshots: [{ queryText: 'automation pricing', answerMentioned: true, answerText }],
      answerDomainsByText,
    })
    const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors })

    expect(answerDomainsByText.get(answerText)).toEqual([])
    expect(inputs.snapshots[0]!.projectMentioned).toBe(false)
    expect(result.breakdown.competitorMentionSnapshots).toBe(0)
  })

  it('counts an exact short competitor domain without counting its bare label', () => {
    const competitors = mentionShareCompetitors([{ domain: 'https://www.ai.com/pricing' }])
    expect(competitors[0]!.brandTokens).toEqual(['ai.com'])

    const inputs = buildMentionShareInputs({
      project: { displayName: 'Acme' },
      competitors: [{ domain: 'https://www.ai.com/pricing' }],
      snapshots: [
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'Compare ai.com with other tools.' },
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'AI is useful for automation.' },
      ],
    })
    const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors })

    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
  })

  it('does not promote a three-letter domain label into an implicit alias', () => {
    const competitors = mentionShareCompetitors([{ domain: 'ibm.com' }])
    expect(competitors[0]!.brandTokens).toEqual(['ibm.com'])

    const inputs = buildMentionShareInputs({
      project: { displayName: 'Acme' },
      competitors: [{ domain: 'ibm.com' }],
      snapshots: [
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'IBM is a common acronym.' },
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'See ibm.com for details.' },
      ],
    })
    const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors })

    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
  })

  describe('curated competitor aliases', () => {
    // A stored-shape fixture: competitors are registrable domains whose labels
    // never appear in the answers, while the brands they go by do.
    const project = { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example' }
    const answers = [
      ...Array.from({ length: 4 }, () => 'Rotorwise is a solid pick for tune-ups.'),
      ...Array.from({ length: 2 }, () => 'Book a fitting at ravenwoodbikeinc.example today.'),
      ...Array.from({ length: 3 }, () => 'TuneSpoke is the usual recommendation.'),
      ...Array.from({ length: 2 }, () => 'Ravenwood Cycling handles fleet bikes.'),
      'QVX does wheel builds.',
      ...Array.from({ length: 2 }, () => 'Nobody in particular is named here.'),
    ]
    const snapshots = answers.map(answerText => ({ queryText: 'best bike repair shop', answerMentioned: null, answerText }))
    const domainsOnly = [
      { domain: 'spoketuneworks.example' },
      { domain: 'ravenwoodbikeinc.example' },
      { domain: 'qvx.example' },
    ]
    const curated = [
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood Cycling'] },
      { domain: 'qvx.example', aliases: ['QVX'] },
    ]

    it('builds brand tokens from the domain label, the written host and the curated aliases', () => {
      expect(mentionShareCompetitors(curated).map(c => c.brandTokens)).toEqual([
        ['spoketuneworks', 'TuneSpoke', 'spoketuneworks.example'],
        ['ravenwoodbikeinc', 'Ravenwood Cycling', 'ravenwoodbikeinc.example'],
        ['QVX', 'qvx.example'],
      ])
      // No curated alias: the 3-letter label stays below the domain floor.
      expect(mentionShareCompetitors([{ domain: 'qvx.example' }]).map(c => c.brandTokens)).toEqual([['qvx.example']])
    })

    it('counts competitors named only by their curated aliases', () => {
      const without = buildMentionShareInputs({ project, competitors: domainsOnly, snapshots })
      const withoutResult = buildMentionShare(without.snapshots, { competitors: without.competitors, classificationAvailable: without.classified })
      expect(withoutResult.scope).toBe('non-brand')
      expect(withoutResult.breakdown).toMatchObject({
        projectMentionSnapshots: 4,
        competitorMentionSnapshots: 2,
        combinedMentionSnapshots: 6,
        snapshotsWithAnswerText: 14,
      })
      expect(withoutResult.breakdown.score).toBe(percentOf(4, 6))
      expect(withoutResult.breakdown.score).toBe(66.666667)
      expect(formatPercent(withoutResult.breakdown.score, 'percent')).toBe('66.7%')

      const withAliases = buildMentionShareInputs({ project, competitors: curated, snapshots })
      const result = buildMentionShare(withAliases.snapshots, { competitors: withAliases.competitors, classificationAvailable: withAliases.classified })
      expect(result.breakdown).toMatchObject({
        projectMentionSnapshots: 4,
        competitorMentionSnapshots: 8,
        combinedMentionSnapshots: 12,
        snapshotsWithAnswerText: 14,
      })
      expect(result.breakdown.score).toBe(percentOf(4, 12))
      expect(result.breakdown.score).toBe(33.333333)
      expect(formatPercent(result.breakdown.score, 'percent')).toBe('33.3%')
      expect(result.breakdown.perCompetitor.map(row => [row.domain, row.mentionSnapshots])).toEqual([
        ['ravenwoodbikeinc.example', 4],
        ['spoketuneworks.example', 3],
        ['qvx.example', 1],
      ])
    })

    it('credits an answer once per competitor when it names the domain and the alias', () => {
      const inputs = buildMentionShareInputs({
        project,
        competitors: curated,
        snapshots: [{ queryText: 'best bike repair shop', answerMentioned: null, answerText: 'Ravenwood Cycling (ravenwoodbikeinc.example) is fast.' }],
      })
      const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors, classificationAvailable: inputs.classified })
      expect(result.breakdown.competitorMentionSnapshots).toBe(1)
    })

    it('does not count a stored alias below the alias floor', () => {
      const inputs = buildMentionShareInputs({
        project,
        competitors: [{ domain: 'qvx.example', aliases: ['QV'] }],
        snapshots: [{ queryText: 'best bike repair shop', answerMentioned: null, answerText: 'QV is where the mechanics are based.' }],
      })
      expect(inputs.competitors[0]!.brandTokens).toEqual(['qvx.example'])
      const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors, classificationAvailable: inputs.classified })
      expect(result.breakdown.competitorMentionSnapshots).toBe(0)
      expect(result.breakdown.score).toBeNull()
    })
  })
})
