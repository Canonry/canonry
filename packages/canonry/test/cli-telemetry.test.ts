import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli-error.js'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  trackEvent: vi.fn(),
  trackFinished: vi.fn(),
  buildSetupState: vi.fn(),
  isTelemetryEnabled: vi.fn(),
  isFirstRun: vi.fn(),
  getOrCreateAnonymousId: vi.fn(),
  showFirstRunNotice: vi.fn(),
}))

vi.mock('../src/cli-dispatch.js', () => ({
  dispatchRegisteredCommand: mocks.dispatch,
}))

vi.mock('../src/setup-state.js', () => ({
  buildSetupState: mocks.buildSetupState,
}))

vi.mock('../src/telemetry.js', () => ({
  trackEvent: mocks.trackEvent,
  trackCliCommandFinished: mocks.trackFinished,
  isTelemetryEnabled: mocks.isTelemetryEnabled,
  isFirstRun: mocks.isFirstRun,
  getOrCreateAnonymousId: mocks.getOrCreateAnonymousId,
  showFirstRunNotice: mocks.showFirstRunNotice,
  detectAndTrackUpgrade: vi.fn(),
}))

vi.mock('../src/update-check.js', () => ({
  checkLatestVersionForCli: vi.fn().mockResolvedValue(null),
  readCachedUpdateAvailable: vi.fn().mockReturnValue(null),
  notePrintedUpdateAvailable: vi.fn(),
  getPrintedUpdateAvailable: vi.fn().mockReturnValue(null),
  formatUpdateNotice: vi.fn().mockReturnValue(''),
}))

const { runCli } = await import('../src/cli.js')

const beforeState = {
  provider_count: 0,
  has_keywords: false,
  project_count: 0,
  is_first_run: true,
}

const afterState = {
  provider_count: 1,
  has_keywords: true,
  project_count: 1,
  is_first_run: false,
}

describe('CLI command lifecycle telemetry', () => {
  let originalIsTTY: boolean | undefined

  beforeEach(() => {
    originalIsTTY = process.stderr.isTTY
    mocks.dispatch.mockReset()
    mocks.trackEvent.mockReset()
    mocks.trackFinished.mockReset()
    mocks.buildSetupState.mockReset()
    mocks.isTelemetryEnabled.mockReset()
    mocks.isTelemetryEnabled.mockReturnValue(true)
    mocks.isFirstRun.mockReset().mockReturnValue(false)
    mocks.getOrCreateAnonymousId.mockReset()
    mocks.showFirstRunNotice.mockReset()
    process.stderr.isTTY = false
  })

  afterEach(() => {
    process.stderr.isTTY = originalIsTTY as boolean
    vi.restoreAllMocks()
  })

  it('uses the registered command path and captures post-command setup state', async () => {
    mocks.isFirstRun.mockReturnValue(true)
    mocks.dispatch.mockResolvedValueOnce(true)
    mocks.buildSetupState
      .mockReturnValueOnce(beforeState)
      .mockReturnValueOnce(afterState)
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_250)

    await expect(runCli(['wordpress', 'schema', 'deploy'])).resolves.toBe(0)

    expect(mocks.showFirstRunNotice).toHaveBeenCalledOnce()
    expect(mocks.getOrCreateAnonymousId).toHaveBeenCalledOnce()
    expect(mocks.showFirstRunNotice.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getOrCreateAnonymousId.mock.invocationCallOrder[0]!)

    expect(mocks.trackEvent).toHaveBeenCalledWith('cli.command', {
      command: 'wordpress.schema.deploy',
      setup_state: beforeState,
      agent: expect.any(String),
      interactive: expect.any(Boolean),
    })
    expect(mocks.trackFinished).toHaveBeenCalledWith({
      command: 'wordpress.schema.deploy',
      success: true,
      durationMs: 250,
      setupState: afterState,
    })
  })

  it('reports a stable error code without raw error text', async () => {
    const error = new CliError({
      code: 'NO_PROVIDER',
      message: 'secret upstream response body',
      exitCode: 2,
    })
    mocks.dispatch.mockRejectedValueOnce(error)
    mocks.buildSetupState
      .mockReturnValueOnce(beforeState)
      .mockReturnValueOnce(beforeState)
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(4_000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCli(['run', 'private-project-name'])).resolves.toBe(2)

    expect(mocks.trackFinished).toHaveBeenCalledWith({
      command: 'run',
      success: false,
      durationMs: 2_000,
      setupState: beforeState,
      errorCode: 'NO_PROVIDER',
    })
    expect(JSON.stringify(mocks.trackFinished.mock.calls)).not.toContain(
      'secret upstream response body',
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it('collapses untrusted API error codes before telemetry', async () => {
    const error = new CliError({
      code: 'customer-supplied-response-code',
      message: 'secret upstream response body',
      details: { httpStatus: 500 },
      exitCode: 2,
    })
    mocks.dispatch.mockRejectedValueOnce(error)
    mocks.buildSetupState
      .mockReturnValueOnce(beforeState)
      .mockReturnValueOnce(beforeState)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCli(['run', 'private-project-name'])).resolves.toBe(2)

    expect(mocks.trackFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        success: false,
        errorCode: 'API_ERROR',
      }),
    )
    expect(JSON.stringify(mocks.trackFinished.mock.calls)).not.toContain(
      'customer-supplied-response-code',
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it('collapses unregistered commands instead of sending raw argv', async () => {
    mocks.dispatch.mockResolvedValueOnce(false)
    mocks.buildSetupState
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCli(['customer-secret', '--format', 'json'])).resolves.toBe(1)

    expect(mocks.trackEvent).toHaveBeenCalledWith('cli.command', {
      command: 'unknown',
      agent: expect.any(String),
      interactive: expect.any(Boolean),
    })
    expect(mocks.trackFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'unknown',
        success: false,
        errorCode: 'CLI_USAGE_ERROR',
      }),
    )
    expect(JSON.stringify(mocks.trackEvent.mock.calls)).not.toContain(
      'customer-secret',
    )
    expect(JSON.stringify(mocks.trackFinished.mock.calls)).not.toContain(
      'customer-secret',
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it.each(['status', 'enable', 'disable'])('does not emit lifecycle events for telemetry %s controls', async subcommand => {
    mocks.isFirstRun.mockReturnValue(true)
    mocks.dispatch.mockResolvedValueOnce(true)

    await expect(runCli(['telemetry', subcommand])).resolves.toBe(0)

    expect(mocks.trackEvent).not.toHaveBeenCalled()
    expect(mocks.trackFinished).not.toHaveBeenCalled()
    expect(mocks.buildSetupState).not.toHaveBeenCalled()
    expect(mocks.showFirstRunNotice).not.toHaveBeenCalled()
    expect(mocks.getOrCreateAnonymousId).not.toHaveBeenCalled()
  })

  it('does no telemetry work when collection is disabled', async () => {
    mocks.isFirstRun.mockReturnValue(true)
    mocks.isTelemetryEnabled.mockReturnValue(false)
    mocks.dispatch.mockResolvedValueOnce(true)

    await expect(runCli(['status', 'demo'])).resolves.toBe(0)

    expect(mocks.trackEvent).not.toHaveBeenCalled()
    expect(mocks.trackFinished).not.toHaveBeenCalled()
    expect(mocks.buildSetupState).not.toHaveBeenCalled()
    expect(mocks.showFirstRunNotice).not.toHaveBeenCalled()
    expect(mocks.getOrCreateAnonymousId).not.toHaveBeenCalled()
  })

  it('hands a provider-less Page Health result to AI Visibility on stderr, even for JSON and with telemetry off', async () => {
    mocks.isTelemetryEnabled.mockReturnValue(false)
    mocks.dispatch.mockResolvedValueOnce(true)
    mocks.buildSetupState.mockReturnValue(beforeState)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write')

    await expect(runCli(['technical-aeo', 'score', 'demo', '--format', 'json'])).resolves.toBe(0)

    const notices = stderr.mock.calls.map(([chunk]) => String(chunk)).filter(chunk => chunk.includes('"notice"'))
    expect(notices).toHaveLength(1)
    expect(JSON.parse(notices[0]!)).toMatchObject({ notice: { code: 'NO_PROVIDER' } })
    expect(stdout).not.toHaveBeenCalled()
    expect(mocks.trackFinished).not.toHaveBeenCalled()
  })

  it('reads no setup state for a non-handoff command in a machine format with telemetry off', async () => {
    mocks.isTelemetryEnabled.mockReturnValue(false)
    mocks.dispatch.mockResolvedValueOnce(true)

    await expect(runCli(['technical-aeo', 'progress', 'demo', '--run-id', 'r1', '--format', 'json'])).resolves.toBe(0)

    expect(mocks.buildSetupState).not.toHaveBeenCalled()
  })

  it('waits until init has persisted its install identity before lifecycle telemetry', async () => {
    mocks.isFirstRun.mockReturnValue(true)
    mocks.dispatch.mockResolvedValueOnce(true)
    mocks.buildSetupState.mockReturnValueOnce(afterState)

    await expect(runCli(['init', '--yes'])).resolves.toBe(0)

    expect(mocks.trackEvent).not.toHaveBeenCalled()
    expect(mocks.showFirstRunNotice).not.toHaveBeenCalled()
    expect(mocks.getOrCreateAnonymousId).not.toHaveBeenCalled()
    expect(mocks.trackFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'init',
        success: true,
        setupState: afterState,
      }),
    )
  })

  it('does not emit a terminal event when init fails before disclosure', async () => {
    mocks.dispatch.mockRejectedValueOnce(
      new CliError({
        code: 'INIT_PROVIDER_REQUIRED',
        message: 'provider required',
        exitCode: 1,
      }),
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCli(['init', '--yes'])).resolves.toBe(1)

    expect(mocks.trackEvent).not.toHaveBeenCalled()
    expect(mocks.trackFinished).not.toHaveBeenCalled()
    expect(mocks.buildSetupState).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
  })
})
