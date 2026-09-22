import { afterAll, expect, it, vi } from 'vitest'
import { Agent } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai'
import { agentViewContextSchema, evaluateAgentTrace, type AgentEvaluationTrace, type AgentVisibilityEvidence } from '@ainyc/canonry-contracts'
import { buildAeroViewTool, readAeroViewEvidence, aeroViewPrompt } from '../src/agent/view-context.js'
import { configureAeroRuntime, aeroTurnStatus } from '../src/agent/runtime.js'
import { aeroEvidenceFixture } from '../../contracts/test/fixtures/aero-evidence.js'
import type { ApiClient } from '../src/client.js'

const faux = registerFauxProvider({ api: 'aero-replay', provider: 'aero-replay', models: [{ id: 'analyst-replay' }] })
afterAll(() => faux.unregister())

it.each(['simple', 'advanced'] as const)('replays %s scope, stale evidence, missing values, separate classes, and incompatible comparisons', async mode => {
  const report = aeroEvidenceFixture(mode)
  const getVisibilityReport = vi.fn(async () => report)
  const context = agentViewContextSchema.parse({ view: 'visibility', selection: { mode, queryClass: 'all', ...(mode === 'advanced' ? { scope: 'property', scopeKey: 'hotel', marketKey: 'london', revision: 3 } : {}), runId: 'run-3' } })
  const options = { client: { getVisibilityReport } as unknown as ApiClient, projectName: 'demo', context, basePath: '/canonry/' }
  const evidence = await readAeroViewEvidence(options) as AgentVisibilityEvidence & { source: { href: string } }
  const agent = new Agent({ initialState: { model: faux.getModel(), systemPrompt: aeroViewPrompt(context) } })
  configureAeroRuntime(agent, [buildAeroViewTool(options, evidence)])
  const trace: AgentEvaluationTrace = { answer: '', tools: [], modelCalls: 0, durationMs: 0 }
  agent.subscribe(event => {
    if (event.type === 'tool_execution_end') trace.tools.push({ name: event.toolName, isError: event.isError })
    if (event.type === 'message_end' && event.message.role === 'assistant') trace.answer += event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('aero_inspect_view', {}), { stopReason: 'toolUse' }),
    modelContext => {
      const toolResult = modelContext.messages.find(message => message.role === 'toolResult')
      expect(toolResult?.content).toEqual([{ type: 'text', text: JSON.stringify(evidence, null, 2) }])
      return fauxAssistantMessage(`Non-brand mentions 0/10; citations 2/10. Branded mentions 10/10. Unknown class unavailable. Measured 2026-08-01. Comparison unavailable: model-changed. Review the saved answers before proposing causes. [Evidence](${evidence.source.href})`)
    },
  ])
  await agent.prompt('Why did this Property drop?')
  const status = aeroTurnStatus(agent)!
  trace.modelCalls = status.modelCalls
  trace.durationMs = status.durationMs
  const result = evaluateAgentTrace(trace, {
    requiredTools: ['aero_inspect_view'], forbiddenTools: ['canonry_run_trigger'],
    requiredText: ['Non-brand mentions 0/10', 'citations 2/10', 'Branded mentions 10/10', 'Unknown class unavailable', 'Measured 2026-08-01', 'model-changed', evidence.source.href],
    forbiddenText: ['50% overall', 'caused by', 'unknown class 0%'], maxToolCalls: 1,
  })
  expect(result.passed).toBe(true)
  expect(result).toMatchObject({ toolCalls: 1, modelCalls: 2 })
  expect(getVisibilityReport).toHaveBeenCalledExactlyOnceWith('demo', context.selection)
})

it('rejects an invalid project-owned scope before generation and reads selected Site Health pages exactly', async () => {
  const getVisibilityReport = vi.fn(async () => { throw new Error('Property does not belong to project') })
  await expect(readAeroViewEvidence({ client: { getVisibilityReport } as unknown as ApiClient, projectName: 'demo', context: agentViewContextSchema.parse({ view: 'property', selection: { scope: 'property', scopeKey: 'foreign' } }) })).rejects.toThrow('Property does not belong')
  const getTechnicalAeoPageAudit = vi.fn(async () => ({ state: 'unavailable', reason: 'not-checked' }))
  const page = { runId: 'scan-7', nodeKey: 'node-9' }
  const result = await readAeroViewEvidence({ client: { getTechnicalAeoPageAudit } as unknown as ApiClient, projectName: 'demo', context: { view: 'site-health', page } })
  expect(getTechnicalAeoPageAudit).toHaveBeenCalledExactlyOnceWith('demo', page)
  expect(result).toMatchObject({ audit: { state: 'unavailable', reason: 'not-checked' } })
})


it('preserves every class denominator when long evidence rows require truncation', async () => {
  const report = aeroEvidenceFixture()
  report.populations[0].evidence.items.push({ answerId: 'a1', queryKey: 'q1', runId: 'run-3', query: 'x'.repeat(100_000), provider: 'openai', model: null, location: null, targetKeys: ['hotel'], mentioned: null, cited: false, answerText: 'huge answer', sources: [], observedCompetitors: [], createdAt: '2026-08-01T00:00:00.000Z' })
  const tool = buildAeroViewTool({ client: { getVisibilityReport: async () => report } as unknown as ApiClient, projectName: 'demo' })
  const result = await tool.execute('inspect', {})
  const text = result.content.find(block => block.type === 'text')!.text
  const packed = JSON.parse(text)
  expect(packed.__truncated).toBe(true)
  expect(packed.observations).toEqual([])
  expect(packed.populations.map((population: { summary: { mentionCoverage: unknown } }) => population.summary.mentionCoverage)).toEqual(report.populations.map(population => population.summary.mentionCoverage))
  expect(packed.populations[0].evidence).toMatchObject({ total: 10, nextCursor: 'evidence-page-2' })
})
