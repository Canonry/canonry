import { describe, it, expect } from 'vitest'
import { createAeroAgent } from '../src/agent/pi-runtime.js'

describe('createAeroAgent', () => {
  it('constructs an Agent with empty default state', () => {
    const agent = createAeroAgent({ projectName: 'test-project' })

    expect(agent.state.tools).toEqual([])
    expect(agent.state.messages).toEqual([])
    expect(agent.state.isStreaming).toBe(false)
    expect(agent.state.pendingToolCalls.size).toBe(0)
    expect(agent.state.errorMessage).toBeUndefined()
  })

  it('respects initialState when provided', () => {
    const systemPrompt = 'You are Aero, an AEO analyst.'
    const agent = createAeroAgent({
      projectName: 'test-project',
      initialState: { systemPrompt },
    })

    expect(agent.state.systemPrompt).toBe(systemPrompt)
  })

  it('subscribes to events and returns an unsubscribe function', () => {
    const agent = createAeroAgent({ projectName: 'test-project' })
    const listener = (): void => {}

    const unsub = agent.subscribe(listener)

    expect(typeof unsub).toBe('function')
    unsub()
  })
})
