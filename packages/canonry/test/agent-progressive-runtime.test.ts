import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import { Type, fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai'
import { registerAeroFaux } from './helpers/aero-faux.js'
import { aeroStreamFn } from '../src/agent/pi-models.js'
import { configureAeroRuntime, aeroTurnStatus, MAX_VISIBLE_TOOLS } from '../src/agent/runtime.js'
import { buildAllTools, buildReadTools } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'

const faux = registerAeroFaux({ api: 'aero-progressive-test', provider: 'aero-progressive-test', models: [{ id: 'test' }] })
afterEach(() => { vi.useRealTimers() })
afterAll(() => faux.unregister())

describe('Aero progressive tool execution', () => {
  it('loads schemas into the running loop before the next model request without widening read scope', async () => {
    const getInsights = vi.fn(async () => [])
    const allowed = buildReadTools({ client: { getInsights } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed)
    const initialNames = agent.state.tools.map(tool => tool.name)
    expect(initialNames).toContain('aero_load_toolkit')
    expect(initialNames).not.toContain('canonry_insights_list')
    expect(initialNames).not.toContain('canonry_run_trigger')
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('aero_load_toolkit', { toolkit: 'monitoring' }), { stopReason: 'toolUse' }),
      context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain('canonry_insights_list')
        expect(getCurrentTools(context.messages).map(tool => tool.name)).not.toContain('canonry_run_trigger')
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, true, ['canonry_measurement_portfolio_summary'])
    const names = agent.state.tools.map(tool => tool.name)
    expect(names).toContain('canonry_measurement_portfolio_summary')
    expect(names).not.toContain('canonry_insights_list')
  })

  it('points an eager turn at its own list instead of a toolkit tool it does not have', async () => {
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, { maxToolCalls: 100, timeoutMs: 10_000 })
    const kits = ((await agent.state.tools.find(tool => tool.name === 'aero_list_toolkits')!.execute('list', {})).details as Array<{ name: string }>).map(kit => kit.name)
    faux.setResponses([
      fauxAssistantMessage(kits.map((toolkit, index) => fauxToolCall('aero_load_toolkit', { toolkit }, { id: `load-${index}` })), { stopReason: 'toolUse' }),
      context => {
        expect(getCurrentTools(context.messages).length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS)
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Load every toolkit')
    expect(agent.state.tools.length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS)
  })

  it('stops before executing calls beyond the limit, including multiple calls in one model response', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], details: {} }))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [{ name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute }], { maxToolCalls: 1, timeoutMs: 1000 })
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall('check', {}, { id: 'first' }), fauxToolCall('check', {}, { id: 'second' }),
    ], { stopReason: 'toolUse' }), fauxAssistantMessage('One check ran.')])
    await agent.prompt('Check twice')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 1 })
  })

  it('reports a failed wrap-up request as an error, not a clean tool-limit stop', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], details: {} }))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [{ name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute }], { maxToolCalls: 1, timeoutMs: 1000 })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('check', {}, { id: 'first' }), fauxToolCall('check', {}, { id: 'second' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Provider unavailable' }),
    ])
    await agent.prompt('Check twice')
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'error', toolCalls: 1, modelCalls: 2 })
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain('could not complete the answer')
  })

  it('reports a wrap-up the user stopped as stopped', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], details: {} }))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [{ name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute }], { maxToolCalls: 1, timeoutMs: 1000 })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('check', {}, { id: 'first' }), fauxToolCall('check', {}, { id: 'second' })], { stopReason: 'toolUse' }),
      () => {
        agent.abort()
        return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Request was aborted' })
      },
    ])
    await agent.prompt('Check twice')
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'stopped', toolCalls: 1 })
  })

  it('supplies a trusted UTC clock per turn without persisting it or changing the stable system prefix', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const firstTime = '2030-12-31T23:59:55.000Z'
    const nextTime = '2031-01-01T00:00:05.000Z'
    vi.setSystemTime(new Date(firstTime))
    const execute = vi.fn(async () => {
      vi.setSystemTime(new Date(nextTime))
      return { content: [{ type: 'text' as const, text: 'Stored evidence read.' }], details: {} }
    })
    const agent = new Agent({ initialState: { model: faux.getModel(), systemPrompt: 'Stable synthetic system instructions.' }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [{ name: 'check', label: 'Check', description: 'Synthetic stored read', parameters: Type.Object({}), execute }], undefined, false)
    const requests: Array<{ prefix: string; index: number; priorSystems: boolean; clock: string; text: string; lastRole?: string }> = []
    const capture = (context: { messages: readonly { role: string }[] }) => {
      const index = context.messages.findIndex(message => message.role === 'system' && JSON.stringify(message).includes('Current turn clock (UTC):'))
      requests.push({
        prefix: JSON.stringify(context.messages[0]), index,
        priorSystems: context.messages.slice(0, index).every(message => message.role === 'system'),
        clock: JSON.stringify(context.messages[index]) ?? '', text: JSON.stringify(context.messages), lastRole: context.messages.at(-1)?.role,
      })
    }
    faux.setResponses([
      context => {
        capture(context)
        return fauxAssistantMessage(fauxToolCall('check', {}), { stopReason: 'toolUse' })
      },
      context => {
        capture(context)
        return fauxAssistantMessage('The current turn clock stayed fixed.')
      },
    ])
    await agent.prompt('Inspect stored evidence')
    expect(requests[0]?.clock).toContain(firstTime)
    expect(requests[0]?.prefix).toContain('Stable synthetic system instructions.')
    expect(requests[0]?.index).toBeGreaterThan(0)
    expect(requests[0]?.priorSystems).toBe(true)
    expect(requests[0]?.clock).toContain('unless the user explicitly specifies a year')
    expect(requests[0]?.clock).toContain('Stored run and scan dates remain authoritative')
    expect(requests[1]?.clock).toContain(firstTime)
    expect(requests[1]?.text).not.toContain(nextTime)
    expect(requests[1]?.lastRole).toBe('toolResult')
    expect(JSON.stringify(agent.state.messages)).not.toContain(firstTime)
    faux.setResponses([context => {
      capture(context)
      return fauxAssistantMessage('The new turn uses the new year.')
    }])
    await agent.prompt('Preview September without a year')
    expect(requests[2]?.clock).toContain(nextTime)
    expect(requests[2]?.text).not.toContain(firstTime)
    expect(JSON.stringify(agent.state.messages)).not.toContain(nextTime)
  })

  it('reserves time for one answer without tools when research times out', async () => {
    vi.useFakeTimers()
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [], { maxToolCalls: 3, timeoutMs: 1000 })
    faux.setResponses([async (_context, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return fauxAssistantMessage('', { stopReason: 'aborted' })
    }, context => {
      expect(getCurrentTools(context.messages)).toEqual([])
      expect(JSON.stringify(context.messages.at(-1))).toContain('research time budget')
      return fauxAssistantMessage('No evidence was gathered before the time limit.')
    }, fauxAssistantMessage('Never requested.')])
    const prompt = agent.prompt('Wait')
    await vi.advanceTimersByTimeAsync(1001)
    await prompt
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'time-limit', toolCalls: 0, modelCalls: 2 })
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'No evidence was gathered before the time limit.' }] })
    expect(faux.getPendingResponseCount()).toBe(1)
  })

  it('finishes with an explicit partial-answer message if the reserved answer budget also expires', async () => {
    vi.useFakeTimers()
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, [], { maxToolCalls: 3, timeoutMs: 1000 })
    const wait = async (_context: unknown, options?: { signal?: AbortSignal }) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return fauxAssistantMessage('', { stopReason: 'aborted' })
    }
    faux.setResponses([wait, wait])
    const prompt = agent.prompt('Wait')
    await vi.advanceTimersByTimeAsync(1001)
    await prompt
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'time-limit', modelCalls: 2 })
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain('could not complete the answer')
  })

  it('does not memoize live provider reads or failed stored reads', async () => {
    const gscSitemaps = vi.fn(async () => ({ sitemaps: [] }))
    const getAdsLiveDelivery = vi.fn(async () => ({ campaigns: [] }))
    const getInsights = vi.fn().mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValue([])
    const allowed = buildReadTools({ client: { gscSitemaps, getAdsLiveDelivery, getInsights } as unknown as ApiClient, projectName: 'demo' }).filter(tool => ['canonry_gsc_sitemaps', 'canonry_ads_live_delivery', 'canonry_insights_list'].includes(tool.name))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    faux.setResponses([
      ...['canonry_gsc_sitemaps', 'canonry_gsc_sitemaps', 'canonry_ads_live_delivery', 'canonry_ads_live_delivery', 'canonry_insights_list', 'canonry_insights_list'].map((name, index) => fauxAssistantMessage(fauxToolCall(name, {}, { id: `read-${index}` }), { stopReason: 'toolUse' })),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Retry reads')
    expect(gscSitemaps).toHaveBeenCalledTimes(2)
    expect(getAdsLiveDelivery).toHaveBeenCalledTimes(2)
    expect(getInsights).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'canonry_sentiment_jobs', params: {}, list: true },
    { name: 'canonry_sentiment_job', params: { jobId: 'job-1' }, list: false },
  ])('refreshes $name when a stored job finishes between polls', async ({ name, params, list }) => {
    let state = 'running'
    const read = vi.fn(async () => {
      const job = { id: 'job-1', state }
      return list ? { jobs: [job] } : job
    })
    const client = { listSentimentJobs: read, getSentimentJob: read } as unknown as ApiClient
    const allowed = buildReadTools({ client, projectName: 'demo' }).filter(tool => tool.name === name)
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, params, { id: 'first-poll' }), { stopReason: 'toolUse' }),
      () => {
        state = 'complete'
        return fauxAssistantMessage(fauxToolCall(name, params, { id: 'second-poll' }), { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('The stored job has completed.'),
    ])
    await agent.prompt('Check the job until it finishes')
    const polls = agent.state.messages.filter(message => message.role === 'toolResult')
    expect(JSON.stringify(polls[0])).toContain('"state":"running"')
    expect(JSON.stringify(polls[1])).toContain('"state":"complete"')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'canonry_measurement_overview', method: 'getMeasurementOverview', owner: 'properties', field: 'nextCursor', parameter: 'cursor', size: 'limit', params: { scope: 'all', queryClass: 'non-brand', compact: true } },
    { name: 'canonry_measurement_portfolio_summary', method: 'getMeasurementPortfolioSummary', owner: '', field: 'nextCursor', parameter: 'cursor', size: 'limit', params: { queryClass: 'non-brand', compact: true } },
    { name: 'canonry_sentiment', method: 'getSentiment', owner: 'queryPage', field: 'nextCursor', parameter: 'queryCursor', size: 'queryLimit', params: { mode: 'auto', queryClass: 'branded', scope: 'project' } },
    { name: 'canonry_sentiment_job', method: 'getSentimentJob', owner: '', field: 'nextAttemptCursor', parameter: 'attemptCursor', size: 'attemptLimit', params: { jobId: 'job-1' } },
  ])('continues $name using a short page reference while preserving the native API cursor and selection', async ({ name, method, owner, field, parameter, size, params }) => {
    const cursor = 'opaque-native-cursor-'.repeat(30)
    const rows = [{ id: 'first-row' }]
    const first = owner === 'properties' ? { properties: { items: rows, totalEstimate: 2, nextCursor: cursor } }
      : owner === 'queryPage' ? { queries: rows, queryPage: { total: 2, limit: 2, nextCursor: cursor } }
        : field === 'nextAttemptCursor' ? { attempts: rows, attemptCount: 2, nextAttemptCursor: cursor }
          : { weakestProperties: rows, totalProperties: 2, nextCursor: cursor }
    const last = structuredClone(first) as Record<string, unknown>
    const lastOwner = (owner ? last[owner] : last) as Record<string, unknown>
    lastOwner[field] = null
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(last)
    const client = { [method]: read } as unknown as ApiClient
    const allowed = buildReadTools({ client, projectName: 'demo' }).filter(tool => tool.name === name)
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    let reference = ''
    const initialParams: Record<string, unknown> = { ...params }
    if (name === 'canonry_measurement_portfolio_summary') delete initialParams.compact
    if (name === 'canonry_sentiment') delete initialParams.mode
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, { ...initialParams, [size]: 2 }, { id: 'first-page' }), { stopReason: 'toolUse' }),
      context => {
        const result = context.messages.at(-1) as { content: Array<{ text: string }> }
        const shown = JSON.parse(result.content[0]!.text)
        reference = (owner ? shown[owner] : shown)[field]
        return fauxAssistantMessage(fauxToolCall(name, { [size]: 1, [parameter]: reference, ...(name === 'canonry_measurement_portfolio_summary' ? { compact: true } : {}) }), { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('Both pages read.'),
    ])
    await agent.prompt('Read every page')
    expect(reference.length).toBeLessThan(60)
    expect(read).toHaveBeenCalledTimes(2)
    const { jobId: _jobId, ...jobQuery } = params as Record<string, unknown>
    const query = { ...(method === 'getSentimentJob' ? jobQuery : params), [size]: 1, [parameter]: cursor }
    expect(read.mock.calls[1]).toEqual(method === 'getSentimentJob' ? ['demo', 'job-1', query] : ['demo', query])
    const original = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'first-page') as { details: unknown; content: Array<{ text: string }> }
    expect(original.details).toBe(first)
    expect(original.content[0]!.text).not.toContain(cursor)
  })

  it('rejects another tool, changed filters and a previous turn when resolving page references', async () => {
    const cursor = 'native-cursor-'.repeat(40)
    const getMeasurementPortfolioSummary = vi.fn().mockResolvedValue({ items: [{ id: 'row' }], total: 2, nextCursor: cursor })
    const getMeasurementOverview = vi.fn().mockResolvedValue({ properties: { items: [], nextCursor: null } })
    const allowed = buildReadTools({ client: { getMeasurementPortfolioSummary, getMeasurementOverview } as unknown as ApiClient, projectName: 'demo' }).filter(tool => ['canonry_measurement_portfolio_summary', 'canonry_measurement_overview'].includes(tool.name))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    let reference = ''
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_measurement_portfolio_summary', { queryClass: 'non-brand', compact: true, limit: 2 }), { stopReason: 'toolUse' }),
      context => {
        reference = JSON.parse((context.messages.at(-1) as { content: Array<{ text: string }> }).content[0]!.text).nextCursor
        return fauxAssistantMessage(fauxToolCall('canonry_measurement_overview', { scope: 'all', queryClass: 'non-brand', compact: true, cursor: reference }, { id: 'wrong-tool' }), { stopReason: 'toolUse' })
      },
      () => fauxAssistantMessage(fauxToolCall('canonry_measurement_portfolio_summary', { queryClass: 'branded', compact: true, cursor: reference }, { id: 'changed-filter' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('The original selection must be preserved.'),
    ])
    await agent.prompt('Read with a changed selection')
    expect(getMeasurementPortfolioSummary).toHaveBeenCalledTimes(1)
    expect(getMeasurementOverview).not.toHaveBeenCalled()
    for (const id of ['wrong-tool', 'changed-filter']) {
      const rejected = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === id)
      expect(rejected).toMatchObject({ isError: true })
      expect(JSON.stringify(rejected)).toContain('same tool and original filters')
    }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_measurement_portfolio_summary', { queryClass: 'non-brand', compact: true, cursor: reference }, { id: 'stale-reference' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Read the first page again.'),
    ])
    await agent.prompt('Continue the prior turn')
    expect(getMeasurementPortfolioSummary).toHaveBeenCalledTimes(1)
    const stale = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'stale-reference')
    expect(stale).toMatchObject({ isError: true })
    expect(JSON.stringify(stale)).toContain('no longer available')
  })

  it('keeps the original page reference usable for a smaller retry when Aero cuts the next page', async () => {
    const cursor = 'native-first-page-'.repeat(30)
    const unsafeCursor = 'native-after-cut-page-'.repeat(30)
    const first = { properties: { items: [{ targetKey: 'first' }], totalEstimate: 202, nextCursor: cursor } }
    const rows = Array.from({ length: 200 }, (_, index) => ({ targetKey: `property-${index}`, evidence: 'synthetic'.repeat(120) }))
    const cut = { properties: { items: rows, totalEstimate: 202, nextCursor: unsafeCursor } }
    const getMeasurementOverview = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(cut).mockResolvedValueOnce({ properties: { items: [rows[0]], totalEstimate: 202, nextCursor: null } })
    const allowed = buildReadTools({ client: { getMeasurementOverview } as unknown as ApiClient, projectName: 'demo' }).filter(tool => tool.name === 'canonry_measurement_overview')
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    let reference = ''
    let second: { __truncated?: boolean; properties?: { nextCursor?: unknown }; __truncation?: { cursors?: Record<string, string> } } = {}
    const selection = { scope: 'all', queryClass: 'non-brand', compact: true }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_measurement_overview', { ...selection, limit: 50 }), { stopReason: 'toolUse' }),
      context => {
        reference = JSON.parse((context.messages.at(-1) as { content: Array<{ text: string }> }).content[0]!.text).properties.nextCursor
        return fauxAssistantMessage(fauxToolCall('canonry_measurement_overview', { ...selection, limit: 50, cursor: reference }), { stopReason: 'toolUse' })
      },
      context => {
        second = JSON.parse((context.messages.at(-1) as { content: Array<{ text: string }> }).content[0]!.text)
        return fauxAssistantMessage(fauxToolCall('canonry_measurement_overview', { ...selection, limit: 1, cursor: reference }), { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('The smaller page was read.'),
    ])
    await agent.prompt('Retry any incomplete page')
    expect(reference.length).toBeLessThan(60)
    expect(second.__truncated).toBe(true)
    expect(second.properties?.nextCursor).toBe(unsafeCursor)
    expect(second.__truncation?.cursors?.['properties.nextCursor']).toContain('re-request the original cursor')
    expect(getMeasurementOverview.mock.calls.slice(1)).toEqual([
      ['demo', { ...selection, limit: 50, cursor }],
      ['demo', { ...selection, limit: 1, cursor }],
    ])
  })

  it('reuses identical stored reads within one turn but refetches after a write and on the next turn', async () => {
    const getInsights = vi.fn(async () => [{ id: 'insight-1', title: 'Synthetic signal' }])
    const dismissInsight = vi.fn(async () => ({ dismissed: true }))
    const client = { getInsights, dismissInsight } as unknown as ApiClient
    const allowed = buildAllTools({ client, projectName: 'demo' }).filter(tool => ['canonry_insights_list', 'canonry_insight_dismiss'].includes(tool.name))
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed, undefined, false)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}, { id: 'first' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}, { id: 'repeat' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('canonry_insight_dismiss', { insightId: 'insight-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Read, dismiss, and read again')
    const repeated = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'repeat')
    expect(JSON.stringify(repeated)).toContain('Already returned above')
    expect(dismissInsight).toHaveBeenCalledTimes(1)
    expect(getInsights).toHaveBeenCalledTimes(2)
    configureAeroRuntime(agent, allowed, undefined, false)
    faux.setResponses([fauxAssistantMessage(fauxToolCall('canonry_insights_list', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('Done.')])
    await agent.prompt('Read again')
    expect(getInsights).toHaveBeenCalledTimes(3)
  })

})


it('counts malformed tool attempts and reports provider failure distinctly', async () => {
  const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
  configureAeroRuntime(agent, [], { maxToolCalls: 1, timeoutMs: 1000 })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('nonexistent', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('nonexistent', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Nothing could be checked.'),
  ])
  await agent.prompt('Try an invalid tool')
  // The third request is the tool-less wrap-up answer.
  expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 1, modelCalls: 3 })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
    configureAeroRuntime(agent, allowed)
    const { results } = watch(agent)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('aero_load_tolkit', { toolkit: 'monitoring' }), { stopReason: 'toolUse' }),
      context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain('canonry_insights_list')
        return fauxAssistantMessage('Done.')
      },
    ])
    await agent.prompt('Load monitoring')
    expect(results[0]).toMatchObject({ toolName: 'aero_load_toolkit', isError: false, aeroRequestedToolName: 'aero_load_tolkit' })
  })

  it('names the exact tool and its toolkit when the close match is allowed but not loaded', async () => {
    const getInsights = vi.fn(async () => [])
    const allowed = buildReadTools({ client: { getInsights } as unknown as ApiClient, projectName: 'demo' })
    const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn: aeroStreamFn })
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
