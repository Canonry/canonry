import { describe, expect, it } from 'vitest'
import { parseSourceFlag } from '../src/commands/backlinks.js'
import { invokeCliRead, prepareCliReadFixture } from './cli-read-fixture.js'

async function readBacklinks(args: string[], payload: unknown, pathname: string, query: Record<string, string> = {}) {
  const cleanup = prepareCliReadFixture()
  try {
    const expected = { pathname: '/prefix/api/v1/' + pathname, query }
    const human = await invokeCliRead(['backlinks', ...args], payload, expected)
    expect(human.exitCode).toBeUndefined()
    expect(human.stderr).toBe('')
    const machine = await invokeCliRead(['backlinks', ...args, '--format', 'json'], payload, expected)
    expect(machine.exitCode).toBeUndefined()
    expect(machine.stderr).toBe('')
    expect(JSON.parse(machine.stdout)).toEqual(payload)
    return human.stdout
  } finally {
    cleanup()
  }
}

describe('backlinks formatters', () => {
  it('renders install status with hint when duckdb is missing', async () => {
    const out = await readBacklinks(['doctor'], {
      duckdbInstalled: false,
      duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
      pluginDir: '/home/u/.canonry/plugins',
    }, 'backlinks/status')
    expect(out).toContain('not installed')
    expect(out).toContain('canonry backlinks install')
    expect(out).not.toContain('Version:')
  })

  it('renders install status with version when duckdb is present', async () => {
    const out = await readBacklinks(['doctor'], {
      duckdbInstalled: true,
      duckdbVersion: '1.4.4-r.3',
      duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
      pluginDir: '/home/u/.canonry/plugins',
    }, 'backlinks/status')
    expect(out).toContain('installed')
    expect(out).toContain('Version: 1.4.4-r.3')
    expect(out).not.toContain('canonry backlinks install')
  })

  it('renders a sync with counts and phase detail', async () => {
    const out = await readBacklinks(['status'], {
      id: 's1',
      release: 'cc-main-2026-jan-feb-mar',
      status: 'querying',
      phaseDetail: 'scanning edges',
      projectsProcessed: 3,
      domainsDiscovered: 1200,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:01:00.000Z',
    }, 'backlinks/syncs/latest')
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('querying')
    expect(out).toContain('scanning edges')
    expect(out).toContain('Projects: 3')
    expect(out).toContain('Domains:  1200')
  })

  it('renders an empty-summary message when no ready release (commoncrawl)', async () => {
    const out = await readBacklinks(['list', 'roots'], {
      source: 'commoncrawl',
      summary: null,
      total: 0,
      rows: [],
    }, 'projects/roots/backlinks/domains', { limit: '50' })
    expect(out).toContain('No ready release')
    expect(out).toContain('roots')
    expect(out).toContain('Source:  commoncrawl')
  })

  it('renders a historical-source empty hint without suggesting a retired sync', async () => {
    const out = await readBacklinks(['list', 'roots', '--source', 'bing-webmaster'], {
      source: 'bing-webmaster',
      summary: null,
      total: 0,
      rows: [],
    }, 'projects/roots/backlinks/domains', { limit: '50', source: 'bing-webmaster' })
    expect(out).toContain('Source:  bing-webmaster')
    expect(out).toContain('No stored Bing backlink history')
    expect(out).not.toContain('backlinks bing-sync')
    expect(out).not.toContain('No ready release')
  })

  it('renders summary with top domains block when rows present', async () => {
    const out = await readBacklinks(['list', 'roots'], {
      source: 'commoncrawl',
      summary: {
        projectId: 'p1',
        source: 'commoncrawl',
        release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 2,
        totalHosts: 1500,
        top10HostsShare: '1.000000',
        queriedAt: '2026-04-01T00:00:00.000Z',
      },
      total: 2,
      rows: [
        { linkingDomain: 'github.com', numHosts: 1000, source: 'commoncrawl' },
        { linkingDomain: 'reddit.com', numHosts: 500, source: 'commoncrawl' },
      ],
    }, 'projects/roots/backlinks/domains', { limit: '50' })
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('roots.io')
    expect(out).toContain('github.com')
    expect(out).toContain('reddit.com')
    expect(out).toContain('1000')
    expect(out).toContain('500')
    expect(out.split('\n')).toContain('Top-10 share:    100%')
  })

  it('renders the top-10 host share (a six-decimal fraction string) as a percent', async () => {
    for (const [value, display] of [['0.734512', '73.5%'], ['0.000400', '<0.1%'], ['n/a', '—']]) {
      const out = await readBacklinks(['list', 'roots'], {
        source: 'commoncrawl',
        summary: {
          projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar', targetDomain: 'roots.io',
          totalLinkingDomains: 40, totalHosts: 1500, top10HostsShare: value, queriedAt: '2026-04-01T00:00:00.000Z',
        }, total: 0, rows: [],
      }, 'projects/roots/backlinks/domains', { limit: '50' })
      expect(out.split('\n')).toContain('Top-10 share:    ' + display)
      expect(out.split('\n')).toContain('Linking domains: 40')
      expect(out.split('\n')).toContain('Total hosts:     1500')
    }
  })

  it('renders "no cached releases" placeholder', async () => {
    expect(await readBacklinks(['releases'], [], 'backlinks/releases')).toBe('No cached releases.')
  })

  it('renders cached releases as a table', async () => {
    const out = await readBacklinks(['releases'], [
      { release: 'cc-main-2026-jan-feb-mar', syncStatus: 'ready', bytes: 17000000000, lastUsedAt: '2026-04-01T00:00:00.000Z' },
      { release: 'cc-main-2025-oct-nov-dec', syncStatus: null, bytes: 0, lastUsedAt: null },
    ], 'backlinks/releases')
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('ready')
    expect(out).toContain('unknown')
    expect(out.split('\n').slice(1).map(line => line.trim().split(/\s+/))).toEqual([
      ['cc-main-2026-jan-feb-mar', 'ready', '17000000000', '2026-04-01T00:00:00.000Z'],
      ['cc-main-2025-oct-nov-dec', 'unknown', '0', '-'],
    ])
  })
})

describe('parseSourceFlag', () => {
  it('returns undefined when omitted (API defaults to commoncrawl)', () => {
    expect(parseSourceFlag(undefined)).toBeUndefined()
  })

  it('passes through the two known sources', () => {
    expect(parseSourceFlag('commoncrawl')).toBe('commoncrawl')
    expect(parseSourceFlag('bing-webmaster')).toBe('bing-webmaster')
  })

  it('throws a usage error on an unknown source', () => {
    expect(() => parseSourceFlag('ahrefs')).toThrow(/Invalid --source/)
  })
})

describe('formatSourceAvailability', () => {
  it('shows stored sources and a Common Crawl onboarding hint when none is active', async () => {
    const out = await readBacklinks(['sources', 'roots'], {
      projectId: 'roots',
      targetDomain: 'roots.io',
      anyConnected: false,
      anyData: false,
      sources: [
        { source: 'commoncrawl', connected: false, hasData: false, latestRelease: null, totalLinkingDomains: 0, lastSyncedAt: null },
        { source: 'bing-webmaster', connected: false, hasData: false, latestRelease: null, totalLinkingDomains: 0, lastSyncedAt: null },
      ],
    }, 'projects/roots/backlinks/sources')
    expect(out).toContain('commoncrawl')
    expect(out).toContain('bing-webmaster')
    expect(out).toContain('No active backlink source is set up')
    expect(out).toContain('canonry backlinks sync')
    expect(out).not.toContain('canonry bing connect')
  })

  it('shows connected + data and no onboarding hint when a source is set up', async () => {
    const out = await readBacklinks(['sources', 'roots'], {
      projectId: 'roots',
      targetDomain: 'roots.io',
      anyConnected: true,
      anyData: true,
      sources: [
        { source: 'commoncrawl', connected: true, hasData: true, latestRelease: 'cc-main-2026-jan-feb-mar', totalLinkingDomains: 42, lastSyncedAt: '2026-06-01T00:00:00Z' },
        { source: 'bing-webmaster', connected: false, hasData: false, latestRelease: null, totalLinkingDomains: 0, lastSyncedAt: null },
      ],
    }, 'projects/roots/backlinks/sources')
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('42')
    expect(out.split('\n').find(line => line.startsWith('commoncrawl'))?.trim().split(/\s+/)).toEqual(['commoncrawl', 'yes', 'yes', '42', 'cc-main-2026-jan-feb-mar'])
    expect(out).not.toContain('No active backlink source is set up')
  })
})
