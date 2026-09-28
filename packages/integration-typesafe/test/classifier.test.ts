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
describe('subject-specific stance and evidence classification', () => {
  it('keeps a favorable conclusion with a caveat and original evidence', async () => {
    const { instance, requests } = classifier()
    const result = await instance.classify(inputFixture())
    expect(result).toMatchObject({ kind: 'classified', outcome: 'favorable', conclusion: [inputFixture().sentences[0]], complaint: [inputFixture().sentences[1]] })
    expect(requests).toHaveLength(1)
    expect(requests[0].model).toBe('jev-1.13.0')
    expect(Object.keys(requests[0].questions)).toEqual(['identity', 'judgment', 'stance', 'conclusion', 'complaint'])
    expect(requests[0].state).not.toHaveProperty('themes')
    expect(requests[0].state).not.toHaveProperty('themePolicy')
    expect(result).not.toHaveProperty('themes')
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
    expect(await classifier({ judgment: 'factual' }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome: 'factual' })
  })
  it('withholds a judgment without an exact conclusion source sentence', async () => {
    expect(await classifier({ conclusion: 's999' }).instance.classify(inputFixture())).toMatchObject({ kind: 'abstained', outcome: 'invalid-conclusion-evidence' })
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
  it.each([90_000, 77_000])('refuses a %i-byte answer over the calibrated bound without truncation or dispatch', async bytes => {
    const input = inputFixture(); input.sourceText = 'A'.repeat(bytes)
    input.sourceTextHash = createHash('sha256').update(input.sourceText).digest('hex')
    input.sentences = [{ id: 's1', text: input.sourceText, start: 0, end: input.sourceText.length }]
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'input-too-large' })
    expect(requests).toHaveLength(0)
    const built = buildJevSentimentRequest(input)
    // 77,000 bytes pass the answer-only check; the framed request still exceeds the state bound.
    if (bytes === 77_000) expect(built).toMatchObject({ ok: false, outcome: 'input-too-large', estimate: { stateAndLongestQuestionTokens: expect.any(Number) } })
    if (!built.ok && built.estimate) expect(built.estimate.stateAndLongestQuestionTokens).toBeGreaterThan(32_000)
  })
  it.each([[24_000, 240], [32_000, 250]])('sends a full %i-byte, %i-sentence answer that fits the real context window', async (bytes, count) => {
    const unit = Math.floor(bytes / count)
    const sentences = Array.from({ length: count }, (_, index) => {
      const lead = `North Hall review point ${index + 1}: residents mention quiet units, reliable maintenance, and a rooftop deck`
      return (lead + ' with a short walk to transit and groceries'.repeat(4)).slice(0, unit - 2).trimEnd() + '.'
    })
    const input = inputFixture(); input.sourceText = sentences.join(' ')
    input.sourceTextHash = createHash('sha256').update(input.sourceText).digest('hex')
    let start = 0
    input.sentences = sentences.map((text, index) => { const span = { id: `s${index + 1}`, text, start, end: start + text.length }; start += text.length + 1; return span })
    expect(Buffer.byteLength(input.sourceText, 'utf8')).toBeGreaterThan(bytes * 0.95)
    const built = buildJevSentimentRequest(input)
    expect(built.ok, JSON.stringify(built.ok ? built.estimate : built)).toBe(true)
    if (!built.ok) return
    expect(built.estimate.stateAndLongestQuestionTokens).toBeLessThan(32_000)
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'classified', outcome: 'favorable' })
    expect(requests).toHaveLength(1)
    expect(Object.values((requests[0].state as { answerSentences: Record<string, string> }).answerSentences).join(' ')).toBe(input.sourceText)
  })
  it('keeps a provider context rejection as a permanent failure when the estimate undercounts', async () => {
    let calls = 0
    const instance = createTypeSafeClassifier({ apiKey: 'synthetic-secret', fetch: async () => { calls++; return Response.json({ error: 'context too long' }, { status: 413 }) } })
    expect(await instance.classify(inputFixture())).toMatchObject({ kind: 'failed', outcome: 'failed', error: { code: 'provider-context-limit', retryable: false } })
    expect(calls).toBe(1)
  })
  it('consumes frozen stance-only question wording with a calibrated request estimate', () => {
    const input = inputFixture(); input.definition.questions.identity = 'Frozen revised identity question'
    const result = buildJevSentimentRequest(input)
    expect(result.ok, JSON.stringify(result.ok ? result.estimate : result)).toBe(true)
    if (!result.ok) return
    expect(result.request.questions.identity.instructions).toContain(input.definition.questions.identity)
    expect(Object.keys(result.request.questions)).toHaveLength(5)
    expect(Object.keys(result.request.questions).some(key => key.startsWith('theme_'))).toBe(false)
    expect(result.estimate.inputTokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(result.request), 'utf8') / 2.5) + 1024)
    expect(result.estimate.method).toBe('calibrated-utf8-byte-bound-v2')
  })
  it('does not dispatch unsupported languages or inapplicable subjects', async () => {
    for (const mutation of ['language', 'subject']) {
      const input = inputFixture()
      if (mutation === 'language') input.language = 'fr'
      if (mutation === 'subject') input.subject.mentionNotApplicable = true
      const { instance, requests } = classifier()
      expect((await instance.classify(input)).kind).toBe('abstained')
      expect(requests).toHaveLength(0)
    }
  })
})

describe('request budget and evaluator identity', () => {
  it.each(['unknown-evidence', 'legacy-schema'] as const)('rejects unsupported evaluator templates before dispatch: %s', async variant => {
    const input = inputFixture()
    if (variant === 'unknown-evidence') input.definition.evidenceVersion = 'unimplemented-v2'
    else input.definition.schemaVersion = 1
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


describe('non-brand intended-subject boundaries', () => {
  function nonBrand(sourceText?: string) {
    const input = inputFixture()
    input.context.queryClass = 'non-brand'
    input.context.queryText = 'Which apartment buildings are good in Chicago?'
    if (sourceText !== undefined) {
      input.sourceText = sourceText
      input.sourceTextHash = createHash('sha256').update(sourceText).digest('hex')
      input.sentences = [{ id: 's1', text: sourceText, start: 0, end: sourceText.length }]
    }
    return input
  }
  it.each(['South Hall is excellent.', 'North Hallmark has poor service.', 'No properties are named in this factual answer.'])('keeps an absent known subject nonjudged with no provider call: %s', async sourceText => {
    const { instance, requests } = classifier({ stance: 'unfavorable' })
    expect(await instance.classify(nonBrand(sourceText))).toMatchObject({ kind: 'abstained', outcome: 'subject-not-mentioned', returnedModel: null, usage: { kind: 'unknown' } })
    expect(requests).toHaveLength(0)
  })
  it('withholds a shared cross-class assessment when the intended subject is absent despite its branded primary context', async () => {
    const input = nonBrand('South Hall is excellent.')
    input.context.queryClass = 'branded'
    input.context.queryText = 'Is North Hall good?'
    input.context.usageEdges = [
      { queryId: 'branded-query', executionNodeKey: 'shared', targetId: input.subject.id, propertyId: input.subject.id, groupId: null, marketId: null, queryClass: 'branded', location: null },
      { queryId: 'non-brand-query', executionNodeKey: 'shared', targetId: input.subject.id, propertyId: input.subject.id, groupId: null, marketId: null, queryClass: 'non-brand', location: null },
    ]
    const { instance, requests } = classifier({ stance: 'unfavorable' })
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'subject-not-mentioned' })
    expect(requests).toHaveLength(0)
    input.context.usageEdges[1].targetId = 'another-subject'
    expect(await instance.classify(input)).toMatchObject({ kind: 'classified', outcome: 'unfavorable' })
    expect(requests).toHaveLength(1)
  })
  it('distinguishes missing frozen identity from a known absent subject', async () => {
    const input = nonBrand('South Hall is excellent.')
    input.subject.aliases = []; input.subject.qualifiedAliases = []; input.subject.urls = []
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'subject-not-applicable' })
    expect(requests).toHaveLength(0)
  })
  it.each(['wrong', 'ambiguous', 'absent'])('never counts a provider stance when identity is %s', async identity => {
    const outcomes = { wrong: 'wrong-subject', ambiguous: 'ambiguous-subject', absent: 'subject-not-mentioned' }
    const { instance, requests } = classifier({ identity, stance: 'unfavorable' })
    expect(await instance.classify(nonBrand())).toMatchObject({ kind: 'abstained', outcome: outcomes[identity as keyof typeof outcomes] })
    expect(requests).toHaveLength(1)
  })
  it('keeps opposite opinions attached to the frozen intended subject', async () => {
    const input = nonBrand('South Hall is excellent. North Hall is disappointing.')
    const secondStart = input.sourceText.indexOf('North Hall')
    input.sentences = [{ id: 's1', text: input.sourceText.slice(0, secondStart - 1), start: 0, end: secondStart - 1 }, { id: 's2', text: input.sourceText.slice(secondStart), start: secondStart, end: input.sourceText.length }]
    const { instance, requests } = classifier({ stance: 'unfavorable', conclusion: 's2', complaint: 's2' })
    expect(await instance.classify(input)).toMatchObject({ kind: 'classified', outcome: 'unfavorable', conclusion: [input.sentences[1]] })
    expect(requests[0].state).toMatchObject({ subject: input.subject, execution: { queryClass: 'non-brand', queryText: input.context.queryText } })
  })
  it('retains factual abstention and a favorable conclusion with a caveat separately', async () => {
    expect(await classifier({ judgment: 'factual', complaint: 'absent' }).instance.classify(nonBrand('North Hall is located in Chicago.'))).toMatchObject({ kind: 'abstained', outcome: 'factual' })
    expect(await classifier().instance.classify(nonBrand())).toMatchObject({ kind: 'classified', outcome: 'favorable', complaint: [inputFixture().sentences[1]] })
  })
  it.each(['https://www.North.example/path', 'North.Example', 'www.north.example/'])('uses the frozen domain as stored without a name alias: %s', async url => {
    const domain = nonBrand('north.example is a good choice.')
    domain.subject.aliases = []; domain.subject.qualifiedAliases = []; domain.subject.urls = [url]
    expect(await classifier({ complaint: 'absent' }).instance.classify(domain)).toMatchObject({ kind: 'classified', outcome: 'favorable' })
  })
  it('uses frozen qualified aliases as known identity candidates', async () => {
    const qualified = nonBrand('North Hall, Chicago is a good choice.')
    qualified.subject.aliases = []; qualified.subject.urls = []
    expect(await classifier({ complaint: 'absent' }).instance.classify(qualified)).toMatchObject({ kind: 'classified', outcome: 'favorable' })
  })
  it('refuses prior evaluator semantics instead of silently reclassifying old queued inputs', async () => {
    const input = nonBrand()
    input.definition.verdictVersion = 'stance-v1'; input.definition.identityVersion = 'qualified-subject-v1'
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'ambiguous-judgment' })
    expect(requests).toHaveLength(0)
  })
  it.each([['identityVersion', 'qualified-subject-v2'], ['segmentationVersion', 'sentence-spans-v1']] as const)('refuses a definition frozen before the current %s revision', async (field, previous) => {
    // v2 identity sent Simple non-brand answers only when they printed an alias or domain, never the
    // display name alone; v1 segmentation split after abbreviations and list markers.
    const input = nonBrand()
    input.definition[field] = previous
    const { instance, requests } = classifier()
    expect(await instance.classify(input)).toMatchObject({ kind: 'abstained', outcome: 'ambiguous-judgment', reason: 'The frozen evaluator template version is unsupported.' })
    expect(requests).toHaveLength(0)
  })
})
