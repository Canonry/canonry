import { describe, it, expect } from 'vitest'
import { CheckStatuses } from '@ainyc/canonry-contracts'
import { VERSION_CHECKS } from '../src/doctor/checks/version.js'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import type { DoctorContext, DoctorUpdateStatus } from '../src/doctor/types.js'

const check = VERSION_CHECKS.find((c) => c.id === 'canonry.version.current')!

function ctxWith(status?: Partial<DoctorUpdateStatus>): DoctorContext {
  return {
    db: {} as DoctorContext['db'],
    project: null,
    ...(status
      ? {
          getUpdateStatus: () => ({
            enabled: true,
            current: '5.1.2',
            latest: null,
            upgradeCommand: 'npm install -g @canonry/canonry',
            url: 'https://www.npmjs.com/package/@canonry/canonry',
            ...status,
          }),
        }
      : {}),
  }
}

describe('canonry.version.current', () => {
  it('is registered as a global check', () => {
    expect(ALL_CHECKS.some((c) => c.id === 'canonry.version.current')).toBe(true)
    expect(check.scope).toBe('global')
  })

  it('skips when the host does not report update status', async () => {
    const out = await check.run(ctxWith())
    expect(out.status).toBe(CheckStatuses.skipped)
    expect(out.code).toBe('version.status-unavailable')
  })

  it('skips when the update check is opted out', async () => {
    const out = await check.run(ctxWith({ enabled: false, latest: '9.0.0' }))
    expect(out.status).toBe(CheckStatuses.skipped)
    expect(out.code).toBe('version.check-disabled')
  })

  it('skips when the latest version is not known yet', async () => {
    const out = await check.run(ctxWith({ latest: null }))
    expect(out.status).toBe(CheckStatuses.skipped)
    expect(out.code).toBe('version.latest-unknown')
  })

  it('warns with the upgrade command when a newer version is published', async () => {
    const out = await check.run(ctxWith({ current: '5.1.2', latest: '5.2.0' }))
    expect(out.status).toBe(CheckStatuses.warn)
    expect(out.code).toBe('version.outdated')
    expect(out.summary).toBe('canonry 5.2.0 is available; this server runs 5.1.2.')
    expect(out.remediation).toContain('npm install -g @canonry/canonry')
    expect(out.remediation).toContain('restart')
    expect(out.details).toEqual({
      current: '5.1.2',
      latest: '5.2.0',
      upgradeCommand: 'npm install -g @canonry/canonry',
      url: 'https://www.npmjs.com/package/@canonry/canonry',
    })
  })

  it('compares numerically, not lexically (5.10.0 is newer than 5.9.9)', async () => {
    const out = await check.run(ctxWith({ current: '5.9.9', latest: '5.10.0' }))
    expect(out.code).toBe('version.outdated')
  })

  it('is ok when running the latest version', async () => {
    const out = await check.run(ctxWith({ current: '5.1.2', latest: '5.1.2' }))
    expect(out.status).toBe(CheckStatuses.ok)
    expect(out.code).toBe('version.current')
  })

  it('is ok when running ahead of npm (a local or pre-release build)', async () => {
    const out = await check.run(ctxWith({ current: '5.2.0', latest: '5.1.2' }))
    expect(out.code).toBe('version.current')
  })

  it('never warns on a malformed registry value', async () => {
    const out = await check.run(ctxWith({ current: '5.1.2', latest: 'not-a-version' }))
    expect(out.status).toBe(CheckStatuses.ok)
  })
})
