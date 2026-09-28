import { describe, expect, it } from 'vitest'
import { buildMentionShare } from '@ainyc/canonry-intelligence'
import { buildMentionShareInputs, mentionShareCompetitorsFromDomains } from '../src/mention-share-inputs.js'

describe('mention-share input identity', () => {
  it('recomputes project mentions from answer text against the current identity', () => {
    const inputs = buildMentionShareInputs({
      project: { displayName: 'Current Acme', canonicalDomain: 'acme.com' },
      competitorDomains: [],
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
      competitorDomains: [],
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
      competitorDomains: ['rival.com'],
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
      competitorDomains: ['https://www.ai.com/pricing'],
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
      competitorDomains: ['ibm.com'],
      snapshots: [
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'IBM is a common acronym.' },
        { queryText: 'best automation tools', answerMentioned: false, answerText: 'See ibm.com for details.' },
      ],
    })
    const result = buildMentionShare(inputs.snapshots, { competitors: inputs.competitors })

    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
  })
})
