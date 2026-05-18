import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckStatuses } from '@ainyc/canonry-contracts'
import { RUNTIME_STATE_CHECKS } from '../src/doctor/checks/runtime-state.js'
import type { DoctorContext } from '../src/doctor/types.js'

/**
 * Regression coverage for the project-page-doesnt-update bug: deleting
 * the DB or config out from under a running `canonry serve` leaves the
 * daemon serving stale data from an orphaned SQLite inode. Both checks
 * here fire when the files vanish so the operator sees the cause.
 */

const dbCheck = RUNTIME_STATE_CHECKS.find((c) => c.id === 'db.file.present')!
const cfgCheck = RUNTIME_STATE_CHECKS.find((c) => c.id === 'config.file.present')!

function makeCtx(paths: DoctorContext['runtimeStatePaths']): DoctorContext {
  return {
    // Only `runtimeStatePaths` matters for these checks; the other fields
    // are stubbed out as nulls/undefined.
    db: null as unknown as DoctorContext['db'],
    project: null,
    runtimeStatePaths: paths,
  }
}

describe('db.file.present', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-db-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns ok when the configured database file exists', async () => {
    const dbPath = path.join(tmp, 'data.db')
    fs.writeFileSync(dbPath, 'fake-sqlite')
    const result = await Promise.resolve(dbCheck.run(makeCtx({ databasePath: dbPath })))
    expect(result.status).toBe(CheckStatuses.ok)
    expect(result.code).toBe('db.file.present')
    expect(result.details).toMatchObject({ path: dbPath })
  })

  it('returns fail with a clear remediation when the database file has been deleted', async () => {
    const dbPath = path.join(tmp, 'data.db')
    fs.writeFileSync(dbPath, 'fake-sqlite')
    fs.unlinkSync(dbPath)
    const result = await Promise.resolve(dbCheck.run(makeCtx({ databasePath: dbPath })))
    expect(result.status).toBe(CheckStatuses.fail)
    expect(result.code).toBe('db.file.missing')
    // Remediation must mention restarting `canonry serve` — that's the
    // actual fix for the open-inode situation.
    expect(result.remediation).toMatch(/restart `canonry serve`/i)
    expect(result.details).toMatchObject({ path: dbPath })
  })

  it('returns skipped when no path is wired (cloud deployment)', async () => {
    const result = await Promise.resolve(dbCheck.run(makeCtx(undefined)))
    expect(result.status).toBe(CheckStatuses.skipped)
    expect(result.code).toBe('db.file.path-not-wired')
  })
})

describe('config.file.present', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-config-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns ok when the configured config file exists', async () => {
    const cfgPath = path.join(tmp, 'config.yaml')
    fs.writeFileSync(cfgPath, 'apiKey: cnry_test\n')
    const result = await Promise.resolve(cfgCheck.run(
      makeCtx({ databasePath: '/tmp/ignored', configPath: cfgPath }),
    ))
    expect(result.status).toBe(CheckStatuses.ok)
    expect(result.code).toBe('config.file.present')
  })

  it('returns fail when the config file has been deleted', async () => {
    const cfgPath = path.join(tmp, 'config.yaml')
    fs.writeFileSync(cfgPath, 'apiKey: cnry_test\n')
    fs.unlinkSync(cfgPath)
    const result = await Promise.resolve(cfgCheck.run(
      makeCtx({ databasePath: '/tmp/ignored', configPath: cfgPath }),
    ))
    expect(result.status).toBe(CheckStatuses.fail)
    expect(result.code).toBe('config.file.missing')
    expect(result.remediation).toMatch(/restart `canonry serve`/i)
  })

  it('returns skipped when no config path is wired (cloud deployment)', async () => {
    const result = await Promise.resolve(cfgCheck.run(
      makeCtx({ databasePath: '/tmp/ignored' }),
    ))
    expect(result.status).toBe(CheckStatuses.skipped)
    expect(result.code).toBe('config.file.path-not-wired')
  })

  it('returns skipped when paths object is wired but configPath is null', async () => {
    // Explicit null is the "we know there is no config" case — separate
    // from undefined (no paths wired at all). Both skip.
    const result = await Promise.resolve(cfgCheck.run(
      makeCtx({ databasePath: '/tmp/ignored', configPath: null }),
    ))
    expect(result.status).toBe(CheckStatuses.skipped)
    expect(result.code).toBe('config.file.path-not-wired')
  })
})
