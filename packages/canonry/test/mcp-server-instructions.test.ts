import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { OPERATIONS_GUIDE } from '../src/mcp/operations-guide.generated.js'

/**
 * The `instructions` string is the only activation channel that is both
 * automatic (the client receives it at initialize, the model does not choose
 * to load it) and impossible to make stale (it ships inside the running
 * engine). Two properties have to hold or it stops working.
 */
const SOURCE = fs.readFileSync(
  path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../src/mcp/server.ts'),
  'utf-8',
)

function instructions(): string {
  return OPERATIONS_GUIDE.initialize
}

describe('MCP server instructions', () => {
  it('is wired into the McpServer constructor', () => {
    expect(SOURCE).toMatch(/instructions:\s*SERVER_INSTRUCTIONS/)
  })

  it('stays under the 2KB Claude Code truncates at', () => {
    expect(Buffer.byteLength(instructions(), 'utf-8')).toBeLessThan(2048)
  })

  it('points to help as the universal entry point and makes the skill optional', () => {
    expect(instructions()).toContain('canonry_help')
    expect(instructions()).toMatch(/canonry.*skill/i)
    expect(instructions()).toContain('optional additional guidance')
    expect(instructions()).not.toMatch(/load.*skill before/i)
  })

  it('carries the mention/cited distinction, the one error that yields a wrong number', () => {
    const text = instructions()
    expect(text).toMatch(/mentioned/)
    expect(text).toMatch(/cited/)
    expect(text).toMatch(/never compute one from the other/i)
  })

  it('states the approval rule for quota-spending work', () => {
    expect(instructions()).toMatch(/approval/i)
  })

  /**
   * The instructions used to close with "Reads and --dry-run are the safe
   * defaults." That is false for the handful of GETs behind
   * `requirePaidReadScope`: they resolve the operator's ads credential and call
   * the provider on demand, spending on the ad account. They are tagged
   * `access: 'read'`, so NOTHING in the tool list distinguishes them — a model
   * reading a blanket safety claim will call them without asking.
   *
   * The count is asserted against the route file on purpose. Adding a sixth
   * billed GET has to fail here, because the failure is the only thing that
   * makes someone re-read this text; the routes and this string are two sources
   * that must agree and nothing else compares them.
   */
  describe('billed reads', () => {
    const BILLED_TOOLS = [
      'canonry_ads_account',
      'canonry_ads_geo_search',
      'canonry_ads_live_delivery',
      'canonry_ads_conversion_pixels',
      'canonry_ads_conversion_event_settings',
    ]
    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const readSource = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf-8')

    it('never claims reads in general are safe', () => {
      // `[^.]+` keeps the claim inside one sentence, so "Most reads are free."
      // followed by a later sentence containing "safe" is not a false positive.
      expect(instructions()).not.toMatch(/\breads?\b[^.]+\bsafe\b/i)
    })

    it('names every tool that spends against the advertiser account', () => {
      const text = instructions()
      for (const tool of BILLED_TOOLS) expect(text).toContain(tool)
    })

    it('names only tools that actually exist', () => {
      const registry = readSource('../src/mcp/tool-registry.ts')
      for (const tool of BILLED_TOOLS) expect(registry).toContain(`name: '${tool}'`)
    })

    it('covers every route behind requirePaidReadScope — fails when a sixth is added', () => {
      const ads = readSource('../../api-routes/src/ads.ts')
      const guarded = new Set(
        [...ads.matchAll(/'(\/projects\/:name\/ads\/[a-z/-]+)'(?=[\s\S]{0,600}?requirePaidReadScope)/g)]
          .map(m => m[1]!),
      )
      expect(guarded.size).toBe(BILLED_TOOLS.length)
    })
  })

  it('names every live Google Marketing discovery and sync tool', () => {
    const googleMarketingTools = [
      'canonry_google_ads_customers',
      'canonry_gtm_accounts',
      'canonry_gtm_containers',
      'canonry_gtm_workspaces',
      'canonry_google_ads_sync',
      'canonry_gtm_sync',
    ]
    const text = instructions()
    const registry = fs.readFileSync(
      path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../src/mcp/tool-registry.ts'),
      'utf-8',
    )

    for (const tool of googleMarketingTools) {
      expect(text).toContain(tool)
      expect(registry).toContain(`name: '${tool}'`)
    }
  })
})
