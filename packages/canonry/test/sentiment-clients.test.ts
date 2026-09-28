import { afterEach, describe, expect, it, vi } from 'vitest'
import { sentimentSummarySchema } from '@ainyc/canonry-contracts'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import { SENTIMENT_CLI_COMMANDS } from '../src/cli-commands/sentiment.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError, printCliError } from '../src/cli-error.js'

const client = vi.hoisted(() => ({
  getSentiment: vi.fn(), getSentimentSettings: vi.fn(), configureSentiment: vi.fn(), getSentimentEvidence: vi.fn(),
  compareSentiment: vi.fn(), previewSentimentBackfill: vi.fn(), submitSentimentBackfill: vi.fn(), listSentimentJobs: vi.fn(), getSentimentJob: vi.fn(),
}))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))
afterEach(() => vi.restoreAllMocks())

async function invoke(argv: string[], data: unknown, method: keyof typeof client, format: 'json' | 'jsonl' | 'text' = 'json') {
  client[method].mockResolvedValue(data)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  log.mockClear()
  await dispatchRegisteredCommand(['sentiment', ...argv], format, SENTIMENT_CLI_COMMANDS)
  return log.mock.calls.map(call => call.join(' ')).join('\n')
}

describe('sentiment CLI transport contract', () => {
  it('preserves the canonical partial fixture without recomputing rates', async () => {
    const output = await invoke(['demo'], sentimentFixtureSummary, 'getSentiment')
    expect(JSON.parse(output)).toEqual(sentimentFixtureSummary)
  })
  it.each(['disabled', 'processing', 'failed', 'canceled', 'not-measured'] as const)('preserves unavailable %s without coercing nulls', async state => {
    const fixture = { ...sentimentFixtureSummary, state, score: { ...sentimentFixtureSummary.score, favorableRate: null, interval: null } }
    expect(JSON.parse(await invoke(['demo'], fixture, 'getSentiment'))).toEqual(fixture)
  })
  it('passes every identity-bearing Advanced filter to evidence', async () => {
    await invoke(['evidence', 'demo', '--run-id', 'run', '--revision', '4', '--mode', 'advanced', '--query-class', 'branded', '--query-id', 'frozen-query', '--scope', 'property', '--scope-key', 'p', '--market-key', 'market', '--provider', 'openai', '--model', 'gpt-test', '--location', 'NY', '--evaluation-definition-id', 'def', '--assessment-id', 'frozen-assessment', '--cursor', 'cursor', '--limit', '12'], { items: [], nextCursor: null }, 'getSentimentEvidence')
    expect(client.getSentimentEvidence).toHaveBeenLastCalledWith('demo', {
      runId: 'run', revision: 4, mode: 'advanced', queryClass: 'branded', queryId: 'frozen-query', scope: 'property', scopeKey: 'p', marketKey: 'market', provider: 'openai', model: 'gpt-test', location: 'NY', evaluationDefinitionId: 'def', assessmentId: 'frozen-assessment', cursor: 'cursor', limit: 12,
    })
  })
  it('preserves an exact grouped run selection across summary and paginated evidence reads', async () => {
    const runIds = ['run-bayside', 'run-harbor']
    const fixture = { ...sentimentFixtureSummary, selection: { ...sentimentFixtureSummary.selection, runId: null, runIds, queryClass: 'non-brand' } }
    const flags = ['demo', '--run-ids', runIds[0], '--run-ids', runIds[1], '--query-class', 'non-brand']
    expect(JSON.parse(await invoke(flags, fixture, 'getSentiment'))).toEqual(fixture)
    expect(client.getSentiment).toHaveBeenLastCalledWith('demo', { mode: 'auto', scope: 'project', queryClass: 'non-brand', runIds })
    const page = { state: fixture.state, selection: fixture.selection, items: [], nextCursor: 'next' }
    expect(JSON.parse(await invoke(['evidence', ...flags, '--evaluation-definition-id', 'frozen-definition', '--cursor', 'cursor', '--limit', '7'], page, 'getSentimentEvidence'))).toEqual(page)
    expect(client.getSentimentEvidence).toHaveBeenLastCalledWith('demo', { mode: 'auto', scope: 'project', queryClass: 'non-brand', runIds, evaluationDefinitionId: 'frozen-definition', cursor: 'cursor', limit: 7 })
  })
  it('previews an explicit run selection and submits only its token and idempotency key', async () => {
    await invoke(['backfill', 'demo', '--preview', '--run-id', 'r1', '--run-id', 'r2'], { eligibleAssessments: 2 }, 'previewSentimentBackfill')
    expect(client.previewSentimentBackfill).toHaveBeenLastCalledWith('demo', expect.objectContaining({ runIds: ['r1', 'r2'] }))
    const receipt = { id: 'job', state: 'pending' }
    expect(JSON.parse(await invoke(['backfill', 'demo', '--preview-token', 'frozen', '--idempotency-key', 'key'], receipt, 'submitSentimentBackfill'))).toEqual(receipt)
    expect(client.submitSentimentBackfill).toHaveBeenLastCalledWith('demo', { previewToken: 'frozen', idempotencyKey: 'key' })
  })
  it.each([
    ['demo', '--run-id', 'r1', '--run-ids', 'r2'], ['evidence', 'demo', '--run-id', 'r1', '--run-ids', 'r2'],
    ['compare', 'demo', '--from-run-id', 'r1', '--to-run-id', 'r2', '--run-ids', 'r3'], ['backfill', 'demo', '--preview', '--run-ids', 'r1'],
    ['configure', 'demo'], ['configure', 'demo', '--enabled', 'maybe'],
    ['configure', 'demo', '--preset', 'default'], ['configure', 'demo', '--custom-themes', '[]'],
    ['backfill', 'demo', '--preview'], ['backfill', 'demo', '--preview-token', 'token'],
    ['backfill', 'demo', '--preview', '--run-id', 'run', '--preview-token', 'token'],
    ['backfill', 'demo', '--preview-token', 'token', '--idempotency-key', 'key', '--run-id', 'run'],
    ['compare', 'demo', '--from-run-id', 'r1'], ['evidence', 'demo', '--limit', '1oops'],
  ])('rejects invalid explicit arguments: %j', async (...argv) => {
    await expect(dispatchRegisteredCommand(['sentiment', ...argv], 'json', SENTIMENT_CLI_COMMANDS)).rejects.toBeInstanceOf(CliError)
  })
  it('preserves server display values, denominator and uncertainty without theme output', async () => {
    const fixture = { ...sentimentFixtureSummary, coverage: { ...sentimentFixtureSummary.coverage, eligibleAssessments: 17, unadmittedAssessments: 7 }, score: { ...sentimentFixtureSummary.score, favorableDisplay: '61%' } }
    const output = await invoke(['demo'], fixture, 'getSentiment', 'text')
    expect(output).toContain('61%')
    expect(output).toContain('5 of 10')
    expect(output).toContain('Branded')
    expect(output).toContain('provisional')
    expect(output).not.toContain('Theme')
    expect(output).toContain('favorable / (favorable + mixed + unfavorable)')
    expect(output).toContain('17 eligible assessments · 7 not yet admitted')
    expect(output).toContain(fixture.score.limitation)
  })
  it.each(['branded', 'non-brand'] as const)('preserves %s per-query JSON and prints the server-owned favorable display', async queryClass => {
    const query = { queryId: 'frozen-query', queryText: 'Which apartments are good?', queryClass, sourceSnapshotIds: ['frozen-snapshot'], locations: [], assessments: [], state: 'partial', reason: 'Classification is incomplete.', provisional: true, coverage: sentimentFixtureSummary.coverage, score: { ...sentimentFixtureSummary.score, favorableDisplay: '61%' } }
    const fixture = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, selection: { ...sentimentFixtureSummary.selection, queryClass, queryId: query.queryId }, queries: [query] })
    expect(JSON.parse(await invoke(['demo', '--query-class', queryClass, '--query-id', query.queryId], fixture, 'getSentiment'))).toEqual(fixture)
    expect(client.getSentiment).toHaveBeenLastCalledWith('demo', { mode: 'auto', scope: 'project', queryClass, queryId: query.queryId })
    const output = await invoke(['demo', '--query-class', queryClass], fixture, 'getSentiment', 'text')
    expect(output).toContain(`frozen-query · Which apartments are good? · ${queryClass}: Favorable 61% · 3 favorable / 5 judged · partial · provisional`)
  })
  it('prints exact engine verdicts and preserves unmeasured sources without inventing a rate', async () => {
    const base = { assessmentId: 'assessment-openai', sourceSnapshotId: 'snapshot-openai', runId: 'run', subjectId: 'subject', subjectLabel: 'Frozen subject', executionNodeKey: null, provider: 'openai', requestedModel: 'requested', servedModel: 'served', location: 'Harbor', evaluationDefinitionId: 'definition', state: 'complete' as const, outcome: 'favorable' as const, reason: null }
    const assessments = [base, { ...base, assessmentId: null, sourceSnapshotId: 'snapshot-gemini', provider: 'gemini', state: 'not-measured' as const, outcome: null, reason: 'Not admitted.' }]
    const fixture = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, queries: [{ queryId: 'query', queryText: 'Frozen query', queryClass: 'non-brand', sourceSnapshotIds: assessments.map(item => item.sourceSnapshotId), locations: [], assessments, state: 'partial', reason: null, provisional: true, coverage: sentimentFixtureSummary.coverage, score: sentimentFixtureSummary.score }] })
    expect(JSON.parse(await invoke(['demo'], fixture, 'getSentiment'))).toEqual(fixture)
    const output = await invoke(['demo'], fixture, 'getSentiment', 'text')
    expect(output).toContain('openai · requested requested · served served · Harbor · Frozen subject: favorable')
    expect(output).toContain('source snapshot-openai · assessment assessment-openai')
    expect(output).toContain('gemini · requested requested · served served · Harbor · Frozen subject: not-measured')
    expect(output).toContain('source snapshot-gemini · assessment not measured')
    expect(output).toContain('Not admitted.')
  })
  it.each([['demo', '--assessment-id', 'assessment'], ['compare', 'demo', '--from-run-id', 'a', '--to-run-id', 'b', '--assessment-id', 'assessment'], ['evidence', 'demo', '--assessment-id', '']])('rejects evidence-only or empty assessment selection %j', async (...argv) => {
    await expect(dispatchRegisteredCommand(['sentiment', ...argv], 'json', SENTIMENT_CLI_COMMANDS)).rejects.toBeInstanceOf(CliError)
  })
  it('only prints No evaluative answers for a completed zero-judgment selection', async () => {
    for (const state of ['complete', 'processing', 'canceled'] as const) {
      vi.restoreAllMocks()
      const data = { ...sentimentFixtureSummary, state, coverage: { ...sentimentFixtureSummary.coverage, judged: 0 } }
      expect((await invoke(['demo'], data, 'getSentiment', 'text')).includes('No evaluative answers')).toBe(state === 'complete')
    }
  })
  it.each([1, 2] as const)('retains API error code and exit classification %s, with JSON only on stderr', async exitCode => {
    const error = new CliError({ code: exitCode === 1 ? 'FORBIDDEN' : 'INTERNAL_ERROR', message: 'Safe failure', exitCode })
    client.getSentiment.mockRejectedValue(error)
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(dispatchRegisteredCommand(['sentiment', 'demo'], 'json', SENTIMENT_CLI_COMMANDS)).rejects.toBe(error)
    printCliError(error, 'json')
    expect(out).not.toHaveBeenCalled()
    expect(JSON.parse(String(err.mock.calls[0][0]))).toEqual({ error: { code: error.code, message: 'Safe failure' } })
    expect(error.exitCode).toBe(exitCode)
  })
})
