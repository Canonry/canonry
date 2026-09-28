import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { buildJevSentimentRequest, createTypeSafeClassifier } from '../src/classifier.js'
import type { JevRequest } from '../src/client.js'
import { inputFixture, responseFixture } from './fixtures.js'

function classifier(overrides: Record<string, string> = {}) {
  const requests: JevRequest[] = []
  const instance = createTypeSafeClassifier({ apiKey: 'synthetic-secret', fetch: async (_url, init) => {
    const request: JevRequest = JSON.parse(String(init?.body)); requests.push(request)
    return Response.json(responseFixture(request, overrides))
  } })
  return { instance, requests }
}
describe('subject-specific branded classification', () => {
  it('keeps a favorable conclusion with a valid criticism theme and original evidence', async () => {
    const { instance, requests } = classifier()
    const result = await instance.classify(inputFixture())
    expect(result).toMatchObject({ kind: 'classified', outcome: 'favorable', conclusion: [inputFixture().sentences[0]], complaint: [inputFixture().sentences[1]], themes: [{ discussed: true, praised: false, criticized: true }] })
    expect(requests).toHaveLength(1)
    expect(requests[0].model).toBe('jev-1.13.0')
    expect(requests[0].state).toMatchObject({ subject: inputFixture().subject, execution: inputFixture().context })
  })
  it('does not manufacture a complaint when absent', async () => {
    const { instance } = classifier({ complaint: 'absent' })
    expect(await instance.classify(inputFixture())).toMatchObject({ kind: 'classified', complaint: null })
  })
  it.each([['wrong', 'wrong-subject'], ['ambiguous', 'ambiguous-subject']])('separates %s identity from the other abstentions', async (identity, outcome) => {
    expect(await classifier({ identity }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome })
  })
  it('keeps uncertain judgments separate from factual answers', async () => {
    expect(await classifier({ judgment: 'ambiguous' }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome: 'ambiguous-judgment' })
    expect(await classifier({ judgment: 'factual', theme_0_criticized: 'no', theme_0_criticized_evidence: 'absent' }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome: 'factual', themes: [{ discussed: true, praised: false, criticized: false }] })
  })
  it('accepts overlapping praise and criticism and rejects polarity without discussion', async () => {
    expect(await classifier({ theme_0_praised: 'yes', theme_0_praised_evidence: 's1' }).instance.classify(inputFixture())).toMatchObject({ themes: [{ discussed: true, praised: true, criticized: true }] })
    expect(await classifier({ theme_0_discussed: 'no' }).instance.classify(inputFixture())).toMatchObject({ kind: 'classified', outcome: 'favorable', themes: [{ discussed: null, praised: null, criticized: null }] })
  })
  it('rejects unknown conclusion IDs without throwing away valid unrelated theme decisions', async () => {
    expect(await classifier({ conclusion: 's999' }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome: 'invalid-conclusion-evidence' })
    expect(await classifier({ theme_0_criticized_evidence: 's999' }).instance.classify(inputFixture())).toMatchObject({ kind: 'classified', outcome: 'favorable', themes: [{ discussed: null }] })
  })
  it.each(['text', 'start', 'end'])('rejects altered source span %s before dispatch', async field => {
    const input = inputFixture()
    if (field === 'text') input.sentences[0].text = 'Made up quote'
    if (field === 'start') input.sentences[0].start = 1
    if (field === 'end') input.sentences[0].end = 99999
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'invalid-conclusion-evidence' })
    expect(requests).toHaveLength(0)
  })
  it('refuses oversized requests without truncation or dispatch', async () => {
    const input = inputFixture(); input.sourceText = 'A'.repeat(64001)
    input.sourceTextHash = createHash('sha256').update(input.sourceText).digest('hex')
    input.sentences = [{ id: 's1', text: input.sourceText, start: 0, end: input.sourceText.length }]
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'input-too-large' })
    expect(requests).toHaveLength(0)
  })
  it('consumes the frozen question wording and independently names every theme decision', () => {
    const input = inputFixture(); input.definition.questions.identity = 'Frozen revised identity question'
    const result = buildJevSentimentRequest(input)
    expect(result.ok, JSON.stringify(result.ok ? result.estimate : result)).toBe(true)
    if (!result.ok) return
    expect(result.request.questions.identity.instructions).toContain(input.definition.questions.identity)
    expect(Object.keys(result.request.questions)).toContain('theme_0_criticized_evidence')
    expect(result.estimate.method).toBe('utf8-byte-upper-bound-v1')
  })
  it('does not dispatch unsupported languages, non-brand work, or inapplicable subjects', async () => {
    for (const mutation of ['language', 'non-brand', 'subject']) {
      const input = inputFixture()
      if (mutation === 'language') input.language = 'fr'
      if (mutation === 'non-brand') input.context.queryClass = 'non-brand'
      if (mutation === 'subject') input.subject.mentionNotApplicable = true
      const { instance, requests } = classifier()
      expect((await instance.classify(input)).kind).toBe('abstained')
      expect(requests).toHaveLength(0)
    }
  })
})

describe('request budget and evaluator identity', () => {
  it('fits 24 themes at the configured name and description bounds for a short answer', () => {
    const input = inputFixture()
    input.definition.themes = Array.from({ length: 24 }, (_, index) => ({ id: `custom-${index}`, name: `Theme ${index} `.padEnd(80, 'x'), description: 'Synthetic custom definition. '.padEnd(400, 'x'), source: 'custom', evaluationStatus: 'custom-not-evaluated' }))
    const result = buildJevSentimentRequest(input)
    expect(result.ok, JSON.stringify(result.ok ? result.estimate : result)).toBe(true)
    if (result.ok) {
      expect(result.estimate.inputTokens).toBeLessThanOrEqual(64000)
      expect(result.estimate.stateAndLongestQuestionTokens).toBeLessThanOrEqual(32000)
      expect(result.estimate.inputTokens).toBeGreaterThan(result.estimate.withoutThemeEvidenceTokens)
    }
  })
  it('rejects unknown evaluator templates before dispatch', async () => {
    const input = inputFixture(); input.definition.evidenceVersion = 'unimplemented-v2'
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', reason: 'The frozen evaluator template version is unsupported.' })
    expect(requests).toHaveLength(0)
  })
  it('returns typed failure for missing decisions and ignores fabricated provider quotations', async () => {
    const input = inputFixture()
    const missing = createTypeSafeClassifier({ apiKey: 'x', fetch: async (_url, init) => {
      const response = responseFixture(JSON.parse(String(init?.body)))
      delete response.answers.identity
      return Response.json(response)
    } })
    expect(await missing.classify(input)).toMatchObject({ kind: 'failed', error: { code: 'response-contract', retryable: false } })
    const altered = createTypeSafeClassifier({ apiKey: 'x', fetch: async (_url, init) => {
      const response = responseFixture(JSON.parse(String(init?.body)))
      return Response.json({ ...response, answers: { ...response.answers, conclusion: { ...response.answers.conclusion, quote: 'Fabricated provider quotation' } } })
    } })
    expect(await altered.classify(input)).toMatchObject({ kind: 'classified', conclusion: [input.sentences[0]] })
  })
})
