import { describe, expect, it } from 'vitest'
import {
  agentBrowserCheckRequestSchema,
  agentBrowserPropertySite,
  agentBrowserRequestIdentity,
  agentBrowserSiteHosts,
  isAgentBrowserSiteHost,
  normalizeAgentBrowserCheckRequest,
  summarizeAgentBrowserResults,
} from '../src/index.js'
import type { AgentBrowserCheckRequest, AgentBrowserCheckScope } from '../src/index.js'

// The scope the server resolves for a check of the project's own site.
const HOME: AgentBrowserCheckScope = { property: null, siteHosts: ['canonry.ai'], defaultStartUrl: 'https://canonry.ai/' }
// The scope for one Property of an Advanced Measurement portfolio.
const HARBOR: AgentBrowserCheckScope = {
  property: { key: 'harbor', label: 'Harbor Hotel', planRevision: 3 },
  siteHosts: ['harbor-hotel.example', 'canonry.ai', 'harbor-hotel.example'],
  defaultStartUrl: 'https://harbor-hotel.example/rooms',
}

describe('normalizeAgentBrowserCheckRequest', () => {
  it('fills every default', () => {
    expect(normalizeAgentBrowserCheckRequest({ task: '  Find the article  ' }, HOME)).toEqual({
      schemaVersion: 1,
      task: 'Find the article',
      property: null,
      siteHosts: ['canonry.ai'],
      startUrl: 'https://canonry.ai/',
      agents: [
        { agent: 'openai', model: 'gpt-6.1-sol', perception: 'screenshots' },
        { agent: 'claude', model: 'claude-opus-5-5', perception: 'screenshots' },
        { agent: 'claude-a11y', model: 'claude-opus-5-5', perception: 'accessibility-tree' },
      ],
      repeats: 1,
      expect: { urlPath: null, answerIncludes: [], submitPath: null, submitFields: {} },
      maxMinutesPerRun: 8,
      maxTurnsPerRun: 60,
    })
  })

  it('dedupes agents into one order, applies model overrides, and normalizes paths and fields', () => {
    const effective = normalizeAgentBrowserCheckRequest(
      {
        task: 'x',
        startUrl: 'https://canonry.ai/agency-access',
        agents: ['claude-a11y', 'gemini', 'claude-a11y'],
        models: { gemini: 'gemini-4-hydrogen' },
        expect: { urlPath: 'blog/x/', submitPath: '/api/agency-access/', submitFields: { name: 'A', email: 'b@c.d' } },
      },
      HOME,
    )
    expect(effective.agents).toEqual([
      { agent: 'gemini', model: 'gemini-4-hydrogen', perception: 'screenshots' },
      { agent: 'claude-a11y', model: 'claude-opus-5-5', perception: 'accessibility-tree' },
    ])
    expect(effective.startUrl).toBe('https://canonry.ai/agency-access')
    expect(effective.expect).toEqual({ urlPath: '/blog/x', answerIncludes: [], submitPath: '/api/agency-access', submitFields: { email: 'b@c.d', name: 'A' } })
  })

  it('freezes a Property scope: the Property, its site hosts once each in one order, and its page as the start', () => {
    const effective = normalizeAgentBrowserCheckRequest({ task: 'Book a room' }, HARBOR)
    expect(effective.property).toEqual({ key: 'harbor', label: 'Harbor Hotel', planRevision: 3 })
    expect(effective.siteHosts).toEqual(['canonry.ai', 'harbor-hotel.example'])
    expect(effective.startUrl).toBe('https://harbor-hotel.example/rooms')
    // A start page the request names wins over the Property's.
    expect(normalizeAgentBrowserCheckRequest({ task: 'Book a room', startUrl: 'https://harbor-hotel.example/' }, HARBOR).startUrl).toBe('https://harbor-hotel.example/')
  })
})

describe('agentBrowserRequestIdentity', () => {
  const base: AgentBrowserCheckRequest = { task: 'Find the article', agents: ['openai'], expect: { urlPath: '/blog/x' } }
  const key = (request: AgentBrowserCheckRequest, scope: AgentBrowserCheckScope = HOME) => agentBrowserRequestIdentity(normalizeAgentBrowserCheckRequest(request, scope))

  it('is the same for requests that produce the same check', () => {
    expect(key({ ...base, task: ' Find the article ' })).toBe(key(base))
    expect(key({ ...base, agents: ['claude', 'openai'] })).toBe(key({ ...base, agents: ['openai', 'claude'] }))
    expect(key({ ...base, repeats: 1 })).toBe(key(base))
  })

  // Every field changes what the check produces, so none may let two requests share a run.
  it.each<[string, AgentBrowserCheckRequest]>([
    ['task', { ...base, task: 'Find the pricing page' }],
    ['start page', { ...base, startUrl: 'https://canonry.ai/blog' }],
    ['agents', { ...base, agents: ['openai', 'gemini'] }],
    ['model', { ...base, models: { openai: 'gpt-6.1-terra' } }],
    ['repeats', { ...base, repeats: 3 }],
    ['expected page', { ...base, expect: { urlPath: '/blog/y' } }],
    ['expected phrase', { ...base, expect: { urlPath: '/blog/x', answerIncludes: ['38%'] } }],
    ['expected submission', { ...base, expect: { urlPath: '/blog/x', submitPath: '/api/a' } }],
    ['expected field', { ...base, expect: { urlPath: '/blog/x', submitPath: '/api/a', submitFields: { name: 'A' } } }],
    ['time budget', { ...base, maxMinutesPerRun: 3 }],
    ['turn budget', { ...base, maxTurnsPerRun: 20 }],
  ])('differs when the %s differs', (_field, changed) => {
    expect(key(changed)).not.toBe(key(base))
  })

  // The same task on another Property, or on a site whose hosts changed, is another check.
  it.each<[string, AgentBrowserCheckScope]>([
    ['Property', { ...HOME, property: { key: 'harbor', label: 'Harbor Hotel', planRevision: 3 } }],
    ['site hosts', { ...HOME, siteHosts: ['canonry.ai', 'canonry.com'] }],
  ])('differs when the %s differs', (_field, scope) => {
    expect(key(base, scope)).not.toBe(key(base))
  })

  it('ignores the Property label and plan revision, which describe the scope without changing it', () => {
    const renamed = { ...HARBOR, property: { key: 'harbor', label: 'The Harbor', planRevision: 4 } }
    expect(key(base, renamed)).toBe(key(base, HARBOR))
  })
})

describe('summarizeAgentBrowserResults', () => {
  it('counts every result once and keeps unverified passes inside passed', () => {
    const summary = summarizeAgentBrowserResults(
      [
        { status: 'passed', verified: true },
        { status: 'passed', verified: false },
        { status: 'failed', verified: true },
        { status: 'failed', verified: false },
        { status: 'errored', verified: false },
      ],
      6,
    )
    expect(summary).toEqual({ expected: 6, results: 5, passed: 2, failed: 2, errored: 1, unverifiedPasses: 1 })
    expect(summary.passed + summary.failed + summary.errored).toBe(summary.results)
  })

  it('reads zero results as nothing finished, not as all passing', () => {
    expect(summarizeAgentBrowserResults([], 3)).toEqual({ expected: 3, results: 0, passed: 0, failed: 0, errored: 0, unverifiedPasses: 0 })
  })
})

describe('agentBrowserCheckRequestSchema', () => {
  it('refuses field expectations without the path they are submitted to', () => {
    const parsed = agentBrowserCheckRequestSchema.safeParse({ task: 'x', expect: { submitFields: { name: 'A' } } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('"submitFields" needs "submitPath": name the path the form submits to')
  })

  it('refuses an unknown agent and an empty task', () => {
    expect(agentBrowserCheckRequestSchema.safeParse({ task: 'x', agents: ['bing'] }).success).toBe(false)
    expect(agentBrowserCheckRequestSchema.safeParse({ task: '   ' }).success).toBe(false)
  })
})

describe('site hosts', () => {
  it('reads domains as stored, full URLs and mixed case included', () => {
    expect(agentBrowserSiteHosts('https://www.Canonry.ai/home', ['canonry.com', 'CANONRY.ai'])).toEqual(['canonry.ai', 'canonry.com'])
  })

  it.each([
    ['canonry.ai', true],
    ['www.canonry.ai', true],
    ['blog.canonry.ai', true],
    ['CANONRY.AI', true],
    ['canonry.ai.evil.com', false],
    ['notcanonry.ai', false],
    ['canonry.com', false],
  ])('%s belongs to the site: %s', (host, want) => {
    expect(isAgentBrowserSiteHost(host, ['canonry.ai'])).toBe(want)
  })
})

describe('agentBrowserPropertySite', () => {
  // A Property's URL rules as both plan versions store them; the start page follows the plan's
  // own precedence: an exact page, then the longest path prefix, then a host's home page.
  it.each([
    ['an exact page over every other rule', [
      { kind: 'host', host: 'harbor-hotel.example' },
      { kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor' },
      { kind: 'exact', url: 'https://www.harbor-hotel.example/rooms?ref=plan' },
    ], { hosts: ['harbor-hotel.example', 'northstar.example'], startUrl: 'https://www.harbor-hotel.example/rooms?ref=plan' }],
    ['the longest path prefix over a shorter one and a host', [
      { kind: 'host', host: 'harbor-hotel.example' },
      { kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations' },
      { kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor' },
    ], { hosts: ['harbor-hotel.example', 'northstar.example'], startUrl: 'https://northstar.example/locations/harbor' }],
    ['a host\'s home page when that is the only rule, its www kept', [
      { kind: 'host', host: 'www.Harbor-Hotel.example' },
    ], { hosts: ['harbor-hotel.example'], startUrl: 'https://www.harbor-hotel.example/' }],
    ['no start page for a Property with no URL rules', [], { hosts: [], startUrl: null }],
    ['the next rule when an exact URL cannot be read', [
      { kind: 'exact', url: 'not a url' },
      { kind: 'host', host: 'harbor-hotel.example' },
    ], { hosts: ['harbor-hotel.example'], startUrl: 'https://harbor-hotel.example/' }],
  ] as const)('starts on %s', (_label, rules, want) => {
    expect(agentBrowserPropertySite(rules)).toEqual(want)
  })
})
