import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  configDir: '',
  spawn: vi.fn(),
  unref: vi.fn(),
  kill: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}))

vi.mock('../src/config.js', () => ({
  getConfigDir: () => mocks.configDir,
  loadConfig: () => ({ port: 4750 }),
}))

describe('startDaemon', () => {
  beforeEach(() => {
    mocks.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-daemon-start-'))
    mocks.spawn.mockReset()
    mocks.unref.mockReset()
    mocks.kill.mockReset()
    mocks.spawn.mockReturnValue({ pid: 4242, unref: mocks.unref, kill: mocks.kill })
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

  it('forwards the resolved config endpoint and terminates a child that never becomes ready', async () => {
    const { startDaemon } = await import('../src/commands/daemon.js')

    const started = startDaemon({ format: 'json' })
    const rejected = expect(started).rejects.toMatchObject({
      code: 'DAEMON_START_TIMEOUT',
      details: { host: '127.0.0.1', port: '4750', pid: 4242 },
    })

    await vi.advanceTimersByTimeAsync(10_200)
    await rejected

    const args = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(args.slice(-4)).toEqual(['--port', '4750', '--host', '127.0.0.1'])
    expect(mocks.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fs.existsSync(path.join(mocks.configDir, 'canonry.pid'))).toBe(false)
  })
})
