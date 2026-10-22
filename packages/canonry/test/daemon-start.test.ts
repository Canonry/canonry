import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  configDir: '',
  spawn: vi.fn(),
  unref: vi.fn(),
  kill: vi.fn(),
  exitListener: undefined as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined,
}))

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}))

vi.mock('../src/config.js', () => ({
  getConfigDir: () => mocks.configDir,
  loadConfig: () => ({ port: 4750 }),
}))

const healthy = () => new Response('{"status":"ok","service":"canonry"}', { status: 200 })

describe('serveCommandLine', () => {
  it('re-runs the entry the user ran, keeping its Node flags', async () => {
    const { serveCommandLine } = await import('../src/commands/daemon.js')
    expect(serveCommandLine('/opt/canonry/bin/canonry.mjs', ['--import', 'tsx'], ['--port', '4750']))
      .toEqual(['--import', 'tsx', '/opt/canonry/bin/canonry.mjs', 'serve', '--port', '4750'])
  })

  it('refuses to guess when there is no entry', async () => {
    const { serveCommandLine } = await import('../src/commands/daemon.js')
    expect(() => serveCommandLine(undefined, [], [])).toThrow(expect.objectContaining({ code: 'DAEMON_START_FAILED' }))
  })
})

describe('startDaemon', () => {
  beforeEach(() => {
    mocks.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-daemon-start-'))
    mocks.spawn.mockReset()
    mocks.unref.mockReset()
    mocks.kill.mockReset()
    mocks.exitListener = undefined
    mocks.spawn.mockReturnValue({
      pid: 4242,
      unref: mocks.unref,
      kill: mocks.kill,
      once: (event: string, listener: typeof mocks.exitListener) => {
        if (event === 'exit') mocks.exitListener = listener
      },
    })
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
    vi.stubEnv('CANONRY_HOST', undefined as unknown as string)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not ready')))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fs.rmSync(mocks.configDir, { recursive: true, force: true })
  })

  it('launches the CLI entry with the resolved endpoint and terminates an unready child', async () => {
    const { startDaemon } = await import('../src/commands/daemon.js')

    const started = startDaemon({ format: 'json' })
    const rejected = expect(started).rejects.toMatchObject({
      code: 'DAEMON_START_TIMEOUT',
      details: { host: '127.0.0.1', port: '4750', pid: 4242 },
    })

    let settled = false
    void started.then(() => { settled = true }, () => { settled = true })
    // A slow but live startup must survive the old 10-second budget.
    await vi.advanceTimersByTimeAsync(10_200)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected

    const args = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe(process.execPath)
    expect(args).toEqual([...process.execArgv, process.argv[1], 'serve', '--port', '4750', '--host', '127.0.0.1'])
    expect(mocks.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fs.existsSync(path.join(mocks.configDir, 'canonry.pid'))).toBe(false)
  })

  it('fails as soon as the child exits instead of waiting out the timeout', async () => {
    const { startDaemon } = await import('../src/commands/daemon.js')

    const started = startDaemon({ format: 'json' })
    const rejected = expect(started).rejects.toMatchObject({
      code: 'DAEMON_START_FAILED',
      details: { exitCode: 1, pid: 4242 },
    })
    await vi.advanceTimersByTimeAsync(0)
    mocks.exitListener?.(1, null)
    await vi.advanceTimersByTimeAsync(400)
    await rejected
    expect(fs.existsSync(path.join(mocks.configDir, 'canonry.pid'))).toBe(false)
  })

  it('reports a server already on the port instead of spawning a second one', async () => {
    vi.mocked(fetch).mockResolvedValue(healthy())
    const { startDaemon } = await import('../src/commands/daemon.js')

    await expect(startDaemon({ format: 'json' })).rejects.toMatchObject({
      code: 'DAEMON_ALREADY_RUNNING',
      details: { host: '127.0.0.1', port: '4750' },
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('records the PID once the spawned server answers', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('nothing on the port yet'))
      .mockRejectedValueOnce(new Error('booting'))
      .mockResolvedValue(healthy())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { startDaemon } = await import('../src/commands/daemon.js')

    const started = startDaemon({ format: 'json' })
    await vi.advanceTimersByTimeAsync(400)
    await started

    expect(fs.readFileSync(path.join(mocks.configDir, 'canonry.pid'), 'utf-8')).toBe('4242')
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ started: true, pid: 4242, port: 4750 })
  })
})
