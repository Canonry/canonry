import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai'
import { Type } from '@sinclair/typebox'
import { configureAeroRuntime, aeroTurnStatus, MAX_VISIBLE_TOOLS } from '../src/agent/runtime.js'
import { buildAllTools, buildReadTools } from '../src/agent/tools.js'
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

  it('keeps pinned tools visible without loading their toolkit', () => {
    const allowed = buildReadTools({ client: {} as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed, undefined, true, ['canonry_measurement_portfolio_summary'])
    const names = agent.state.tools.map(tool => tool.name)
    expect(names).toContain('canonry_measurement_portfolio_summary')
    expect(names).not.toContain('canonry_insights_list')
  })

  it('points an eager turn at its own list instead of a toolkit tool it does not have', async () => {
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [], undefined, false)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}), { stopReason: 'toolUse' }),
      context => {
        const hint = context.messages.at(-1) as { content: Array<{ text: string }> }
        expect(hint.content[0]!.text).toBe('canonry_insights_list is not available in this conversation. Use only the tools listed for you.')
        expect(hint.content[0]!.text).not.toContain('aero_list_toolkits')
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Check active insights')
  })

  it('never lets loaded toolkits carry a request past the function limit', async () => {
    const allowed = buildAllTools({ client: {} as ApiClient, projectName: 'demo' })
    expect(allowed.length).toBeGreaterThan(MAX_VISIBLE_TOOLS)
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed, { maxToolCalls: 100, timeoutMs: 10_000 })
    const kits = ((await agent.state.tools.find(tool => tool.name === 'aero_list_toolkits')!.execute('list', {})).details as Array<{ name: string }>).map(kit => kit.name)
    faux.setResponses([
      fauxAssistantMessage(kits.map((toolkit, index) => fauxToolCall('aero_load_toolkit', { toolkit }, { id: `load-${index}` })), { stopReason: 'toolUse' }),
      context => {
        expect(context.tools!.length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS)
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Load every toolkit')
    expect(agent.state.tools.length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS)
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

describe('misspelled tool names', () => {
  function fakeTool(name: string) {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: `${name} ran` }], details: {} }))
    return { execute, tool: { name, label: name, description: 'Test', parameters: Type.Object({ limit: Type.Optional(Type.Number()) }), execute } }
  }

  function watch(agent: Agent) {
    const starts: string[] = []
    const results: Array<{ toolName: string; isError: boolean; content: Array<{ text: string }>; aeroRequestedToolName?: string }> = []
    agent.subscribe(event => {
      if (event.type === 'tool_execution_start') starts.push(event.toolName)
      if (event.type === 'message_end' && event.message.role === 'toolResult') results.push(event.message as never)
    })
    return { starts, results }
  }

  it('runs the visible tool a transposed prefix meant, and records the name the model wrote', async () => {
    const changes = fakeTool('canonry_measurement_changes')
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [changes.tool], undefined, true, ['canonry_measurement_changes'])
    const { starts, results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canrony_measurement_changes', { limit: 5 }), { stopReason: 'toolUse' }),
      context => {
        // The next request replays the call under the name that ran.
        const call = context.messages.flatMap(message => message.role === 'assistant' ? message.content : []).find(block => block.type === 'toolCall')
        expect(call).toMatchObject({ name: 'canonry_measurement_changes' })
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('What changed?')
    expect(changes.execute).toHaveBeenCalledTimes(1)
    expect(changes.execute.mock.calls[0]![1]).toEqual({ limit: 5 })
    expect(starts).toEqual(['canonry_measurement_changes'])
    expect(results[0]).toMatchObject({ toolName: 'canonry_measurement_changes', isError: false, aeroRequestedToolName: 'canrony_measurement_changes' })
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'completed', toolCalls: 1 })
  })

  it('runs the tool a dropped letter meant on an eager turn', async () => {
    const changes = fakeTool('canonry_measurement_changes')
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [changes.tool, fakeTool('canonry_measurement_overview').tool], undefined, false)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_measurement_chages', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('What changed?')
    expect(changes.execute).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({ toolName: 'canonry_measurement_changes', isError: false, aeroRequestedToolName: 'canonry_measurement_chages' })
  })

  it('does not guess between two close names, and lists both', async () => {
    const get = fakeTool('harbor_report_get')
    const set = fakeTool('harbor_report_set')
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [get.tool, set.tool], undefined, false)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('harbor_report_st', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Read the report')
    expect(get.execute).not.toHaveBeenCalled()
    expect(set.execute).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ toolName: 'harbor_report_st', isError: true })
    expect(results[0]!.aeroRequestedToolName).toBeUndefined()
    expect(results[0]!.content[0]!.text).toBe('harbor_report_st is not a tool. Did you mean one of: harbor_report_get, harbor_report_set? Call the one you meant by its exact name.')
  })

  it('keeps the plain refusal for a name close to no tool', async () => {
    const changes = fakeTool('canonry_measurement_changes')
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [changes.tool], undefined, false)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_market_movers', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('What changed?')
    expect(changes.execute).not.toHaveBeenCalled()
    expect(results[0]!.content[0]!.text).toBe('canonry_market_movers is not available in this conversation. Use only the tools listed for you.')
  })

  it('never renames a misspelling to a write tool, and makes the model name the write exactly', async () => {
    const fillRun = vi.fn(async () => ({}))
    const allowed = buildAllTools({ client: { fillRun } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed, undefined, false)
    const { starts, results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_run_fills', { runId: 'run-1' }), { stopReason: 'toolUse' }),
      context => {
        // The call is replayed under the name the model wrote, not the write it was close to.
        const call = context.messages.flatMap(message => message.role === 'assistant' ? message.content : []).find(block => block.type === 'toolCall')
        expect(call).toMatchObject({ name: 'canonry_run_fills' })
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Fill the run')
    expect(fillRun).not.toHaveBeenCalled()
    expect(starts).toEqual(['canonry_run_fills'])
    expect(results[0]).toMatchObject({ toolName: 'canonry_run_fills', isError: true })
    expect(results[0]!.aeroRequestedToolName).toBeUndefined()
    expect(results[0]!.content[0]!.text).toBe('canonry_run_fills is not a tool. Did you mean canonry_run_fill? Call it again by that exact name.')
  })

  it('treats a tool whose access is unknown as a write and does not rename to it', async () => {
    const publish = fakeTool('harbor_report_publish')
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, [publish.tool], undefined, false)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('harbor_report_publsh', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Publish the report')
    expect(publish.execute).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ toolName: 'harbor_report_publsh', isError: true })
    expect(results[0]!.content[0]!.text).toBe('harbor_report_publsh is not a tool. Did you mean harbor_report_publish? Call it again by that exact name.')
  })

  it('still renames a misspelled read when the full catalog, writes included, is visible', async () => {
    const getRunCompleteness = vi.fn(async () => ({}))
    const fillRun = vi.fn(async () => ({}))
    const allowed = buildAllTools({ client: { getRunCompleteness, fillRun } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed, undefined, false)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_run_completness', { runId: 'run-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Is the run complete?')
    expect(getRunCompleteness).toHaveBeenCalledWith('run-1')
    expect(fillRun).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ toolName: 'canonry_run_completeness', isError: false, aeroRequestedToolName: 'canonry_run_completness' })
  })

  it('renames a misspelled toolkit load, which only changes what is visible', async () => {
    const allowed = buildReadTools({ client: {} as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('aero_load_tolkit', { toolkit: 'monitoring' }), { stopReason: 'toolUse' }),
      context => {
        expect(context.tools?.map(tool => tool.name)).toContain('canonry_insights_list')
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Load monitoring')
    expect(results[0]).toMatchObject({ toolName: 'aero_load_toolkit', isError: false, aeroRequestedToolName: 'aero_load_tolkit' })
  })

  it('names the exact tool and its toolkit when the close match is allowed but not loaded', async () => {
    const getInsights = vi.fn(async () => [])
    const allowed = buildReadTools({ client: { getInsights } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() } })
    configureAeroRuntime(agent, allowed)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_insigths_list', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Check active insights')
    expect(getInsights).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ toolName: 'canonry_insigths_list', isError: true })
    expect(results[0]!.content[0]!.text).toBe('canonry_insigths_list is not a tool. Did you mean canonry_insights_list? Call aero_load_toolkit with toolkit "monitoring", then call canonry_insights_list.')
  })
})
