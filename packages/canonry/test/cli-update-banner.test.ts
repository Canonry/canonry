import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest'

// Dispatch is stubbed so runCli returns immediately without touching the API.
vi.mock('../src/cli-dispatch.js', () => ({
  dispatchRegisteredCommand: vi.fn().mockResolvedValue(true),
}))

// The cache read and the background refresh are stubbed; the formatter is real.
const mockCheckLatestVersionForCli = vi.fn().mockResolvedValue(null)
const mockReadCachedUpdateAvailable = vi.fn()
vi.mock('../src/update-check.js', async () => {
  const actual = await vi.importActual<typeof import('../src/update-check.js')>('../src/update-check.js')
  return {
    formatUpdateNotice: actual.formatUpdateNotice,
    checkLatestVersionForCli: mockCheckLatestVersionForCli,
    readCachedUpdateAvailable: mockReadCachedUpdateAvailable,
    checkLatestVersionForServer: vi.fn().mockReturnValue(null),
    getServerUpdateStatus: vi.fn(),
    isUpdateCheckEnabled: vi.fn().mockReturnValue(true),
  }
})

const { runCli } = await import('../src/cli.js')

const UPDATE = {
  current: '5.1.2',
  latest: '5.2.0',
  url: 'https://www.npmjs.com/package/@canonry/canonry',
  upgradeCommand: 'npm install -g @canonry/canonry',
}

describe('update notice', () => {
  let origIsTTY: boolean | undefined
  let stderr: string[]
  let stdout: string[]

  beforeEach(() => {
    origIsTTY = process.stderr.isTTY
    mockCheckLatestVersionForCli.mockClear()
    mockReadCachedUpdateAvailable.mockReset().mockReturnValue(UPDATE)
    stderr = []
    stdout = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    process.stderr.isTTY = origIsTTY as boolean
    vi.restoreAllMocks()
  })

  const notices = () => stderr.filter((line) => line.includes('5.2.0'))

  it('prints one agent-readable line when stderr is captured (the agent case)', async () => {
    process.stderr.isTTY = false
    await runCli(['status', 'demo'])
    expect(notices()).toEqual([
      '[canonry] UPDATE_AVAILABLE: canonry 5.2.0 is available (installed 5.1.2). ' +
      'Upgrade with `npm install -g @canonry/canonry`, then restart any running `canonry serve`. ' +
      'Silence with CANONRY_DISABLE_UPDATE_CHECK=1.\n',
    ])
    expect(stdout.join('')).not.toContain('5.2.0')
  })

  it('prints the human banner on an interactive terminal', async () => {
    process.stderr.isTTY = true
    await runCli(['status', 'demo'])
    expect(notices()).toEqual([
      '\n→ canonry 5.2.0 is available (you have 5.1.2).\n  Upgrade: npm install -g @canonry/canonry\n\n',
    ])
  })

  it.each(['json', 'jsonl'])('prints one JSON line for --format %s', async (format) => {
    process.stderr.isTTY = false
    await runCli(['status', 'demo', '--format', format])
    const lines = notices()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith('\n')).toBe(true)
    expect(lines[0]!.trim().includes('\n')).toBe(false)
    expect(JSON.parse(lines[0]!)).toEqual({
      notice: { code: 'UPDATE_AVAILABLE', ...UPDATE },
    })
  })

  it('prints before the command runs and refreshes the cache in the background', async () => {
    process.stderr.isTTY = false
    const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
    let noticesAtDispatch = -1
    vi.mocked(dispatchRegisteredCommand).mockImplementationOnce(async () => {
      noticesAtDispatch = notices().length
      return true
    })
    await runCli(['status', 'demo'])
    expect(noticesAtDispatch).toBe(1)
    expect(mockCheckLatestVersionForCli).toHaveBeenCalledTimes(1)
  })

  it('prints nothing when no newer version is cached', async () => {
    process.stderr.isTTY = false
    mockReadCachedUpdateAvailable.mockReturnValue(null)
    await runCli(['status', 'demo'])
    expect(notices()).toEqual([])
    expect(mockCheckLatestVersionForCli).toHaveBeenCalledTimes(1)
  })

  it('stays silent for help requests and the telemetry command', async () => {
    process.stderr.isTTY = false
    await runCli(['status', '--help'])
    await runCli(['telemetry', 'status'])
    expect(notices()).toEqual([])
    expect(mockReadCachedUpdateAvailable).not.toHaveBeenCalled()
    expect(mockCheckLatestVersionForCli).not.toHaveBeenCalled()
  })
})
