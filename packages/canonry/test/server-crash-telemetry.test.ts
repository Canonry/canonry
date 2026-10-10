import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackFeatureCompleted = vi.hoisted(() => vi.fn())
vi.mock('../src/outcome-telemetry.js', () => ({ trackFeatureCompleted }))
vi.mock('../src/telemetry.js', () => ({ isTelemetryEnabled: () => true }))

const { reportPreviousServerCrash, trackServerStartFailure, watchServerCrashes } = await import('../src/server-crash-telemetry.js')

describe('server start and crash telemetry', () => {
  let dir: string
  beforeEach(() => {
    trackFeatureCompleted.mockReset()
    dir = path.join(os.tmpdir(), `canonry-crash-${crypto.randomUUID()}`)
    fs.mkdirSync(dir, { recursive: true })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('names why the server failed to start, never the message', () => {
    trackServerStartFailure(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4100'), { code: 'EADDRINUSE' }))
    expect(trackFeatureCompleted).toHaveBeenLastCalledWith({
      feature: 'server', operation: 'start', status: 'failed', trigger: 'startup', reasonCode: 'PORT_IN_USE', errorName: 'Error',
    })
    trackServerStartFailure(new TypeError('no such table'), 'MIGRATION_FAILED')
    expect(trackFeatureCompleted).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'MIGRATION_FAILED', errorName: 'TypeError' }))
  })

  it('records a crash without changing exit behavior, and reports it once on the next start', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process
    watchServerCrashes(dir, proc)
    proc.emit('uncaughtExceptionMonitor', new RangeError('secret detail https://acme.example'), 'unhandledRejection')
    const marker = fs.readFileSync(path.join(dir, 'crash-telemetry.json'), 'utf8')
    expect(marker).not.toContain('acme')
    reportPreviousServerCrash(dir)
    expect(trackFeatureCompleted).toHaveBeenCalledWith({
      feature: 'server', operation: 'crash', status: 'failed', trigger: 'startup', reasonCode: 'UNHANDLED_REJECTION', errorName: 'RangeError',
    })
    expect(fs.existsSync(path.join(dir, 'crash-telemetry.json'))).toBe(false)
    reportPreviousServerCrash(dir)
    expect(trackFeatureCompleted).toHaveBeenCalledTimes(1)
  })
})
