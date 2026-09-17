import { describe, expect, it } from 'vitest'
import {
  CANONRY_NPM_PACKAGE_URL,
  INSTALL_METHODS,
  isInstallMethod,
  updateCheckEnvOptOut,
  upgradeCaveatFor,
  upgradeCommandFor,
} from '../src/update-notice.js'

describe('install methods', () => {
  it('accepts only the closed set', () => {
    for (const method of INSTALL_METHODS) expect(isInstallMethod(method)).toBe(true)
    for (const value of ['curl', 'NPM', '', undefined, null, 1]) expect(isInstallMethod(value)).toBe(false)
  })

  it('maps each method to a fixed upgrade command', () => {
    expect(upgradeCommandFor('npm')).toBe('npm install -g @canonry/canonry')
    expect(upgradeCommandFor('homebrew')).toBe('brew upgrade canonry')
    expect(upgradeCommandFor('docker')).toBe('pull or rebuild your canonry image, then recreate the container')
  })

  it('only Homebrew carries the release-lag caveat', () => {
    expect(upgradeCaveatFor('homebrew')).toMatch(/Homebrew can trail npm/)
    expect(upgradeCaveatFor('npm')).toBe(null)
    expect(upgradeCaveatFor('docker')).toBe(null)
  })

  it('points at the npm package page', () => {
    expect(CANONRY_NPM_PACKAGE_URL).toBe('https://www.npmjs.com/package/@canonry/canonry')
  })
})

describe('updateCheckEnvOptOut', () => {
  it('is null when nothing opts out', () => {
    expect(updateCheckEnvOptOut({})).toBe(null)
    expect(updateCheckEnvOptOut({ CANONRY_DISABLE_UPDATE_CHECK: '0', DO_NOT_TRACK: '0' })).toBe(null)
  })

  it('names the opt-out in precedence order', () => {
    expect(updateCheckEnvOptOut({ CI: 'true' })).toBe('CI')
    expect(updateCheckEnvOptOut({ CI: 'true', DO_NOT_TRACK: '1' })).toBe('DO_NOT_TRACK')
    expect(updateCheckEnvOptOut({ CI: 'true', DO_NOT_TRACK: '1', CANONRY_DISABLE_UPDATE_CHECK: '1' })).toBe('CANONRY_DISABLE_UPDATE_CHECK')
  })
})
