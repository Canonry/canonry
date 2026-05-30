import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest'

// Dispatch is stubbed so runCli returns immediately without touching the API.
vi.mock('../src/cli-dispatch.js', () => ({
  dispatchRegisteredCommand: vi.fn().mockResolvedValue(true),
}))

// The update check is the fire-and-forget stderr banner under test.
const mockCheckLatestVersionForCli = vi.fn().mockResolvedValue(null)
vi.mock('../src/update-check.js', () => ({
  checkLatestVersionForCli: mockCheckLatestVersionForCli,
  checkLatestVersionForServer: vi.fn().mockReturnValue(null),
  isUpdateCheckEnabled: vi.fn().mockReturnValue(true),
}))

const { runCli } = await import('../src/cli.js')

describe('update banner is gated on an interactive stderr', () => {
  let origIsTTY: boolean | undefined

  beforeEach(() => {
    origIsTTY = process.stderr.isTTY
    mockCheckLatestVersionForCli.mockClear()
  })

  afterEach(() => {
    process.stderr.isTTY = origIsTTY as boolean
  })

  it('does NOT run the update check when stderr is not a TTY (the agent/piped case)', async () => {
    process.stderr.isTTY = false
    await runCli(['status', 'demo'])
    expect(mockCheckLatestVersionForCli).not.toHaveBeenCalled()
  })

  it('runs the update check when stderr is an interactive TTY', async () => {
    process.stderr.isTTY = true
    await runCli(['status', 'demo'])
    expect(mockCheckLatestVersionForCli).toHaveBeenCalledTimes(1)
  })
})
