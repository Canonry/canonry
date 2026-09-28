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
    await invoke(['evidence', 'demo', '--run-id', 'run', '--revision', '4', '--mode', 'advanced', '--query-class', 'branded', '--query-id', 'frozen-query', '--scope', 'property', '--scope-key', 'p', '--market-key', 'market', '--provider', 'openai', '--model', 'gpt-test', '--location', 'NY', '--evaluation-definition-id', 'def', '--cursor', 'cursor', '--limit', '12'], { items: [], nextCursor: null }, 'getSentimentEvidence')
    expect(client.getSentimentEvidence).toHaveBeenLastCalledWith('demo', {
      runId: 'run', revision: 4, mode: 'advanced', queryClass: 'branded', queryId: 'frozen-query', scope: 'property', scopeKey: 'p', marketKey: 'market', provider: 'openai', model: 'gpt-test', location: 'NY', evaluationDefinitionId: 'def', cursor: 'cursor', limit: 12,
    })
  })
  it('previews an explicit run selection and submits only its token and idempotency key', async () => {
    await invoke(['backfill', 'demo', '--preview', '--run-id', 'r1', '--run-id', 'r2'], { eligibleAssessments: 2 }, 'previewSentimentBackfill')
    expect(client.previewSentimentBackfill).toHaveBeenLastCalledWith('demo', expect.objectContaining({ runIds: ['r1', 'r2'] }))
    const receipt = { id: 'job', state: 'pending' }
    expect(JSON.parse(await invoke(['backfill', 'demo', '--preview-token', 'frozen', '--idempotency-key', 'key'], receipt, 'submitSentimentBackfill'))).toEqual(receipt)
    expect(client.submitSentimentBackfill).toHaveBeenLastCalledWith('demo', { previewToken: 'frozen', idempotencyKey: 'key' })
  })
  it.each([
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
    const query = { queryId: 'frozen-query', queryText: 'Which apartments are good?', queryClass, sourceSnapshotIds: ['frozen-snapshot'], locations: [], state: 'partial', reason: 'Classification is incomplete.', provisional: true, coverage: sentimentFixtureSummary.coverage, score: { ...sentimentFixtureSummary.score, favorableDisplay: '61%' } }
    const fixture = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, selection: { ...sentimentFixtureSummary.selection, queryClass, queryId: query.queryId }, queries: [query] })
    expect(JSON.parse(await invoke(['demo', '--query-class', queryClass, '--query-id', query.queryId], fixture, 'getSentiment'))).toEqual(fixture)
    expect(client.getSentiment).toHaveBeenLastCalledWith('demo', { mode: 'auto', scope: 'project', queryClass, queryId: query.queryId })
    const output = await invoke(['demo', '--query-class', queryClass], fixture, 'getSentiment', 'text')
    expect(output).toContain(`frozen-query · Which apartments are good? · ${queryClass}: Favorable 61% · 3 favorable / 5 judged · partial · provisional`)
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
