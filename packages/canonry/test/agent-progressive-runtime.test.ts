import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai'
import { Type } from '@sinclair/typebox'
import { configureAeroRuntime, aeroTurnStatus } from '../src/agent/runtime.js'
import { buildReadTools } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'

const faux = registerFauxProvider({ api: 'aero-progressive-test', provider: 'aero-progressive-test', models: [{ id: 'test' }] })
afterEach(() => { vi.useRealTimers() })
afterAll(() => faux.unregister())

describe('Aero progressive tool execution', () => {
  it('loads schemas into the running loop before the next model request without widening read scope', async () => {
    const getInsights = vi.fn(async () => [])
    const allowed = buildReadTools({ client: { getInsights } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed)
    const initialNames = agent.state.tools.map(tool => tool.name)
    expect(initialNames).toContain('aero_load_toolkit')
    expect(initialNames).not.toContain('canonry_insights_list')
    expect(initialNames).not.toContain('canonry_run_trigger')
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('aero_load_toolkit', { toolkit: 'monitoring' }), { stopReason: 'toolUse' }),
      context => {
        expect(context.tools?.map(tool => tool.name)).toContain('canonry_insights_list')
        expect(context.tools?.map(tool => tool.name)).not.toContain('canonry_run_trigger')
        return fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}), { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('No active insights.'),
    ])
    await agent.prompt('Check active insights')
    expect(getInsights).toHaveBeenCalledWith('demo', {})
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'completed', toolCalls: 2, modelCalls: 3 })
    // A new turn starts from its own allowed set; yesterday's loaded tools do not survive.
    configureAeroRuntime(agent, allowed.filter(tool => tool.name !== 'canonry_insights_list'))
    expect(agent.state.tools.map(tool => tool.name)).not.toContain('canonry_insights_list')
  })

  it('tells the model which toolkit to load when it calls an allowed tool that is not loaded yet', async () => {
    const getInsights = vi.fn(async () => [])
    const allowed = buildReadTools({ client: { getInsights } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}), { stopReason: 'toolUse' }),
      context => {
        const hint = context.messages.at(-1) as { role: string; content: Array<{ text: string }> }
        expect(hint.role).toBe('toolResult')
        expect(hint.content[0]!.text).toBe('canonry_insights_list is not loaded yet. Call aero_load_toolkit with toolkit "monitoring", then call canonry_insights_list again.')
        return fauxAssistantMessage(fauxToolCall('canonry_run_trigger', {}), { stopReason: 'toolUse' })
      },
      context => {
        const refusal = context.messages.at(-1) as { content: Array<{ text: string }> }
        expect(refusal.content[0]!.text).toBe('canonry_run_trigger is not available in this conversation. Use aero_list_toolkits to see the tools you can load.')
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Check active insights')
    expect(getInsights).not.toHaveBeenCalled()
  })

  it('stops before executing calls beyond the limit, including multiple calls in one model response', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], details: {} }))
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [{ name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute }], { maxToolCalls: 1, timeoutMs: 1000 })
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall('check', {}, { id: 'first' }), fauxToolCall('check', {}, { id: 'second' }),
    ], { stopReason: 'toolUse' })])
    await agent.prompt('Check twice')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 1 })
  })

  it('aborts a slow provider at the time limit', async () => {
    vi.useFakeTimers()
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [], { maxToolCalls: 3, timeoutMs: 1000 })
    faux.setResponses([async (_context, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return fauxAssistantMessage('Stopped', { stopReason: 'aborted' })
    }])
    const prompt = agent.prompt('Wait')
    await vi.advanceTimersByTimeAsync(1001)
    await prompt
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'time-limit', toolCalls: 0 })
  })
})


it('counts malformed tool attempts and reports provider failure distinctly', async () => {
  const agent = new Agent({ initialState: { model: faux.getModel() } })
  configureAeroRuntime(agent, [], { maxToolCalls: 1, timeoutMs: 1000 })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('nonexistent', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('nonexistent', {}), { stopReason: 'toolUse' }),
  ])
  await agent.prompt('Try an invalid tool')
  expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 1, modelCalls: 2 })
  configureAeroRuntime(agent, [])
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Provider unavailable' })])
  await agent.prompt('Try again')
  expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'error', toolCalls: 0, modelCalls: 1 })
})
