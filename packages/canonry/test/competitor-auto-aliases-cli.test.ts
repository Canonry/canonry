import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { apiKeys, competitors, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json, measurementPlanV2Schema, type CompetitorAutoAliasDetectionDto, type CompetitorDto } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli } from './cli-test-utils.js'

// `canonry competitor aliases detect` and `--block` / `--unblock` against a
// real server reading fictional stored answers in the OpenAI response shape:
// the names come from the answers' own citations, never from a website.

const CHIP = ' ([spoketuneworks.example](https://spoketuneworks.example/?utm_source=openai))'
const TEXT = `Top shops:\n- **TuneSpoke** - mobile tune-ups${CHIP}\n- **Gearloft** - parts.\n`

function openAiEnvelope(text: string): string {
  const start = text.indexOf(CHIP)
  return JSON.stringify({
    model: 'gpt-test',
    servedModel: 'gpt-test',
    groundingSources: [{ uri: 'https://spoketuneworks.example/?utm_source=openai', title: 'TuneSpoke' }],
    searchQueries: ['bike tune-ups'],
    apiResponse: {
      output: [
        { type: 'web_search_call', action: { type: 'search', query: 'bike tune-ups' } },
        { type: 'message', content: [{ type: 'output_text', text, logprobs: [], annotations: [
          { type: 'url_citation', start_index: start, end_index: start + CHIP.length, url: 'https://spoketuneworks.example/?utm_source=openai', title: 'TuneSpoke' },
        ] }] },
      ],
    },
  })
}

describe('competitor auto-alias CLI', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let client: ApiClient
  let db: DatabaseClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-competitor-auto-aliases-cli-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()
    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKeyPlain)
    await client.putProject('rotorwise', { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' })
    await client.appendCompetitors('rotorwise', [{ domain: 'qvx.example', aliases: ['QVX'] }])

    // Three sweeps whose answers pair "TuneSpoke" with spoketuneworks.example,
    // each next to two answers that name and cite no tracked competitor.
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    const queryId = crypto.randomUUID()
    db.insert(queries).values({ id: queryId, projectId, query: 'best bike tune-up', createdAt: '2026-09-01T00:00:00.000Z' }).run()
    for (const day of ['01', '08', '15']) {
      const runId = crypto.randomUUID()
      const at = `2026-09-${day}T00:00:00.000Z`
      db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider: 'openai', citationState: 'not-cited', answerMentioned: false,
        answerText: TEXT, citedDomains: ['spoketuneworks.example'], rawResponse: openAiEnvelope(TEXT), createdAt: at,
      }).run()
      for (let other = 0; other < 2; other++) {
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(), runId, queryId, provider: 'openai', citationState: 'not-cited', answerMentioned: false,
          answerText: 'Check your tire pressure before every ride.', citedDomains: ['ridersguide.example'], createdAt: at,
        }).run()
      }
    }
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function addTracked(domain: string): void {
    // Added after the snapshots, through the DB, so no rescan races the test.
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, provenance: 'cli', createdAt: '2026-09-01T00:00:00.000Z' }).run()
  }

  it('dry-runs detection with evidence, then applies it with --apply', async () => {
    addTracked('spoketuneworks.example')
    const dry = await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--format', 'json'])
    expect(dry.exitCode, dry.stderr).toBeUndefined()
    const preview = JSON.parse(dry.stdout) as CompetitorAutoAliasDetectionDto
    expect(preview).toMatchObject({ project: 'rotorwise', applied: false, changed: true, scan: { runs: 3, snapshots: 9, answers: 9, providerCitations: true } })
    const spoke = preview.competitors.find(competitor => competitor.domain === 'spoketuneworks.example')!
    expect(spoke.added).toEqual(['TuneSpoke'])
    expect(spoke.candidates[0]).toMatchObject({
      name: 'TuneSpoke', status: 'added', directPairs: 3, runs: 3, namingAnswers: 3, citingAnswers: 3, nameCasedAnswers: 3, precision: 1, lift: 8, via: ['openai-annotation'],
    })
    // A dry run stores nothing.
    expect((await client.listCompetitors('rotorwise')).find(c => c.domain === 'spoketuneworks.example')!.autoAliases).toEqual([])

    const applied = JSON.parse((await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--apply', '--format', 'json'])).stdout) as CompetitorAutoAliasDetectionDto
    expect(applied).toMatchObject({ applied: true, changed: true })
    const stored = (await client.listCompetitors('rotorwise')).find(c => c.domain === 'spoketuneworks.example')!
    expect(stored.autoAliases).toEqual([expect.objectContaining({ name: 'TuneSpoke', directPairs: 3, runs: 3, namingAnswers: 3, precision: 1 })])

    // Applying again over unchanged answers changes nothing.
    const again = JSON.parse((await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--apply', '--format', 'json'])).stdout) as CompetitorAutoAliasDetectionDto
    expect(again.changed).toBe(false)

    const text = (await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example'])).stdout
    expect(text).toBe([
      'Aliases for spoketuneworks.example: (none)',
      'Auto-detected from stored answers:',
      '  TuneSpoke  (paired in 3 answers over 3 sweeps; 100% of 3 answers naming it cite the site (8x the rate in answers that do not name it); written as a name in 3; co-occurs in 3; seen 2026-09-01 to 2026-09-15)',
      'Blocked from auto-detection: (none)',
    ].join('\n'))
    expect((await invokeCli(['competitor', 'list', 'rotorwise'])).stdout).toContain('  spoketuneworks.example  (auto: TuneSpoke)')
  })

  it('streams one competitor per line with --format jsonl and prints a legend in text', async () => {
    addTracked('spoketuneworks.example')
    // jsonl goes straight to process.stdout (one write), not console.log.
    let written = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk)
      return true
    })
    try {
      expect((await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--format', 'jsonl'])).exitCode).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    const lines = written.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => [line.project, line.applied, line.domain])).toEqual([
      ['rotorwise', false, 'qvx.example'],
      ['rotorwise', false, 'spoketuneworks.example'],
    ])
    const text = (await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise'])).stdout
    expect(text).toContain('Competitor auto-alias detection for "rotorwise" (dry run, nothing stored)')
    expect(text).toContain('Legend: + added  = kept  - removed  ? review only  x rejected')
    expect(text).toContain('  + TuneSpoke  (paired in 3 answers over 3 sweeps;')
    expect(text).toContain('Applies a name paired with the site in 2+ answers over 2+ sweeps, named in 3+ answers, precision 10.0%+, cited 3x+ more often when named than otherwise, written as a name in 75.0%+ of them, 2x any other competitor\'s pairings, 4+ letters or digits, and visibly tied to the domain')
    expect(text).toContain('Run with --apply to store these changes now')
  })

  it('blocks and unblocks names by brand key, and refuses to block a curated alias', async () => {
    addTracked('spoketuneworks.example')
    await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--apply', '--format', 'json'])

    const blocked = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--block', 'Tune Spoke', '--format', 'json'])
    expect(blocked.exitCode, blocked.stderr).toBeUndefined()
    expect(JSON.parse(blocked.stdout) as CompetitorDto).toMatchObject({ domain: 'spoketuneworks.example', aliases: [], autoAliases: [], blockedAliases: ['Tune Spoke'] })
    const preview = JSON.parse((await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--format', 'json'])).stdout) as CompetitorAutoAliasDetectionDto
    expect(preview.competitors.find(c => c.domain === 'spoketuneworks.example')!.candidates)
      .toEqual([expect.objectContaining({ name: 'TuneSpoke', status: 'rejected', reason: 'blocked' })])

    const unblocked = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--unblock', 'tunespoke', '--format', 'json'])
    expect(JSON.parse(unblocked.stdout)).toMatchObject({ blockedAliases: [] })

    const curated = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--block', 'qvx', '--format', 'json'])
    expect(curated.exitCode).toBe(1)
    expect(JSON.parse(curated.stderr).error).toMatchObject({ code: 'VALIDATION_ERROR', details: { domain: 'qvx.example', curated: ['qvx'] } })

    const mixed = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--block', 'Quiet Vox', '--add', 'QVX Depot', '--format', 'json'])
    expect(mixed.exitCode).toBe(1)
    expect(JSON.parse(mixed.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR', message: '--block and --unblock cannot be combined with each other or with --set/--add/--remove/--clear' })
  })

  it('detects and blocks names of a competitor only an Advanced market pins, and says so', async () => {
    // The stored sweeps become plan runs whose questions the "north" market
    // measures; the market pins spoketuneworks.example without tracking it.
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    const nodes = ['north-0', 'north-1', 'north-2']
    const plan = measurementPlanV2Schema.parse({
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'rotorwise.example', ownedHosts: ['rotorwise.example'], names: ['Rotorwise'] } },
      targets: [{ stableKey: 'north-shop', label: 'North shop', aliases: ['North shop'], urlMatchers: [{ kind: 'host', host: 'rotorwise.example' }], mentionNotApplicable: false, discoveryIdentity: null }],
      groups: [{ stableKey: 'north', label: 'North', targetKeys: ['north-shop'], competitors: [{ stableKey: 'spoke', label: 'Spoke Tune Works', domain: 'spoketuneworks.example', aliases: [] }] }],
      querySnapshots: nodes.map(node => ({ queryId: `q-${node}`, queryText: `bike tune-up ${node}`, provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-01T00:00:00.000Z' } })),
      assignments: nodes.map(node => ({ targetKey: 'north-shop', queryId: `q-${node}`, queryClass: 'non-brand', executionNodeKey: `exec-${node}` })),
      executionNodes: nodes.map(node => ({ stableKey: `exec-${node}`, queryId: `q-${node}`, queryText: `bike tune-up ${node}`, context: { providers: ['openai'], models: {}, location: null }, expectedSnapshots: 1 })),
      usageEdges: nodes.map(node => ({ executionNodeKey: `exec-${node}`, targetKey: 'north-shop', queryId: `q-${node}` })),
      compiledChecksum: 'a'.repeat(64),
    })
    const canonicalJson = canonicalMeasurementPlanV2Json(plan)
    db.insert(measurementPlanVersions).values({
      id: 'plan-1', projectId, revision: 1, canonicalJson, checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
      schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: '2026-09-01T00:00:00.000Z',
    }).run()
    db.insert(measurementPlans).values({ projectId, activeVersionId: 'plan-1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }).run()
    for (const run of db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, projectId)).all()) {
      db.update(runs).set({ measurementPlanVersionId: 'plan-1' }).where(eq(runs.id, run.id)).run()
      db.select({ id: querySnapshots.id }).from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all().forEach((snapshot, index) => {
        db.update(querySnapshots).set({ measurementExecutionId: `exec-${nodes[index]}` }).where(eq(querySnapshots.id, snapshot.id)).run()
      })
    }

    const text = (await invokeCli(['competitor', 'aliases', 'detect', 'rotorwise', '--apply'])).stdout
    expect(text).toContain('\nspoketuneworks.example  (Advanced markets: north)\n  plan names: Spoke Tune Works\n  + TuneSpoke  (paired in 3 answers over 3 sweeps;')
    // Never tracked project-wide.
    expect((await client.listCompetitors('rotorwise')).map(competitor => competitor.domain)).toEqual(['qvx.example'])

    const blocked = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--block', 'TuneSpoke'])
    expect(blocked.exitCode, blocked.stderr).toBeUndefined()
    expect(blocked.stdout).toBe([
      'Plan names for spoketuneworks.example (Advanced markets: north): Spoke Tune Works',
      'Auto-detected from stored answers: (none)',
      'Blocked from auto-detection: TuneSpoke',
    ].join('\n'))

    // Reading it by domain points at detect and block or unblock, and offers
    // a project-wide add only as the way to drop its market boundary.
    const read = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example'])
    expect(read.exitCode).toBe(1)
    expect(read.stderr).toContain('is not a project competitor of "rotorwise"')
    expect(read.stderr).toContain('canonry competitor aliases detect rotorwise')
    expect(read.stderr).toContain('canonry competitor aliases rotorwise spoketuneworks.example --block <name>')
    expect(read.stderr).toContain('To track it in every market instead (it then counts outside its markets): canonry competitor add rotorwise spoketuneworks.example')
    expect(read.stderr).not.toContain('Add it with')
  })
})
