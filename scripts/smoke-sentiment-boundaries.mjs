/** Installed S16–S18 read smoke. Workspace imports below ONLY construct synthetic stored fixtures.
 * Classifier outputs are seeded offline: this is not a Jev request/parser or quality test.
 * Run with tsx and --package-root <scratch>/node_modules/@canonry/canonry. Never accepts a live key.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createClient, queries, querySnapshots, runs, simpleMeasurementDefinitions, SentimentRepository } from '../packages/db/src/index.js'
import { sentimentClassifierInputSchema } from '../packages/contracts/src/index.js'
import { SentimentService } from '../packages/api-routes/src/sentiment-service.js'
import { seedSentimentSmoke, SMOKE_ADMIN, SMOKE_NOW } from './sentiment-smoke-seed.js'

const args = process.argv.slice(2)
assert(args.length === 2 && args[0] === '--package-root', 'Only --package-root is accepted; this smoke never uses live provider credentials.')
const packageRoot = await realpath(args[1])
const checkout = await realpath(fileURLToPath(new URL('../', import.meta.url)))
assert(!packageRoot.startsWith(`${checkout}/`) && packageRoot.includes('/node_modules/@canonry/canonry'), 'Use a scratch tarball installation outside the checkout')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@canonry/canonry')
const scratch = await mkdtemp(path.join(tmpdir(), 'canonry-sentiment-boundaries-'))
const database = path.join(scratch, 'synthetic.sqlite')
const receiptPath = path.join(scratch, 'provider-receipts.jsonl')
const providerKey = 'synthetic-boundary-provider-key'
const checks = []
const mark = value => { checks.push(value); console.log(`PASS ${value}`) }
const safe = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const key of [SMOKE_ADMIN, providerKey]) assert(!text.includes(key), 'A synthetic credential leaked into output') }
const redact = value => String(value).replaceAll(SMOKE_ADMIN, '[REDACTED]').replaceAll(providerKey, '[REDACTED]')

// This function runs before any installed process starts. No source implementation answers test reads.
function seedStoredFixtures() {
  const { eq } = createRequire(new URL('../packages/db/package.json', import.meta.url))('drizzle-orm')
  seedSentimentSmoke(database)
  const db = createClient(database)
  let clock = SMOKE_NOW
  const service = new SentimentService(db, { install: () => ({ enabled: true, ready: true, model: 'jev-1.13.0', reason: null }), now: () => new Date(clock), previewSecret: 'offline-fixture-token-secret' })
  const repository = new SentimentRepository(db)
  const theme = description => [{ id: 'historic-topic', name: 'Historic topic', description }]
  function copyRun(project, originalId, runId, { servedModel, differentQuery = false } = {}) {
    const original = db.select().from(runs).where(eq(runs.id, originalId)).get()
    assert(original)
    db.insert(runs).values({ ...original, id: runId, createdAt: clock }).run()
    const frozen = db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, originalId)).get()
    const queryId = differentQuery ? 'changed-query' : null
    if (queryId) db.insert(queries).values({ id: queryId, projectId: project, query: 'Aurora Service different question', createdAt: clock }).run()
    if (frozen) {
      const definition = structuredClone(frozen.definition)
      if (queryId) definition.queries = definition.queries.map(query => ({ ...query, queryId, queryText: 'Aurora Service different question' }))
      db.insert(simpleMeasurementDefinitions).values({ ...frozen, runId, definition, checksum: createHash('sha256').update(JSON.stringify(definition)).digest('hex') }).run()
    }
    for (const snapshot of db.select().from(querySnapshots).where(eq(querySnapshots.runId, originalId)).all()) db.insert(querySnapshots).values({ ...snapshot, id: `${runId}-${snapshot.id}`, runId, ...(servedModel ? { servedModel } : {}), ...(queryId ? { queryId, queryText: 'Aurora Service different question' } : {}) }).run()
  }
  function complete(project, runId, outcome = 'favorable') {
    const preview = service.preview(project, { runId })
    assert(preview.previewToken)
    service.submit(project, preview.previewToken, `${runId}-${preview.evaluationDefinitionId}`, 'synthetic-fixture')
    for (;;) {
      const work = repository.claim({ owner: 'offline-fixture', projectId: project, now: clock, leaseMs: 30_000 })
      if (!work) break
      const input = sentimentClassifierInputSchema.parse(work.input)
      const result = { kind: 'classified', outcome, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null, returnedModel: 'jev-1.13.0', usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, themes: input.definition.themes.map(item => ({ themeId: item.id, discussed: false, praised: false, criticized: false, evidence: { discussed: [], praised: [], criticized: [] }, reason: null })) }
      assert(repository.completeWork({ workItemId: work.id, owner: 'offline-fixture', now: clock, outcome, result, returnedModel: result.returnedModel }))
    }
  }
  try {
    const original = {}
    for (const project of ['simple', 'advanced']) original[project] = service.configure(project, { enabled: true, customThemes: theme('Original historical topic wording.') }).evaluationDefinitionId
    copyRun('simple', 'simple-run', 'model-change', { servedModel: 'source-model-v2' })
    copyRun('simple', 'simple-run', 'population-change', { differentQuery: true })
    copyRun('simple', 'simple-run', 'evaluation-change')
    copyRun('advanced', 'advanced-run', 'advanced-other')
    for (const runId of ['simple-run', 'model-change', 'population-change']) complete('simple', runId, runId === 'simple-run' ? 'favorable' : 'unfavorable')
    complete('advanced', 'advanced-run'); complete('advanced', 'advanced-other')
    clock = '2026-09-28T00:01:00.000Z'
    const changed = {}
    for (const project of ['simple', 'advanced']) changed[project] = service.configure(project, { customThemes: theme('Changed evaluator topic wording.') }).evaluationDefinitionId
    complete('simple', 'evaluation-change', 'unfavorable'); complete('advanced', 'advanced-run')
    return { original, changed }
  } finally { db.$client.close() }
}
const definitions = seedStoredFixtures()
function attemptCount() { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('SELECT count(*) AS count FROM sentiment_attempts').get().count } finally { db.close() } }
assert.equal(attemptCount(), 0)
const installedRequire = createRequire(path.join(packageRoot, 'package.json'))
const sdk = suffix => import(pathToFileURL(installedRequire.resolve(`@modelcontextprotocol/sdk/client/${suffix}.js`)).href)
const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([sdk('index'), sdk('stdio'), sdk('streamableHttp')])
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}/boundaries`
const configDirectory = path.join(scratch, 'config'); await mkdir(configDirectory)
const isolatedHome = path.join(scratch, 'home'); await mkdir(isolatedHome)
await writeFile(path.join(configDirectory, 'config.yaml'), JSON.stringify({ apiUrl: base, apiKey: SMOKE_ADMIN, database, host: '127.0.0.1', port, basePath: '/boundaries/', telemetry: false, updateCheck: false, providers: {}, agent: { mode: 'disabled' }, sentiment: { enabled: true, model: 'jev-1.13.0', maxConcurrency: 1, maxAttempts: 1 } }), { mode: 0o600 })
const env = { ...Object.fromEntries(['PATH', 'LANG', 'TZ', 'USER'].filter(key => process.env[key]).map(key => [key, process.env[key]])), HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), CANONRY_CONFIG_DIR: configDirectory, CI: 'true', DO_NOT_TRACK: '1', CANONRY_DISABLE_UPDATE_CHECK: '1', CANONRY_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./sentiment-smoke-preload.mjs', import.meta.url))}`, CANONRY_SENTIMENT_SMOKE_GUARD: '1', CANONRY_SENTIMENT_SMOKE_PROVIDER_URL: 'http://127.0.0.1:9/v1/systemone', CANONRY_SENTIMENT_SMOKE_RECEIPTS: receiptPath }
const bin = path.join(packageRoot, 'bin/canonry.mjs')
const child = spawn(process.execPath, [bin, 'serve', '--host', '127.0.0.1', '--port', String(port)], { cwd: scratch, env: { ...env, TYPESAFE_API_KEY: providerKey }, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
const clients = []
const cases = []
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function http(project, suffix = '', { query = {}, method = 'GET', body, expected = 200, projectRoute = false } = {}) {
  const response = await fetch(`${base}/api/v1/projects/${project}${projectRoute ? '' : '/sentiment'}${suffix}?${new URLSearchParams(query)}`, { method, signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${SMOKE_ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json(); safe(value); assert.equal(response.status, expected, JSON.stringify(value)); return value
}
function cli(operation, project, query, failure) {
  const arguments_ = ['sentiment', ...(operation === 'summary' ? [project] : [operation, project]), ...Object.entries(query).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value)]), '--format', 'json']
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [bin, ...arguments_], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    process_.stdout.on('data', value => { stdout += value }); process_.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => { process_.kill('SIGKILL'); reject(new Error('Installed CLI boundary read timed out')) }, 45000)
    process_.on('error', error => { clearTimeout(timer); reject(error) })
    process_.on('exit', code => { clearTimeout(timer); try { safe(stdout); safe(stderr); assert.equal(code, failure ? 1 : 0, stderr); resolve(JSON.parse(failure ? stderr : stdout)) } catch (error) { reject(error) } })
  })
}
async function all(operation, project, query = {}, failure = false) {
  const expected = await http(project, operation === 'summary' ? '' : `/${operation}`, { query, expected: failure ? 400 : 200 })
  const cliValue = await cli(operation, project, query, failure)
  // Client envelopes attach HTTP status and a new per-request correlation ID.
  // Verify the ID's shape separately; preserve every semantic error field in equality checks.
  const clientExpected = failure ? { error: { ...expected.error, details: { ...(expected.error.details ?? {}), httpStatus: 400 } } } : expected
  const equivalent = value => {
    if (!failure) { assert.deepEqual(value, clientExpected); return }
    const { requestId, ...details } = value.error.details
    assert.match(requestId, /^[a-f\d-]{36}$/i)
    assert.deepEqual({ ...value, error: { ...value.error, details } }, clientExpected)
  }
  equivalent(cliValue)
  for (const { client } of clients) {
    const result = await client.callTool({ name: operation === 'summary' ? 'canonry_sentiment' : `canonry_sentiment_${operation}`, arguments: { project, ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) } })
    safe(result); assert.equal(Boolean(result.isError), failure, JSON.stringify(result))
    const value = result.structuredContent ?? JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    equivalent(value)
  }
  cases.push({ operation, project, query, ...(failure ? { error: expected.error } : { state: expected.state, verdict: expected.verdict, refusalReasons: expected.refusalReasons }) })
  return expected
}
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok) break } catch { /* bounded startup */ }
    assert(tries < 120 && child.exitCode === null, 'Installed server failed to become ready'); await wait(500)
  }
  for (const [kind, transport] of [
    ['http', new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${SMOKE_ADMIN}` } } })],
    ['stdio', new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, 'bin/canonry-mcp.mjs'), '--eager'], cwd: scratch, env, stderr: 'pipe' })],
  ]) { const client = new Client({ name: 'sentiment-boundary-smoke', version: '1.0.0' }); clients.push({ kind, client }); await client.connect(transport) }
  for (const [runId, reason] of [['model-change', 'source-model-changed'], ['evaluation-change', 'evaluation-definition-changed'], ['population-change', 'source-scope-changed']]) {
    const value = await all('compare', 'simple', { fromRunId: 'simple-run', toRunId: runId })
    assert.equal(value.verdict, null); assert.equal(value.favorableRateDelta, null); assert(value.refusalReasons.includes(reason))
  }
  mark('S16 source-model, evaluator and population comparison refusals agree across all four installed transports')
  const selection = { runId: 'advanced-run', scope: 'market', scopeKey: 'market-all', evaluationDefinitionId: definitions.original.advanced, limit: '1' }
  const first = await all('evidence', 'advanced', selection)
  assert(first.nextCursor); assert.equal(first.items.length, 1)
  const next = await all('evidence', 'advanced', { ...selection, cursor: first.nextCursor })
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0].assessmentId, first.items[0].assessmentId)
  for (const changed of [{ scopeKey: 'market-harbor' }, { scope: 'property', scopeKey: 'harbor' }, { runId: 'advanced-other' }, { evaluationDefinitionId: definitions.changed.advanced }]) {
    const error = await all('evidence', 'advanced', { ...selection, ...changed, cursor: first.nextCursor }, true)
    assert.equal(error.error.code, 'VALIDATION_ERROR'); assert.match(error.error.message, /Evidence cursor/)
  }
  mark('S17 valid cursors page exactly; changed market, subject, run or evaluator is refused across all four installed transports')
  const historical = { runId: 'simple-run', evaluationDefinitionId: definitions.original.simple }
  const summary = await all('summary', 'simple', historical)
  const evidence = await all('evidence', 'simple', historical)
  await http('simple', '', { projectRoute: true, method: 'PUT', body: { displayName: 'Replacement subject', canonicalDomain: 'replacement.example', aliases: ['Replacement'], ownedDomains: [], country: 'US', language: 'fr', providers: ['openai'] } })
  await http('simple', '/settings', { method: 'PUT', body: { customThemes: [{ id: 'historic-topic', name: 'Replacement topic', description: 'Replacement live wording.' }] } })
  assert.deepEqual(await all('summary', 'simple', historical), summary)
  assert.deepEqual(await all('evidence', 'simple', historical), evidence)
  assert.equal(evidence.items[0].subject.displayName, 'Aurora Service')
  assert.equal(evidence.items[0].context.queryClass, 'branded')
  assert(summary.evaluationDefinition.themes.some(theme => theme.id === 'historic-topic' && theme.description === 'Original historical topic wording.'))
  mark('S18 live subject, language and theme edits leave historical frozen summary/evidence identical across all four installed transports')
  assert.equal(attemptCount(), 0)
  let receipts = ''; try { receipts = await readFile(receiptPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.equal(receipts.trim(), ''); safe(logs)
  mark('all boundary reads and synthetic configuration changes start zero classifier attempts or provider requests')
  const report = { mode: 'offline-stored-fixtures', packageRoot, packageVersion: manifest.version, completedAt: new Date().toISOString(), checks, cases, classifierAttempts: 0, providerRequests: 0, limitation: 'Classifications were seeded offline solely to exercise installed read, cursor and history contracts; separate actual Jev transport and quality gates apply.' }
  safe(report); await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`REPORT ${path.join(scratch, 'report.json')}`)
} catch (error) {
  await writeFile(path.join(scratch, 'server-redacted.log'), redact(logs))
  console.error(`FAILED ${redact(error.message)}\nRedacted diagnostics: ${scratch}`); process.exitCode = 1
} finally {
  await Promise.allSettled(clients.map(({ client }) => client.close()))
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(10000)]); if (child.exitCode === null) child.kill('SIGKILL') }
}
