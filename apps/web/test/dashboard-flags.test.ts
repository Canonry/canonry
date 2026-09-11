import { afterEach, describe, expect, it } from 'vitest'

import { shouldShowDashboardAgentBar } from '../src/api.js'

/**
 * The agent kill-switch removes the server routes. Before this flag reached the
 * browser, the command bar still rendered and every request 404'd in front of
 * the operator — the dashboard had no way to know the capability was gone.
 */
describe('agent bar visibility', () => {
  afterEach(() => {
    delete (window as unknown as { __CANONRY_CONFIG__?: unknown }).__CANONRY_CONFIG__
  })

  it('renders by default, when the server injects nothing', () => {
    expect(shouldShowDashboardAgentBar()).toBe(true)
  })

  it('hides only when the server says the agent is off', () => {
    ;(window as unknown as { __CANONRY_CONFIG__: unknown }).__CANONRY_CONFIG__ = {
      dashboard: { showAgentBar: false },
    }
    expect(shouldShowDashboardAgentBar()).toBe(false)
  })

  it('is unaffected by the sibling chrome flags', () => {
    ;(window as unknown as { __CANONRY_CONFIG__: unknown }).__CANONRY_CONFIG__ = {
      dashboard: { showResourceLinks: false, showUpdateNotification: false },
    }
    expect(shouldShowDashboardAgentBar()).toBe(true)
  })

})
