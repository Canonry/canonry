import { describe, expect, it, vi } from 'vitest'
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
  { name: 'canonry_sentiment_evidence', method: 'getSentimentEvidence', input: { project: 'demo', scope: 'property', scopeKey: 'property', marketKey: 'market', evaluationDefinitionId: 'def', cursor: 'cursor' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'property', scopeKey: 'property', marketKey: 'market', evaluationDefinitionId: 'def', cursor: 'cursor', limit: 50 }] },
  { name: 'canonry_sentiment_compare', method: 'compareSentiment', input: { project: 'demo', fromRunId: 'before', toRunId: 'after' }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'project', fromRunId: 'before', toRunId: 'after' }] },
  { name: 'canonry_sentiment_backfill_preview', method: 'previewSentimentBackfill', input: { project: 'demo', runIds: ['run'] }, args: ['demo', { mode: 'auto', queryClass: 'branded', scope: 'project', runIds: ['run'] }] },
  { name: 'canonry_sentiment_backfill', method: 'submitSentimentBackfill', input: { project: 'demo', previewToken: 'token', idempotencyKey: 'key' }, args: ['demo', { previewToken: 'token', idempotencyKey: 'key' }] },
  { name: 'canonry_sentiment_jobs', method: 'listSentimentJobs', input: { project: 'demo' }, args: ['demo'] },
  { name: 'canonry_sentiment_job', method: 'getSentimentJob', input: { project: 'demo', jobId: 'job' }, args: ['demo', 'job'] },
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
      expect(tool('canonry_sentiment_backfill_preview').inputSchema.safeParse(input).success).toBe(false)
    }
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
