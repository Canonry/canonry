import { afterEach, describe, expect, it, vi } from 'vitest'

const { dispatchSpy, nudgeSpy, setupStateSpy } = vi.hoisted(() => ({
  dispatchSpy: vi.fn(async () => true),
  nudgeSpy: vi.fn(() => null),
  setupStateSpy: vi.fn(),
}))

vi.mock('../src/cli-dispatch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli-dispatch.js')>('../src/cli-dispatch.js')
  return { ...actual, dispatchRegisteredCommand: dispatchSpy }
})

vi.mock('../src/setup-nudge.js', async () => {
  const actual = await vi.importActual<typeof import('../src/setup-nudge.js')>('../src/setup-nudge.js')
  return { ...actual, buildSetupNudgeLine: nudgeSpy }
})

vi.mock('../src/setup-state.js', async () => {
  const actual = await vi.importActual<typeof import('../src/setup-state.js')>('../src/setup-state.js')
  return { ...actual, buildSetupState: setupStateSpy }
})

const { runCli } = await import('../src/cli.js')

describe('stored-only CLI housekeeping', () => {
  afterEach(() => {
    delete process.env.CANONRY_STORED_ONLY
    dispatchSpy.mockClear()
    nudgeSpy.mockClear()
    setupStateSpy.mockClear()
  })

  it('does not evaluate the setup nudge for a stored Page Health success', async () => {
    process.env.CANONRY_STORED_ONLY = '1'
    await expect(runCli(['--stored-only', 'site-health', 'overview', 'fixture'])).resolves.toBe(0)
    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(nudgeSpy).not.toHaveBeenCalled()
    expect(setupStateSpy).not.toHaveBeenCalled()
  })
})
