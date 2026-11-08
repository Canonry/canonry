import { describe, expect, it } from 'vitest'

import {
  deriveLaunchpadIdentity,
  resolveOnboardingSurface,
  settleSiteHealthDispatch,
  watchTimedOutSiteHealthDispatch,
} from '../src/pages/OnboardingSetupPage.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'

describe('platform onboarding launchpad', () => {
  it('derives editable project defaults from a public domain without making locale a gate', () => {
    expect(deriveLaunchpadIdentity('https://www.Example.co.uk/pricing?ref=home')).toEqual({
      canonicalDomain: 'example.co.uk',
      projectName: 'example-co-uk',
      displayName: 'example.co.uk',
    })
  })

  it('keeps an invalid domain out of a create request', () => {
    expect(deriveLaunchpadIdentity('not a domain')).toBeNull()
  })

  it('keeps IPv4, IPv6, and private literal hosts out of a public-site crawl request', () => {
    expect(deriveLaunchpadIdentity('127.0.0.1')).toBeNull()
    expect(deriveLaunchpadIdentity('192.168.1.10')).toBeNull()
    expect(deriveLaunchpadIdentity('http://[::1]')).toBeNull()
  })

  it('accepts inferred HTTPS for a bare domain but rejects explicit non-web schemes', () => {
    expect(deriveLaunchpadIdentity('example.com')).not.toBeNull()
    expect(deriveLaunchpadIdentity('ftp://example.com')).toBeNull()
  })

  it('keeps the established setup as the flag-off experience', () => {
    expect(resolveOnboardingSurface('legacy', { state: 'idle' })).toBe('legacy')
  })

  it('uses platform only after auto receives an authoritative empty project list', () => {
    expect(resolveOnboardingSurface('auto', { state: 'loading' })).toBe('loading')
    expect(resolveOnboardingSurface('auto', { state: 'success', projectCount: 0 })).toBe('platform')
    expect(resolveOnboardingSurface('auto', { state: 'success', projectCount: 1 })).toBe('legacy')
  })

  it('does not mistake an unavailable project list for a zero-project portfolio', () => {
    expect(resolveOnboardingSurface('auto', { state: 'error' })).toBe('retry')
  })

  it('releases a slow site-health dispatch at the short boundary without treating it as a failure', async () => {
    let resolveRun: ((value: { runId: string; status: 'queued' }) => void) | undefined
    const dispatch = new Promise<{ runId: string; status: 'queued' }>((resolve) => {
      resolveRun = resolve
    })

    await expect(settleSiteHealthDispatch(dispatch, 0)).resolves.toEqual({ state: 'timed-out' })

    resolveRun?.({ runId: 'site-audit-1', status: 'queued' })
  })

  it('keeps the exact run id when the canonical site-health dispatch is queued in time', async () => {
    await expect(
      settleSiteHealthDispatch(Promise.resolve({ runId: 'site-audit-1', status: 'queued' }), 10),
    ).resolves.toEqual({
      state: 'queued',
      run: { runId: 'site-audit-1', status: 'queued' },
    })
  })

  it('surfaces a dispatch that rejects after the handoff boundary', async () => {
    resetToasts()
    watchTimedOutSiteHealthDispatch(Promise.reject(new Error('worker unavailable')), 'project-example')
    await Promise.resolve()

    expect(getToasts()).toEqual([
      expect.objectContaining({
        title: 'Agent Readiness scan did not start',
        detail: 'The project is safe. Choose Run scan in Agent Readiness to retry.',
        tone: 'negative',
      }),
    ])
    resetToasts()
  })
})
