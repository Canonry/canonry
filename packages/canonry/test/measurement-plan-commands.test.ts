import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getMeasurementPlan = vi.fn()
const listMeasurementPlanVersions = vi.fn()
const getMeasurementPlanVersion = vi.fn()
const publishMeasurementPlan = vi.fn()
const retireMeasurementPlanSegment = vi.fn()
const discoverMeasurementTargets = vi.fn()
const getMeasurementReport = vi.fn()
const getMeasurementOverview = vi.fn()
const getMeasurementPropertyEvidence = vi.fn()
const getMeasurementSetup = vi.fn()
const getMeasurementQueryStatuses = vi.fn()
const listMeasurementQuerySets = vi.fn()
const getMeasurementPlanDraft = vi.fn()
const previewMeasurementDraftAssignments = vi.fn()
const applyMeasurementDraftAssignments = vi.fn()
const applyPairedMeasurementDraftAssignments = vi.fn()
const replaceMeasurementDraftAssignments = vi.fn()
const replaceMeasurementDraftQuery = vi.fn()
const previewMeasurementDraftGroupMembership = vi.fn()
const applyMeasurementDraftGroupMembership = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getMeasurementPlan,
    listMeasurementPlanVersions,
    getMeasurementPlanVersion,
    publishMeasurementPlan,
    retireMeasurementPlanSegment,
    discoverMeasurementTargets,
    getMeasurementReport,
    getMeasurementOverview,
    getMeasurementPropertyEvidence,
    getMeasurementSetup,
    getMeasurementQueryStatuses,
    listMeasurementQuerySets,
    getMeasurementPlanDraft,
    previewMeasurementDraftAssignments,
    applyMeasurementDraftAssignments,
    applyPairedMeasurementDraftAssignments,
    replaceMeasurementDraftAssignments,
    replaceMeasurementDraftQuery,
    previewMeasurementDraftGroupMembership,
    applyMeasurementDraftGroupMembership,
  }),
}))

const { MEASUREMENT_PLAN_CLI_COMMANDS } = await import('../src/cli-commands/measurement-plan.js')

const PLAN = {
  schemaVersion: 1,
  targets: [{
    stableKey: 'nyc-brand', label: 'New York brand', aliases: ['Example Solar'],
    urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/new-york', pathCase: 'sensitive' }],
  }],
  groups: [{
    stableKey: 'nyc', label: 'New York', targetKeys: ['nyc-brand'],
    competitors: ['rival.example'],
  }],
  targetQuerySelections: [],
}

/**
 * One Property whose Branded basket was never measured. It is the shape the
 * human output has to keep honest: a missing measurement, not a zero.
 */
const OVERVIEW = {
  mode: 'active-v2',
  scope: { kind: 'property', key: 'harbor-view', label: 'Harbor View' },
  queryClass: 'branded',
  measurement: { state: 'complete', displayedRunId: 'run-7', completed: 4, expected: 4 },
  nextAction: { kind: 'none' },
  metrics: {
    propertiesMentioned: { state: 'unavailable', reason: 'no_population' },
    mentionCoverage: { state: 'unavailable', reason: 'no_population' },
    citationCoverage: { state: 'unavailable', reason: 'no_population' },
    brandPresence: { state: 'unavailable', reason: 'no_population' },
    sov: { state: 'unavailable', reason: 'no_population' },
  },
  properties: {
    items: [{
      targetKey: 'harbor-view',
      label: 'Harbor View',
      mentionCoverage: { state: 'unavailable', reason: 'no_population' },
      citationCoverage: { state: 'unavailable', reason: 'no_population' },
      providers: [],
      flags: 0,
    }],
    nextCursor: null,
    totalEstimate: 1,
  },
  flags: { total: 0 },
}

const PROPERTY_EVIDENCE = {
  property: { targetKey: 'harbor-view', label: 'Harbor View' },
  queryClass: 'branded',
  measurement: { state: 'complete', displayedRunId: 'run-7' },
  evidence: {
    items: [{
      observationId: 'obs-1',
      expectedSlotId: 'slot-1',
      executionId: 'exec-1',
      usageEdgeId: 'target:harbor-view:q-1:exec-1',
      usageEdgeType: 'target',
      provider: 'openai',
      queryText: 'harbor view reviews',
      location: null,
      sourceUrl: 'https://example.com/locations/harbor-view',
      bridged: false,
      historical: false,
      evidenceComplete: true,
      classification: 'assigned',
      normalizedUrl: 'https://example.com/locations/harbor-view',
      matchedTargetIds: ['harbor-view'],
      matchedUrlIds: ['harbor-view:url:0'],
    }],
    nextCursor: null,
    totalEstimate: 1,
  },
}

const QUERY_STATUSES = {
  setupMode: 'active-v2',
  activeRevision: 7,
  latestOfficialFullRun: null,
  queries: [{ queryId: 'query-1', status: 'measured' }],
}

/**
 * The same run read as answers: one cited, one that named nobody, and one whose
 * text never landed. The three readings the human table has to keep apart.
 */
const PROPERTY_ANSWERS = {
  property: { targetKey: 'harbor-view', label: 'Harbor View' },
  queryClass: 'branded',
  measurement: { state: 'complete', displayedRunId: 'run-7' },
  answers: {
    items: [
      {
        observationId: 'obs-1',
        expectedSlotId: 'slot-1',
        executionId: 'exec-1',
        usageEdgeId: 'target:harbor-view:q-1:exec-1',
        usageEdgeType: 'target',
        provider: 'openai',
        queryText: 'harbor view reviews',
        location: null,
        queryClass: 'branded',
        mentioned: true,
        cited: true,
        sources: [{
          sourceUrl: 'https://example.com/locations/harbor-view',
          normalizedUrl: 'https://example.com/locations/harbor-view',
          classification: 'assigned',
          matchedTargetIds: ['harbor-view'],
          matchedUrlIds: ['harbor-view:url:0'],
        }],
        bridged: false,
        historical: false,
        evidenceComplete: true,
      },
      {
        observationId: 'obs-2',
        expectedSlotId: 'slot-2',
        executionId: 'exec-2',
        usageEdgeId: 'target:harbor-view:q-2:exec-2',
        usageEdgeType: 'target',
        provider: 'gemini',
        queryText: 'best harbor view stays',
        location: null,
        queryClass: 'branded',
        mentioned: false,
        cited: false,
        sources: [],
        bridged: false,
        historical: false,
        evidenceComplete: true,
      },
      {
        observationId: 'obs-3',
        expectedSlotId: 'slot-3',
        executionId: 'exec-3',
        usageEdgeId: 'target:harbor-view:q-3:exec-3',
        usageEdgeType: 'target',
        provider: 'openai',
        queryText: 'harbor view compared',
        location: null,
        queryClass: 'branded',
        mentioned: null,
        cited: false,
        sources: [],
        bridged: true,
        historical: false,
        evidenceComplete: false,
      },
    ],
    nextCursor: null,
    totalEstimate: 3,
  },
}

function command(pathname: string) {
  const found = MEASUREMENT_PLAN_CLI_COMMANDS.find(entry => entry.path.join(' ') === pathname)
  expect(found, pathname).toBeTruthy()
  return found!
}

describe('measurement-plan CLI commands', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    getMeasurementPlan.mockResolvedValue({ active: null })
    listMeasurementPlanVersions.mockResolvedValue({ versions: [] })
    getMeasurementPlanVersion.mockResolvedValue({ version: { revision: 1 } })
    publishMeasurementPlan.mockResolvedValue({ active: { revision: 1 } })
    retireMeasurementPlanSegment.mockResolvedValue({ stableKey: 'nyc', retiredAt: '2026-07-31T00:00:00.000Z' })
    discoverMeasurementTargets.mockResolvedValue({ proposed: [], aliases: [], shared: [], unmatched: [], excluded: [], diagnostics: [] })
    getMeasurementReport.mockResolvedValue({ revision: 1, run: null, groups: [], targets: [], evidence: [], diagnostics: {} })
    getMeasurementOverview.mockResolvedValue(OVERVIEW)
    getMeasurementPropertyEvidence.mockResolvedValue(PROPERTY_EVIDENCE)
    getMeasurementSetup.mockResolvedValue({ mode: 'active-v2' })
    getMeasurementQueryStatuses.mockResolvedValue(QUERY_STATUSES)
    listMeasurementQuerySets.mockResolvedValue({ querySets: [] })
    getMeasurementPlanDraft.mockResolvedValue({
      etag: '"mpd_7"',
      draft: { authoring: { targets: [{ stableKey: 'harbor-view', status: 'included' }] } },
    })
    previewMeasurementDraftAssignments.mockResolvedValue({
      draftEtag: '"mpd_8"',
      groups: [],
      resolvedTargetKeys: ['harbor-view'],
      overlapCount: 0,
      assignments: { requested: 1, added: 1, alreadyPresent: 0 },
      execution: { addedNodes: 1, addedProviderCalls: 2, fullRunNodes: 1, fullRunProviderCalls: 2 },
    })
    applyMeasurementDraftAssignments.mockResolvedValue({ etag: '"mpd_8"', changed: true })
    applyPairedMeasurementDraftAssignments.mockResolvedValue({ etag: '"mpd_8"', changed: true })
    replaceMeasurementDraftAssignments.mockResolvedValue({ etag: '"mpd_8"', changed: true })
    previewMeasurementDraftGroupMembership.mockResolvedValue({
      draftEtag: '"mpd_7"',
      sourceChecksum: 'a'.repeat(64),
      previewChecksum: 'b'.repeat(64),
      rows: [{ dataRow: 1, status: 'matched' }],
      counts: { needsAttention: 0 },
    })
    applyMeasurementDraftGroupMembership.mockResolvedValue({ appliedRows: 1, addedMemberships: 1 })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-plan-cli-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('registers show, versions, and publish with their stable usage forms', () => {
    expect(command('measurement-plan show').usage)
      .toBe('canonry measurement-plan show <project> [--revision N] [--format json]')
    expect(command('measurement-plan versions').usage)
      .toBe('canonry measurement-plan versions <project> [--format json]')
    expect(command('measurement-plan publish').usage)
      .toBe('canonry measurement-plan publish <project> <yaml|json|-> [--format json] (legacy schema v1 only; refuses over an active v2 plan; for Advanced Measurement use: canonry measurement-plan advanced <project> draft-action)')
    expect(command('measurement-plan retire').usage)
      .toBe('canonry measurement-plan retire <project> <stable-key> [--format json]')
    expect(command('measurement-plan advanced').usage)
      .toBe('canonry measurement-plan advanced <project> <operation> [<json|->] [--format json|jsonl]')
    expect(command('measurement-plan discover').usage)
      .toBe('canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N] [--format json]')
    expect(command('measurement-plan report').usage)
      .toBe('canonry measurement-plan report <project> --revision N [--format json]')
    expect(command('measurement-plan assignments apply').usage).toContain('--group KEY')
    expect(command('measurement-plan assignments preview').usage).toContain('--group KEY')
    expect(command('measurement-plan assignments replace').usage).toContain('--confirm')
    expect(command('measurement-plan groups preview').usage).toContain('<csv|->')
    expect(command('measurement-plan groups apply').usage).toContain('--confirm')
  })

  it('bridges the complete Advanced Measurement surface through typed JSON input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const inputPath = path.join(tmpDir, 'paired-assignments.json')
    fs.writeFileSync(inputPath, JSON.stringify({
      action: 'apply-paired-assignments',
      request: { pairs: [{ targetKey: 'harbor-view', queryId: 'query-1' }] },
      etag: '"mpd_7"',
      idempotencyKey: 'request-1',
    }))

    await command('measurement-plan advanced').run({
      positionals: ['acme', 'setup'], values: {}, format: 'json', dryRun: false,
    })
    expect(getMeasurementSetup).toHaveBeenCalledWith('acme')

    await command('measurement-plan advanced').run({
      positionals: ['acme', 'draft-action', inputPath], values: {}, format: 'json', dryRun: false,
    })
    expect(applyPairedMeasurementDraftAssignments).toHaveBeenCalledWith(
      'acme',
      { pairs: [{ targetKey: 'harbor-view', queryId: 'query-1' }] },
      'request-1',
      '"mpd_7"',
    )

    expect(() => command('measurement-plan advanced').run({
      positionals: ['acme', 'nope'], values: {}, format: 'json', dryRun: false,
    })).toThrow('unsupported Advanced Measurement operation')
  })

  it('edits query text through the same guarded draft action used by the UI', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const inputPath = path.join(tmpDir, 'replace-query.json')
    const request = { queryId: 'query-1', queryText: 'Quiet apartments near transit' }
    fs.writeFileSync(inputPath, JSON.stringify({
      action: 'replace-query', request, etag: '"mpd_7"', idempotencyKey: 'replace-request-1',
    }))
    await command('measurement-plan advanced').run({
      positionals: ['acme', 'draft-action', inputPath], values: {}, format: 'json', dryRun: false,
    })
    expect(replaceMeasurementDraftQuery).toHaveBeenCalledWith('acme', request, 'replace-request-1', '"mpd_7"')
    expect(publishMeasurementPlan).not.toHaveBeenCalled()
  })

  it('reads server-derived per-query statuses through the Advanced Measurement CLI bridge', async () => {
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan advanced').run({
      positionals: ['acme', 'query-statuses'], values: {}, format: 'json', dryRun: false,
    })

    log.mockRestore()
    expect(getMeasurementQueryStatuses).toHaveBeenCalledWith('acme')
    expect(JSON.parse(logged.join('\n'))).toEqual(QUERY_STATUSES)
  })

  it('streams Advanced Measurement collections as JSONL with paging context', async () => {
    listMeasurementQuerySets.mockResolvedValueOnce({
      querySets: [{ id: 'set-1', name: 'Core questions' }],
    })
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true })

    await command('measurement-plan advanced').run({
      positionals: ['acme', 'query-sets'], values: {}, format: 'jsonl', dryRun: false,
    })

    write.mockRestore()
    expect(written.join('').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { kind: 'measurement-advanced-header', operation: 'query-sets' },
      { id: 'set-1', name: 'Core questions' },
    ])
  })

  it('previews then applies one server-resolved assignment audience', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await command('measurement-plan assignments apply').run({
      positionals: ['acme'],
      values: { group: ['dallas'], 'query-id': ['query-1', 'query-2'] },
      format: 'json',
      dryRun: false,
    })

    const request = { groupKeys: ['dallas'], queryIds: ['query-1', 'query-2'] }
    expect(previewMeasurementDraftAssignments).toHaveBeenCalledWith('acme', request)
    expect(applyMeasurementDraftAssignments).toHaveBeenCalledWith(
      'acme', request, expect.any(String), '"mpd_8"',
    )
  })

  it('exposes read-only assignment preview and confirmed atomic replacement', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await command('measurement-plan assignments preview').run({
      positionals: ['acme'],
      values: { 'all-properties': true, 'query-id': ['query-1'] },
      format: 'json',
      dryRun: false,
    })
    expect(previewMeasurementDraftAssignments).toHaveBeenCalledWith('acme', {
      targetKeys: ['harbor-view'],
      queryIds: ['query-1'],
    })

    await command('measurement-plan assignments replace').run({
      positionals: ['acme'],
      values: { group: ['dallas'], 'query-id': ['query-1'], confirm: true },
      format: 'json',
      dryRun: false,
    })
    expect(replaceMeasurementDraftAssignments).toHaveBeenCalledWith(
      'acme',
      { groupKeys: ['dallas'], queryIds: ['query-1'] },
      expect.any(String),
      '"mpd_8"',
    )
  })

  it('requires skipped-row acknowledgement before any selected-row CSV write', async () => {
    const csvPath = path.join(tmpDir, 'groups.csv')
    fs.writeFileSync(csvPath, 'property,group\nHarbor View,Dallas\nMissing,Austin')
    previewMeasurementDraftGroupMembership.mockResolvedValueOnce({
      draftEtag: '"mpd_7"',
      sourceChecksum: 'a'.repeat(64),
      previewChecksum: 'b'.repeat(64),
      rows: [{ dataRow: 1, status: 'matched' }, { dataRow: 2, status: 'unmatched' }],
      counts: { needsAttention: 1 },
    })

    await expect(command('measurement-plan groups apply').run({
      positionals: ['acme', csvPath],
      values: { confirm: true, 'accept-row': ['1'] },
      format: 'json',
      dryRun: false,
    })).rejects.toThrow('--acknowledge-skipped')
    expect(applyMeasurementDraftGroupMembership).not.toHaveBeenCalled()
  })

  it('reviews CSV again and applies only the confirmed matched rows', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const csvPath = path.join(tmpDir, 'groups.csv')
    fs.writeFileSync(csvPath, 'property,group\nHarbor View,Dallas')

    await command('measurement-plan groups apply').run({
      positionals: ['acme', csvPath],
      values: { confirm: true, 'accept-all-matched': true },
      format: 'json',
      dryRun: false,
    })

    expect(previewMeasurementDraftGroupMembership).toHaveBeenCalledWith('acme', {
      csv: 'property,group\nHarbor View,Dallas',
    })
    expect(applyMeasurementDraftGroupMembership).toHaveBeenCalledWith('acme', {
      csv: 'property,group\nHarbor View,Dallas',
      sourceChecksum: 'a'.repeat(64),
      previewChecksum: 'b'.repeat(64),
      acceptedRows: [1],
    }, expect.any(String), '"mpd_7"')
  })

  it('requires explicit audience and CSV apply confirmation', () => {
    expect(() => command('measurement-plan assignments apply').run({
      positionals: ['acme'], values: { 'query-id': ['query-1'] }, format: 'json', dryRun: false,
    })).toThrow('select at least one')
    expect(() => command('measurement-plan groups apply').run({
      positionals: ['acme', 'groups.csv'], values: { 'accept-all-matched': true }, format: 'json', dryRun: false,
    })).toThrow('--confirm is required')
    expect(() => command('measurement-plan assignments replace').run({
      positionals: ['acme'], values: { group: ['dallas'], 'query-id': ['query-1'] }, format: 'json', dryRun: false,
    })).toThrow('--confirm is required')
  })

  it('retires a stable measurement segment key', async () => {
    await command('measurement-plan retire').run({ positionals: ['acme', 'old-nyc'], values: {}, format: 'json' } as never)
    expect(retireMeasurementPlanSegment).toHaveBeenCalledWith('acme', 'old-nyc')
  })

  it('reads the active plan by default and an immutable revision when requested', async () => {
    await command('measurement-plan show').run({
      positionals: ['acme'], values: {}, format: 'json', dryRun: false,
    })
    expect(getMeasurementPlan).toHaveBeenCalledWith('acme')

    await command('measurement-plan show').run({
      positionals: ['acme'], values: { revision: '2' }, format: 'json', dryRun: false,
    })
    expect(getMeasurementPlanVersion).toHaveBeenCalledWith('acme', 2)

    await command('measurement-plan versions').run({
      positionals: ['acme'], values: {}, format: 'json', dryRun: false,
    })
    expect(listMeasurementPlanVersions).toHaveBeenCalledWith('acme')
  })

  it.each([
    ['JSON', 'plan.json', JSON.stringify(PLAN, null, 2)],
    ['YAML', 'plan.yaml', `schemaVersion: 1\ntargets:\n  - stableKey: nyc-brand\n    label: New York brand\n    aliases:\n      - Example Solar\n    urls:\n      - kind: prefix\n        host: example.com\n        pathPrefix: /new-york\n        pathCase: sensitive\ngroups:\n  - stableKey: nyc\n    label: New York\n    targetKeys:\n      - nyc-brand\n    competitors:\n      - rival.example\n`],
  ])('parses and publishes %s input without changing its plan payload', async (_label, filename, contents) => {
    const inputPath = path.join(tmpDir, filename)
    fs.writeFileSync(inputPath, contents)

    await command('measurement-plan publish').run({
      positionals: ['acme', inputPath], values: {}, format: 'json', dryRun: false,
    })

    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: null,
      plan: PLAN,
    })
  })

  it('accepts - as stdin input for publish', async () => {
    const readFile = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(PLAN))

    await command('measurement-plan publish').run({
      positionals: ['acme', '-'], values: {}, format: 'json', dryRun: false,
    })

    expect(readFile).toHaveBeenCalledWith(0, 'utf8')
    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: null,
      plan: PLAN,
    })
  })

  it('publishes against the active revision read immediately before the write', async () => {
    const inputPath = path.join(tmpDir, 'plan.json')
    fs.writeFileSync(inputPath, JSON.stringify(PLAN))
    getMeasurementPlan.mockResolvedValueOnce({ active: { revision: 4 } })

    await command('measurement-plan publish').run({
      positionals: ['acme', inputPath], values: {}, format: 'json', dryRun: false,
    })

    expect(getMeasurementPlan).toHaveBeenCalledWith('acme')
    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: 4,
      plan: PLAN,
    })
  })

  it.each([
    ['JSON', 'rule.json', JSON.stringify({
      primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
      aliases: [{ host: 'directory.example', pathTemplate: '/{slug}' }],
    })],
    ['YAML', 'rule.yaml', [
      'primary:',
      '  host: example.com',
      '  pathTemplate: /locations/{slug}',
      'aliases:',
      '  - host: directory.example',
      '    pathTemplate: /{slug}',
      '',
    ].join('\n')],
  ])('discovers targets from a sitemap using a validated %s rule', async (_label, filename, contents) => {
    const rulePath = path.join(tmpDir, filename)
    fs.writeFileSync(rulePath, contents)

    await command('measurement-plan discover').run({
      positionals: ['acme'],
      values: {
        'sitemap-url': 'https://example.com/sitemap.xml',
        rule: rulePath,
        'max-urls': '250',
      },
      format: 'json',
      dryRun: false,
    })

    expect(discoverMeasurementTargets).toHaveBeenCalledWith('acme', {
      sitemapUrl: 'https://example.com/sitemap.xml',
      maxUrls: 250,
      rule: {
        primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
        aliases: [{ host: 'directory.example', pathTemplate: '/{slug}' }],
      },
    })
  })

  it('requires a positive discovery cap and report revision', async () => {
    const rulePath = path.join(tmpDir, 'rule.json')
    fs.writeFileSync(rulePath, JSON.stringify({
      primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
    }))

    expect(() => command('measurement-plan discover').run({
      positionals: ['acme'],
      values: {
        'sitemap-url': 'https://example.com/sitemap.xml',
        rule: rulePath,
        'max-urls': '0',
      },
      format: 'json',
      dryRun: false,
    })).toThrow('--max-urls must be an integer from 1 to 10000')

    expect(() => command('measurement-plan report').run({
      positionals: ['acme'], values: { revision: 'nope' }, format: 'json', dryRun: false,
    })).toThrow('--revision must be a positive integer')
  })

  it('reads a revision-pinned measurement report', async () => {
    await command('measurement-plan report').run({
      positionals: ['acme'], values: { revision: '3' }, format: 'json', dryRun: false,
    })

    expect(getMeasurementReport).toHaveBeenCalledWith('acme', 3)
  })

  it('reads one Property through the property scope of the overview', async () => {
    await command('measurement-plan property').run({
      positionals: ['acme'],
      values: { 'target-key': 'harbor-view', 'query-class': 'branded', provider: 'openai', 'run-id': 'run-7' },
      format: 'json',
      dryRun: false,
    })

    expect(getMeasurementOverview).toHaveBeenCalledWith('acme', {
      scope: 'property',
      targetKey: 'harbor-view',
      queryClass: 'branded',
      provider: 'openai',
      runId: 'run-7',
    })
  })

  it('prints --format json byte-for-byte so an agent can swap the CLI for the endpoint', async () => {
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view' }, format: 'json', dryRun: false,
    })

    log.mockRestore()
    expect(JSON.parse(logged.join('\n'))).toEqual(OVERVIEW)
  })

  it('renders an unmeasured Property as not measured and never as a percentage', async () => {
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view' }, format: 'text', dryRun: false,
    })

    log.mockRestore()
    const output = logged.join('\n')
    expect(output).toContain('not measured (no questions of this type)')
    expect(output).not.toMatch(/\d+%/)
  })

  it('labels ambiguous source-to-Property matches consistently', async () => {
    getMeasurementOverview.mockResolvedValueOnce({
      ...OVERVIEW,
      properties: {
        ...OVERVIEW.properties,
        items: [{ ...OVERVIEW.properties.items[0], flags: 2 }],
      },
      flags: { total: 2 },
    })
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view' }, format: 'text', dryRun: false,
    })

    log.mockRestore()
    const output = logged.join('\n')
    expect(output).toContain('Ambiguous  2 source-to-Property matches')
    expect(output).not.toContain('Flagged')
  })

  it('rejects a question class outside the published vocabulary', () => {
    expect(() => command('measurement-plan property').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', 'query-class': 'brand' }, format: 'json', dryRun: false,
    })).toThrow('--query-class must be one of all, branded, non-brand')
  })

  it('pages one Property\'s evidence with the same filters as the overview read', async () => {
    await command('measurement-plan property-evidence').run({
      positionals: ['acme'],
      values: { 'target-key': 'harbor-view', 'query-class': 'branded', cursor: 'next-page', limit: '25' },
      format: 'json',
      dryRun: false,
    })

    expect(getMeasurementPropertyEvidence).toHaveBeenCalledWith('acme', {
      targetKey: 'harbor-view',
      queryClass: 'branded',
      cursor: 'next-page',
      limit: 25,
    })

    expect(() => command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', limit: '500' }, format: 'json', dryRun: false,
    })).toThrow('--limit must be an integer from 1 to 100')
  })

  it('says an unmeasured Property was not measured rather than showing an empty evidence table', async () => {
    getMeasurementPropertyEvidence.mockResolvedValueOnce({
      ...PROPERTY_EVIDENCE,
      measurement: { state: 'not_measured' },
      evidence: { items: [], nextCursor: null, totalEstimate: 0 },
    })
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view' }, format: 'text', dryRun: false,
    })

    log.mockRestore()
    const output = logged.join('\n')
    expect(output).toContain('Not measured yet.')
    expect(output).not.toContain('No source evidence matched')
  })

  it('passes the evidence shape through and refuses one outside the published vocabulary', async () => {
    await command('measurement-plan property-evidence').run({
      positionals: ['acme'],
      values: { 'target-key': 'harbor-view', shape: 'answers' },
      format: 'json',
      dryRun: false,
    })

    expect(getMeasurementPropertyEvidence).toHaveBeenCalledWith('acme', { targetKey: 'harbor-view', shape: 'answers' })

    expect(() => command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', shape: 'urls' }, format: 'json', dryRun: false,
    })).toThrow('--shape must be one of sources, answers')
  })

  it('prints the answer shape as --format json byte-for-byte, exactly as it does the source shape', async () => {
    getMeasurementPropertyEvidence.mockResolvedValueOnce(PROPERTY_ANSWERS)
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', shape: 'answers' }, format: 'json', dryRun: false,
    })

    log.mockRestore()
    expect(JSON.parse(logged.join('\n'))).toEqual(PROPERTY_ANSWERS)
  })

  it('streams one JSONL object per source row under a header that names the shape', async () => {
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view' }, format: 'jsonl', dryRun: false,
    })

    write.mockRestore()
    const lines = written.join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      kind: 'measurement-property-evidence-header',
      shape: 'sources',
      property: PROPERTY_EVIDENCE.property,
      queryClass: 'branded',
      measurement: PROPERTY_EVIDENCE.measurement,
      totalEstimate: 1,
      nextCursor: null,
    })
    expect(lines[1]).toEqual(PROPERTY_EVIDENCE.evidence.items[0])
  })

  it('streams one JSONL object per ANSWER with its sources inlined', async () => {
    getMeasurementPropertyEvidence.mockResolvedValueOnce(PROPERTY_ANSWERS)
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', shape: 'answers' }, format: 'jsonl', dryRun: false,
    })

    write.mockRestore()
    const lines = written.join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    // One header plus one line per answer, INCLUDING the two that cited nothing:
    // a stream that dropped them would be the flat shape under a new name.
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({ kind: 'measurement-property-evidence-header', shape: 'answers', totalEstimate: 3 })
    expect(lines.slice(1)).toEqual(PROPERTY_ANSWERS.answers.items)
    expect(lines[2]!.sources).toEqual([])
    expect(lines[3]!.mentioned).toBeNull()
  })

  it('keeps the not-measured header in both shapes, with no rows behind it', async () => {
    for (const shape of ['sources', 'answers'] as const) {
      getMeasurementPropertyEvidence.mockResolvedValueOnce({
        property: PROPERTY_EVIDENCE.property,
        queryClass: 'branded',
        measurement: { state: 'not_measured' },
        ...(shape === 'answers'
          ? { answers: { items: [], nextCursor: null, totalEstimate: 0 } }
          : { evidence: { items: [], nextCursor: null, totalEstimate: 0 } }),
      })
      const written: string[] = []
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true })

      await command('measurement-plan property-evidence').run({
        positionals: ['acme'], values: { 'target-key': 'harbor-view', shape }, format: 'jsonl', dryRun: false,
      })

      write.mockRestore()
      const lines = written.join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(lines, shape).toHaveLength(1)
      // The header is the only thing that tells a row stream apart from an
      // unmeasured Property, in either shape.
      expect(lines[0], shape).toMatchObject({ shape, measurement: { state: 'not_measured' }, totalEstimate: 0 })
    }
  })

  it('renders both signals per answer and says not measured where the mention is unknown', async () => {
    getMeasurementPropertyEvidence.mockResolvedValueOnce(PROPERTY_ANSWERS)
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', shape: 'answers' }, format: 'text', dryRun: false,
    })

    log.mockRestore()
    const output = logged.join('\n')
    expect(output).toContain('Mentioned')
    expect(output).toContain('Cited')
    // The answer that cited nobody is a row, not an omission.
    expect(output).toContain('best harbor view stays')
    // An unknown mention never renders as a measured "no".
    expect(output).toContain('not measured')
  })

  it('says a measured Property matched no ANSWERS, not no source evidence, in the answer shape', async () => {
    getMeasurementPropertyEvidence.mockResolvedValueOnce({
      ...PROPERTY_ANSWERS,
      answers: { items: [], nextCursor: null, totalEstimate: 0 },
    })
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)) })

    await command('measurement-plan property-evidence').run({
      positionals: ['acme'], values: { 'target-key': 'harbor-view', shape: 'answers' }, format: 'text', dryRun: false,
    })

    log.mockRestore()
    const output = logged.join('\n')
    // A measured Property with no answers in the filter is not a Property whose
    // answers cited nothing, and the source wording says the wrong one.
    expect(output).toContain('No answers matched this Property in the displayed run.')
    expect(output).not.toContain('No source evidence matched')
  })
})
