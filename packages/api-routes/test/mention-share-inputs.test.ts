import { describe, expect, it } from 'vitest'
import { formatPercent, percentOf } from '@ainyc/canonry-contracts'
import { buildMentionShare } from '@ainyc/canonry-intelligence'
import { buildMentionShareInputs, mentionShareCompetitors, mentionShareCompetitorsFromDomains } from '../src/mention-share-inputs.js'

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
    const competitors = mentionShareCompetitorsFromDomains(['https://www.ai.com/pricing'])
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
    const competitors = mentionShareCompetitorsFromDomains(['ibm.com'])
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
    const project = { displayName: 'Roofwise', canonicalDomain: 'roofwise.example' }
    const answers = [
      ...Array.from({ length: 3 }, () => 'Roofwise is a solid pick for coatings.'),
      ...Array.from({ length: 4 }, () => 'Get a quote at ridgecrestbuildinc.example today.'),
      ...Array.from({ length: 4 }, () => 'FoamSeal is the usual recommendation.'),
      ...Array.from({ length: 3 }, () => 'Ridgecrest Roofing handles commercial work.'),
      ...Array.from({ length: 3 }, () => 'QVX does silicone coatings.'),
      'Nobody in particular is named here.',
    ]
    const snapshots = answers.map(answerText => ({ queryText: 'best roof coating contractor', answerMentioned: null, answerText }))
    const domainsOnly = [
      { domain: 'sealfoamworks.example' },
      { domain: 'ridgecrestbuildinc.example' },
      { domain: 'qvx.example' },
    ]
    const curated = [
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] },
      { domain: 'ridgecrestbuildinc.example', aliases: ['Ridgecrest Roofing'] },
      { domain: 'qvx.example', aliases: ['QVX'] },
    ]

    it('builds brand tokens from the domain label, the written host and the curated aliases', () => {
      expect(mentionShareCompetitors(curated).map(c => c.brandTokens)).toEqual([
        ['sealfoamworks', 'FoamSeal', 'sealfoamworks.example'],
        ['ridgecrestbuildinc', 'Ridgecrest Roofing', 'ridgecrestbuildinc.example'],
        ['QVX', 'qvx.example'],
      ])
      // The domains-only wrapper is the same builder with no curated alias.
      expect(mentionShareCompetitorsFromDomains(['qvx.example'])).toEqual(mentionShareCompetitors([{ domain: 'qvx.example' }]))
    })

    it('counts competitors named only by their curated aliases', () => {
      const without = buildMentionShareInputs({ project, competitors: domainsOnly, snapshots })
      const withoutResult = buildMentionShare(without.snapshots, { competitors: without.competitors, classificationAvailable: without.classified })
      expect(withoutResult.scope).toBe('non-brand')
      expect(withoutResult.breakdown).toMatchObject({
        projectMentionSnapshots: 3,
        competitorMentionSnapshots: 4,
        combinedMentionSnapshots: 7,
        snapshotsWithAnswerText: 18,
      })
      expect(withoutResult.breakdown.score).toBe(percentOf(3, 7))
      expect(withoutResult.breakdown.score).toBe(42.857143)
      expect(formatPercent(withoutResult.breakdown.score, 'percent')).toBe('42.9%')

      const withAliases = buildMentionShareInputs({ project, competitors: curated, snapshots })
      const result = buildMentionShare(withAliases.snapshots, { competitors: withAliases.competitors, classificationAvailable: withAliases.classified })
      expect(result.breakdown).toMatchObject({
        projectMentionSnapshots: 3,
        competitorMentionSnapshots: 14,
        combinedMentionSnapshots: 17,
        snapshotsWithAnswerText: 18,
      })
      expect(result.breakdown.score).toBe(percentOf(3, 17))
      expect(result.breakdown.score).toBe(17.647059)
      expect(formatPercent(result.breakdown.score, 'percent')).toBe('17.6%')
      expect(result.breakdown.perCompetitor.map(row => [row.domain, row.mentionSnapshots])).toEqual([
        ['ridgecrestbuildinc.example', 7],
        ['sealfoamworks.example', 4],
        ['qvx.example', 3],
      ])
    })

    it('credits an answer once per competitor when it names the domain and the alias', () => {
      const inputs = buildMentionShareInputs({
        project,
        competitors: curated,
        snapshots: [{ queryText: 'best roof coating contractor', answerMentioned: null, answerText: 'Ridgecrest Roofing (ridgecrestbuildinc.example) is fast.' }],
      })
      const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors, classificationAvailable: inputs.classified })
      expect(result.breakdown.competitorMentionSnapshots).toBe(1)
    })

    it('does not count a stored alias below the alias floor', () => {
      const inputs = buildMentionShareInputs({
        project,
        competitors: [{ domain: 'qvx.example', aliases: ['QV'] }],
        snapshots: [{ queryText: 'best roof coating contractor', answerMentioned: null, answerText: 'QV is where the crews are based.' }],
      })
      expect(inputs.competitors[0]!.brandTokens).toEqual(['qvx.example'])
      const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors, classificationAvailable: inputs.classified })
      expect(result.breakdown.competitorMentionSnapshots).toBe(0)
      expect(result.breakdown.score).toBeNull()
    })
  })
})
