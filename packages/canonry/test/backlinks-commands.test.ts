import { describe, expect, it } from 'vitest'
import {
  formatCachedReleases,
  formatInstallStatus,
  formatSummaryAndDomains,
  formatSync,
} from '../src/commands/backlinks.js'

describe('backlinks formatters', () => {
  it('renders install status with hint when duckdb is missing', () => {
    const out = formatInstallStatus({
      duckdbInstalled: false,
      duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
      pluginDir: '/home/u/.canonry/plugins',
    })
    expect(out).toContain('not installed')
    expect(out).toContain('canonry backlinks install')
    expect(out).not.toContain('Version:')
  })

  it('renders install status with version when duckdb is present', () => {
    const out = formatInstallStatus({
      duckdbInstalled: true,
      duckdbVersion: '1.4.4-r.3',
      duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
      pluginDir: '/home/u/.canonry/plugins',
    })
    expect(out).toContain('installed')
    expect(out).toContain('Version: 1.4.4-r.3')
    expect(out).not.toContain('canonry backlinks install')
  })

  it('renders a sync with counts and phase detail', () => {
    const out = formatSync({
      id: 's1',
      release: 'cc-main-2026-jan-feb-mar',
      status: 'querying',
      phaseDetail: 'scanning edges',
      projectsProcessed: 3,
      domainsDiscovered: 1200,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:01:00.000Z',
    })
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('querying')
    expect(out).toContain('scanning edges')
    expect(out).toContain('Projects: 3')
    expect(out).toContain('Domains:  1200')
  })

  it('renders an empty-summary message when no ready release', () => {
    const out = formatSummaryAndDomains('roots', {
      summary: null,
      total: 0,
      rows: [],
    })
    expect(out).toContain('No ready release')
    expect(out).toContain('roots')
  })

  it('renders summary with top domains block when rows present', () => {
    const out = formatSummaryAndDomains('roots', {
      summary: {
        projectId: 'p1',
        release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 2,
        totalHosts: 1500,
        top10HostsShare: '1.000000',
        queriedAt: '2026-04-01T00:00:00.000Z',
      },
      total: 2,
      rows: [
        { linkingDomain: 'github.com', numHosts: 1000 },
        { linkingDomain: 'reddit.com', numHosts: 500 },
      ],
    })
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('roots.io')
    expect(out).toContain('github.com')
    expect(out).toContain('reddit.com')
    expect(out).toContain('1000')
    expect(out).toContain('500')
  })

  it('renders "no cached releases" placeholder', () => {
    expect(formatCachedReleases([])).toBe('No cached releases.')
  })

  it('renders cached releases as a table', () => {
    const out = formatCachedReleases([
      { release: 'cc-main-2026-jan-feb-mar', syncStatus: 'ready', bytes: 17000000000, lastUsedAt: '2026-04-01T00:00:00.000Z' },
      { release: 'cc-main-2025-oct-nov-dec', syncStatus: null, bytes: 0, lastUsedAt: null },
    ])
    expect(out).toContain('cc-main-2026-jan-feb-mar')
    expect(out).toContain('ready')
    expect(out).toContain('unknown')
  })
})
