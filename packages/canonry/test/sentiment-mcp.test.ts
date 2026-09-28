import { describe, expect, it, vi } from 'vitest'
import { sentimentSummarySchema } from '@ainyc/canonry-contracts'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import type { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'
import { canonryMcpTools, type CanonryMcpTool } from '../src/mcp/tool-registry.js'
import { getCanonryMcpTools } from '../src/mcp/server.js'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'
import { withToolErrors } from '../src/mcp/results.js'
import { AERO_EXCLUDED_MCP_TOOLS } from '../src/agent/mcp-to-agent-tool.js'

function tool(name: string): CanonryMcpTool {
  const found = canonryMcpTools.find(item => item.name === name)
  if (!found) throw new Error(`Missing tool ${name}`)
  return found
}
const cases = [
  { name: 'canonry_sentiment_settings', method: 'getSentimentSettings', input: { project: 'demo' }, args: ['demo'] },
  { name: 'canonry_sentiment_configure', method: 'configureSentiment', input: { project: 'demo', enabled: false }, args: ['demo', { enabled: false }] },
  { name: 'canonry_sentiment', method: 'getSentiment', input: { project: 'demo' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'project' }] },
  { name: 'canonry_sentiment', method: 'getSentiment', input: { project: 'demo', queryId: 'q', executionNodeKey: 'node', include: ['assessments'], queryLimit: 10, queryCursor: 'next' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'project', queryId: 'q', executionNodeKey: 'node', include: ['assessments'], queryLimit: 10, queryCursor: 'next' }] },
  { name: 'canonry_sentiment_evidence', method: 'getSentimentEvidence', input: { project: 'demo', scope: 'property', scopeKey: 'property', marketKey: 'market', assessmentId: 'assessment', evaluationDefinitionId: 'def', cursor: 'cursor' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'property', scopeKey: 'property', marketKey: 'market', assessmentId: 'assessment', evaluationDefinitionId: 'def', cursor: 'cursor', limit: 50 }] },
  { name: 'canonry_sentiment_compare', method: 'compareSentiment', input: { project: 'demo', fromRunId: 'before', toRunId: 'after' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'project', fromRunId: 'before', toRunId: 'after' }] },
  { name: 'canonry_sentiment_backfill_preview', method: 'previewSentimentBackfill', input: { project: 'demo', runIds: ['run'], queryClass: 'non-brand' }, args: ['demo', { mode: 'auto', queryClass: 'non-brand', scope: 'project', runIds: ['run'] }] },
  { name: 'canonry_sentiment_backfill', method: 'submitSentimentBackfill', input: { project: 'demo', previewToken: 'token', idempotencyKey: 'key' }, args: ['demo', { previewToken: 'token', idempotencyKey: 'key' }] },
  { name: 'canonry_sentiment_jobs', method: 'listSentimentJobs', input: { project: 'demo' }, args: ['demo'] },
  { name: 'canonry_sentiment_job', method: 'getSentimentJob', input: { project: 'demo', jobId: 'job' }, args: ['demo', 'job', {}] },
  { name: 'canonry_sentiment_job', method: 'getSentimentJob', input: { project: 'demo', jobId: 'job', attemptLimit: 5, attemptCursor: 'older' }, args: ['demo', 'job', { attemptLimit: 5, attemptCursor: 'older' }] },
]

describe('sentiment MCP parity', () => {
  it.each(cases)('$name delegates exact explicit request fields', async entry => {
    const call = vi.fn().mockResolvedValue(sentimentFixtureSummary)
    const fake = { [entry.method]: call } as unknown as ApiClient
    const spec = tool(entry.name)
    const result = await withToolErrors(() => spec.handler(fake, spec.inputSchema.parse(entry.input)))
    expect(call).toHaveBeenCalledWith(...entry.args)
    expect(result.structuredContent).toEqual(sentimentFixtureSummary)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(sentimentFixtureSummary, null, 2) }])
    expect(spec.tier).toBe('monitoring')
    for (const operation of spec.openApiOperations) expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation as keyof typeof MCP_OPENAPI_OPERATION_CLASSIFICATIONS]).toBe('included')
  })
  it.each([
    { name: 'canonry_sentiment', method: 'getSentiment', extra: {} },
    { name: 'canonry_sentiment_evidence', method: 'getSentimentEvidence', extra: { cursor: 'cursor', limit: 7 } },
  ])('$name preserves grouped run identity and rejects a simultaneous single run', async ({ name, method, extra }) => {
    const runIds = ['run-bayside', 'run-harbor']
    const input = { project: 'demo', runIds, queryClass: 'non-brand', queryId: 'frozen-query', evaluationDefinitionId: 'frozen-definition', ...extra }
    const response = { ...sentimentFixtureSummary, selection: { ...sentimentFixtureSummary.selection, runId: null, runIds } }
    const call = vi.fn().mockResolvedValue(response)
    const spec = tool(name)
    const result = await withToolErrors(() => spec.handler({ [method]: call } as unknown as ApiClient, spec.inputSchema.parse(input)))
    const { project, ...selection } = input
    expect(call).toHaveBeenCalledWith(project, { mode: 'auto', scope: 'project', ...selection })
    expect(result.structuredContent).toEqual(response)
    expect(spec.inputSchema.safeParse({ ...input, runId: 'extra' }).success).toBe(false)
    expect(spec.inputSchema.safeParse({ ...input, runIds: [] }).success).toBe(false)
  })
  it('rejects grouped run selectors for pairwise comparison', () => {
    expect(tool('canonry_sentiment_compare').inputSchema.safeParse({ project: 'demo', fromRunId: 'a', toRunId: 'b', runIds: ['extra'] }).success).toBe(false)
  })
  it.each(['branded', 'non-brand'] as const)('passes one explicit %s query population and preserves per-query results', async queryClass => {
    const summary = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, selection: { ...sentimentFixtureSummary.selection, queryClass, queryId: 'frozen-query' }, queries: [{ queryId: 'frozen-query', queryText: 'Which apartments are good?', queryClass, sourceSnapshotIds: ['frozen-snapshot'], locations: [], assessments: [], state: 'partial', reason: null, provisional: true, coverage: sentimentFixtureSummary.coverage, score: sentimentFixtureSummary.score }] })
    const call = vi.fn().mockResolvedValue(summary)
    const spec = tool('canonry_sentiment')
    const result = await withToolErrors(() => spec.handler({ getSentiment: call } as unknown as ApiClient, spec.inputSchema.parse({ project: 'demo', queryClass, queryId: 'frozen-query' })))
    expect(call).toHaveBeenCalledWith('demo', { mode: 'auto', scope: 'project', queryClass, queryId: 'frozen-query' })
    expect(result.structuredContent).toEqual(summary)
    expect(spec.description).toContain('favorable / (favorable + mixed + unfavorable)')
    expect(spec.description).not.toContain('unsupported')
  })
  it('accepts an exact assessment only on evidence and retains it in the output selection', async () => {
    const spec = tool('canonry_sentiment_evidence')
    const input = { project: 'demo', queryClass: 'non-brand', runId: 'run', provider: 'gemini', model: 'served-v2', location: 'Marina', assessmentId: 'exact-assessment' }
    const response = { selection: { ...input }, items: [], nextCursor: null }
    const call = vi.fn().mockResolvedValue(response)
    const result = await withToolErrors(() => spec.handler({ getSentimentEvidence: call } as unknown as ApiClient, spec.inputSchema.parse(input)))
    const { project, ...selection } = input
    expect(call).toHaveBeenCalledWith(project, { mode: 'auto', scope: 'project', limit: 50, ...selection })
    expect(result.structuredContent).toEqual(response)
    expect(spec.inputSchema.safeParse({ ...input, assessmentId: '' }).success).toBe(false)
    expect(tool('canonry_sentiment').inputSchema.safeParse(input).success).toBe(false)
  })
  it('rejects retired theme configuration and pooled sentiment selections', () => {
    const configure = tool('canonry_sentiment_configure')
    expect(configure.inputSchema.safeParse({ project: 'demo', preset: 'default' }).success).toBe(false)
    expect(configure.inputSchema.safeParse({ project: 'demo', enabled: true, customThemes: [] }).success).toBe(false)
    expect(tool('canonry_sentiment').inputSchema.safeParse({ project: 'demo', queryClass: 'all' }).success).toBe(false)
  })
  it('contains all seven reads and excludes both writes in read-only catalogs', () => {
    const readNames = getCanonryMcpTools('read-only').map(entry => entry.name)
    const names = cases.map(entry => entry.name)
    expect(readNames.filter(name => names.includes(name))).toHaveLength(7)
    expect(readNames).not.toContain('canonry_sentiment_configure')
    expect(readNames).not.toContain('canonry_sentiment_backfill')
  })
  it.each(['canonry_sentiment_configure', 'canonry_sentiment_backfill'])('%s rejects credential fields and incomplete writes', name => {
    expect(tool(name).inputSchema.safeParse({ project: 'demo' }).success).toBe(false)
    expect(tool(name).inputSchema.safeParse({ project: 'demo', enabled: true, apiKey: 'secret' }).success).toBe(false)
  })
  it('rejects unbounded and contradictory preview selections', () => {
    for (const input of [{ project: 'demo' }, { project: 'demo', from: '2026-09-01T00:00:00Z' }, { project: 'demo', runId: 'run', runIds: ['other'] }]) {
      expect(tool('canonry_sentiment_backfill_preview').inputSchema.safeParse({ ...input, queryClass: 'branded' }).success).toBe(false)
    }
  })
  it('requires one explicit query class on backfill preview instead of defaulting to branded', () => {
    const preview = tool('canonry_sentiment_backfill_preview')
    const result = preview.inputSchema.safeParse({ project: 'demo', runIds: ['run'] })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('queryClass')
    for (const queryClass of ['all', 'pooled']) expect(preview.inputSchema.safeParse({ project: 'demo', runIds: ['run'], queryClass }).success).toBe(false)
    expect(preview.inputSchema.parse({ project: 'demo', runIds: ['run'], queryClass: 'branded' }).queryClass).toBe('branded')
    // The advertised input schema carries no branded default for an agent to lean on.
    const properties = (schema: unknown) => (schema as { properties: Record<string, Record<string, unknown>> }).properties
    expect(properties(preview.inputJsonSchema).queryClass).not.toHaveProperty('default')
    expect(properties(tool('canonry_sentiment').inputJsonSchema).queryClass).toMatchObject({ default: 'branded' })
    expect(preview.description).toContain('queryClass (required')
    // The summary read keeps its documented branded default; only the write path's preview is strict.
    expect(tool('canonry_sentiment').inputSchema.parse({ project: 'demo' }).queryClass).toBe('branded')
  })
  it.each(['viewer', 'delegated-viewer', 'project-scoped', 'read-only'])('retains API denial for %s without broadening authority', async credential => {
    const fake = { configureSentiment: vi.fn().mockRejectedValue(new CliError({ code: 'FORBIDDEN', message: 'Install administrator required', details: { credential } })) } as unknown as ApiClient
    const spec = tool('canonry_sentiment_configure')
    const result = await withToolErrors(() => spec.handler(fake, spec.inputSchema.parse({ project: 'demo', enabled: true })))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: { code: 'FORBIDDEN', message: 'Install administrator required', details: { credential } } })
  })
  it('keeps all nine experimental capabilities out of native Aero pending its release gate', () => {
    for (const name of cases.map(entry => entry.name)) expect(AERO_EXCLUDED_MCP_TOOLS.has(name as Parameters<typeof AERO_EXCLUDED_MCP_TOOLS.has>[0])).toBe(true)
  })
})
