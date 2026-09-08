import { afterEach, describe, expect, it } from 'vitest'

import { viewerRoleLabel, getViewerResearchConfig, shouldShowDashboardAgentBar } from '../src/api.js'

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

  it('keeps viewer research off unless the server injects the paid capability', () => {
    expect(getViewerResearchConfig()).toBeNull()
    ;(window as unknown as { __CANONRY_CONFIG__: unknown }).__CANONRY_CONFIG__ = {
      research: { allowViewers: true, viewerDailyRunLimit: 7 },
    }
    expect(getViewerResearchConfig()).toEqual({ allowViewers: true, viewerDailyRunLimit: 7 })
  })
})

describe('viewerRoleLabel', () => {
  afterEach(() => { delete window.__CANONRY_CONFIG__ })

  it('says View only when the account really can only read', () => {
    expect(viewerRoleLabel()).toBe('View only')
    window.__CANONRY_CONFIG__ = { research: { allowViewers: false } }
    expect(viewerRoleLabel()).toBe('View only')
  })

  it('says Analyst once the deployment grants viewer research', () => {
    // The person can run real queries against an answer engine, so calling
    // them view-only contradicts the surface in front of them.
    window.__CANONRY_CONFIG__ = { research: { allowViewers: true, viewerDailyRunLimit: 20 } }
    expect(viewerRoleLabel()).toBe('Analyst')
  })
})
