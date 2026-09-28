/**
 * Installed-package fault/recovery smoke. Run with `node --import tsx` and
 * --package-root pointing at a tarball installed outside this checkout.
 *
 * Only sentiment-smoke-seed imports source. The server is the installed binary,
 * all requests use loopback HTTP, and the existing preload blocks live egress.
 * SQL touches only fresh synthetic databases under this script's mkdtemp root.
 * The crash case expires a synthetic lease after killing its owner rather than
 * waiting two minutes. The receipt case supplies synthetic completion records
 * while the server is stopped; it tests reconciliation, not the run writer.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedSentimentSmoke, SMOKE_ADMIN } from './sentiment-smoke-seed.js'

const argv = process.argv.slice(2)
const packageArgument = argv.indexOf('--package-root')
assert(packageArgument >= 0 && argv[packageArgument + 1], 'Pass --package-root for the scratch-installed tarball.')
assert(!argv.includes('--live') && !argv.includes('--live-key-file'), 'This recovery smoke supports loopback stubs only.')
const packageRoot = await realpath(path.resolve(argv[packageArgument + 1]))
const checkoutRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)))
assert(!packageRoot.startsWith(`${checkoutRoot}/`), 'The installed package must resolve outside the source checkout.')
assert.equal(JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).name, '@canonry/canonry')
const binary = path.join(packageRoot, 'bin/canonry.mjs')
await access(binary)
const installedRequire = createRequire(path.join(packageRoot, 'package.json'))
const Sqlite = installedRequire('better-sqlite3')
const preload = fileURLToPath(new URL('./sentiment-smoke-preload.mjs', import.meta.url))
const scratch = await mkdtemp(path.join(tmpdir(), 'canonry-sentiment-recovery-'))
const syntheticProviderKey = 'synthetic-recovery-provider-key'
const secrets = [SMOKE_ADMIN, syntheticProviderKey]
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
const checks = []
const scenarios = []
const contexts = []
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const mark = name => { checks.push(name); console.log(`PASS ${name}`) }

async function until(test, description, timeout = 40_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await test(); if (result) return result; await wait(200) }
  throw new Error(`Timed out waiting for ${description}`)
}
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function successfulResponse(body) {
  const negative = body.state.subject.displayName === 'Bayside Homes'
  const sentences = Object.keys(body.state.answerSentences)
  const conclusion = negative ? sentences.at(-1) : sentences[1] ?? sentences[0]
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    const choice = id === 'identity' ? 'correct' : id === 'judgment' ? 'judged' : id === 'stance' ? negative ? 'unfavorable' : 'favorable' : id === 'conclusion' ? conclusion : id === 'complaint' ? negative ? conclusion : 'absent' : id.endsWith('_evidence') ? 'absent' : 'no'
    assert(Object.hasOwn(question.criteria, choice), `Invalid stub answer ${id}`)
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) }]
  }))
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1500, output_tokens: 0 } }
}
function sql(context, action) {
  assert(context.database.startsWith(`${scratch}${path.sep}`), 'Refuse database outside the synthetic smoke root.')
  const db = new Sqlite(context.database)
  db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000')
  try { return action(db) } finally { db.close() }
}
async function context(name, mode = 'success') {
  const directory = path.join(scratch, name)
  const configDirectory = path.join(directory, 'config')
  const isolatedHome = path.join(directory, 'home')
  await mkdir(configDirectory, { recursive: true }); await mkdir(isolatedHome)
  const value = { name, directory, configDirectory, database: path.join(directory, 'synthetic.sqlite'), providerCalls: [], mode, child: null, log: '', stubErrors: [], sockets: new Set() }
  contexts.push(value)
  seedSentimentSmoke(value.database)
  value.provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(body.model, 'jev-1.13.0')
      value.providerCalls.push({ at: new Date().toISOString(), subject: body.state.subject.displayName, mode: value.mode })
      if (value.mode === 'hold') return // Simulates a transmitted request whose response is lost in a process crash.
      if (value.mode === '429') { response.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' }); response.end('{"error":"synthetic rate limit"}'); return }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(successfulResponse(body)))
    } catch (error) { value.stubErrors.push(redact(error.message)); response.writeHead(400); response.end('{}') }
  })
  value.provider.on('connection', socket => { value.sockets.add(socket); socket.on('close', () => value.sockets.delete(socket)) })
  await new Promise(resolve => value.provider.listen(0, '127.0.0.1', resolve))
  const port = await freePort()
  value.base = `http://127.0.0.1:${port}/recovery`
  value.config = { apiUrl: value.base, apiKey: SMOKE_ADMIN, database: value.database, port, host: '127.0.0.1', basePath: '/recovery/', telemetry: false, updateCheck: false, providers: {}, agent: { mode: 'disabled' }, sentiment: { enabled: true, model: 'jev-1.13.0', maxConcurrency: 1, maxAttempts: 3, maxRequestsPerMinute: 6, maxInputTokensPerMinute: 150000 } }
  const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'TZ', 'USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  value.env = { ...cleanEnv, HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), CANONRY_CONFIG_DIR: configDirectory, NODE_OPTIONS: `--import=${preload}`, CI: 'true', DO_NOT_TRACK: '1', CANONRY_TELEMETRY_DISABLED: '1', CANONRY_DISABLE_UPDATE_CHECK: '1', TYPESAFE_API_KEY: syntheticProviderKey, CANONRY_SENTIMENT_SMOKE_GUARD: '1', CANONRY_SENTIMENT_SMOKE_PROVIDER_URL: `http://127.0.0.1:${value.provider.address().port}/v1/systemone`, CANONRY_SENTIMENT_SMOKE_RECEIPTS: path.join(directory, 'transport-receipts.jsonl') }
  await writeConfig(value)
  return value
}
async function writeConfig(value) { await writeFile(path.join(value.configDirectory, 'config.yaml'), JSON.stringify(value.config), { mode: 0o600 }) }
async function start(value) {
  assert.equal(value.child, null)
  value.child = spawn(process.execPath, [binary, 'serve', '--host', '127.0.0.1', '--port', String(value.config.port)], { cwd: value.directory, env: value.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const capture = data => { value.log += String(data); if (value.log.length > 50_000) value.log = value.log.slice(-50_000) }
  value.child.stdout.on('data', capture); value.child.stderr.on('data', capture)
  await until(async () => {
    if (value.child.exitCode !== null) throw new Error(`Installed ${value.name} server exited: ${redact(value.log)}`)
    try { return (await fetch(`${value.base}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }, `${value.name} server readiness`)
}
async function stop(value, signal = 'SIGTERM') {
  const child = value.child
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(signal)
    await Promise.race([exited, wait(8000)])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
  value.child = null
}
async function http(value, project, suffix = '', method = 'GET', body) {
  const response = await fetch(`${value.base}/api/v1/projects/${project}/sentiment${suffix}`, { method, headers: { authorization: `Bearer ${SMOKE_ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  for (const secret of secrets) assert(!JSON.stringify(result).includes(secret), 'Credential leaked in HTTP response.')
  return result
}
async function enable(value, project = 'simple') { return http(value, project, '/settings', 'PUT', { enabled: true }) }
async function backfill(value, project = 'simple', key = 'synthetic-backfill') {
  const preview = await http(value, project, `/backfill-preview?runId=${project}-run`)
  assert(preview.previewToken)
  return http(value, project, '/backfills', 'POST', { previewToken: preview.previewToken, idempotencyKey: key })
}
function receipts(value) {
  return sql(value, db => ({
    attempts: db.prepare('SELECT id, work_item_id, attempt_number, dispatched_at, completed_at, usage_status, safe_failure FROM sentiment_attempts ORDER BY attempt_number').all(),
    work: db.prepare('SELECT id, status, attempt_count, next_attempt_at, lease_expires_at, cancellation_reason FROM sentiment_work_items').all(),
    results: db.prepare('SELECT work_item_id, outcome FROM sentiment_results').all(),
    usage: db.prepare("SELECT provider, feature, input_tokens, cost_millicents FROM llm_usage_events WHERE feature='sentiment'").all(),
  }))
}
function copyRow(db, table, sourceId, changes) {
  assert(['runs', 'query_snapshots'].includes(table))
  const original = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sourceId)
  assert(original)
  const row = { ...original, ...changes }
  const columns = Object.keys(row)
  assert(columns.every(column => /^[a-z_]+$/.test(column)))
  db.prepare(`INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]))
}

try {
  const limited = await context('retry-disable', '429')
  await start(limited); await enable(limited)
  const limitedJob = await backfill(limited)
  const waiting = await until(() => {
    const row = receipts(limited)
    return row.work[0]?.status === 'waiting-to-retry' ? row : false
  }, '429 retry reservation')
  assert.equal(limited.providerCalls.length, 1)
  assert(Date.parse(waiting.work[0].next_attempt_at) - Date.parse(waiting.attempts[0].completed_at) >= 120_000, 'Retry-After must be honored by the durable schedule.')
  limited.config.sentiment.enabled = false; await writeConfig(limited)
  await until(() => receipts(limited).work[0]?.status === 'canceled', 'live install disablement')
  await stop(limited); await start(limited)
  assert.equal((await http(limited, 'simple', `/jobs/${limitedJob.id}`)).state, 'canceled')
  assert.equal(limited.providerCalls.length, 1)
  limited.mode = 'success'; limited.config.sentiment.enabled = true; await writeConfig(limited)
  await stop(limited); await start(limited)
  await until(() => sql(limited, db => db.prepare("SELECT install_suspended FROM sentiment_settings WHERE project_id='simple'").get().install_suspended === 0), 'install resume boundary')
  await wait(5500) // At least one complete poll after resume: canceled work must stay canceled.
  assert.equal(limited.providerCalls.length, 1)
  assert.equal((await http(limited, 'simple', `/jobs/${limitedJob.id}`)).counts.canceled, 1)
  scenarios.push({ name: limited.name, providerCalls: limited.providerCalls, ...receipts(limited) })
  mark('429 Retry-After persists; live disable, disabled restart, and reenable dispatch no old work')
  await stop(limited)

  const crashed = await context('started-attempt-crash', 'hold')
  await start(crashed); await enable(crashed)
  const crashJob = await backfill(crashed)
  await until(() => crashed.providerCalls.length === 1 && receipts(crashed).attempts.length === 1, 'transmitted started attempt')
  await stop(crashed, 'SIGKILL')
  const beforeRecovery = receipts(crashed)
  assert.equal(beforeRecovery.attempts[0].usage_status, 'unknown')
  assert.equal(beforeRecovery.attempts[0].completed_at, null)
  assert.equal(beforeRecovery.results.length, 0)
  // The owner is dead. Expire only this synthetic DB's lease to avoid a real two-minute wait.
  sql(crashed, db => db.prepare("UPDATE sentiment_work_items SET lease_expires_at = ? WHERE status='running'").run(new Date(Date.now() - 1000).toISOString()))
  crashed.mode = 'success'
  await start(crashed)
  await until(async () => (await http(crashed, 'simple', `/jobs/${crashJob.id}`)).state === 'complete', 'expired-lease recovery')
  const recovered = receipts(crashed)
  assert.equal(crashed.providerCalls.length, 2)
  assert.equal(recovered.attempts.length, 2)
  assert.equal(recovered.attempts[0].usage_status, 'unknown')
  assert.equal(recovered.attempts[0].completed_at, null)
  assert.equal(recovered.attempts[1].usage_status, 'reported')
  assert.equal(recovered.results.length, 1)
  assert.equal(recovered.usage.length, 1)
  await stop(crashed); await start(crashed); await wait(5500)
  assert.equal(crashed.providerCalls.length, 2)
  scenarios.push({ name: crashed.name, providerCalls: crashed.providerCalls, ...receipts(crashed), acceleratedClock: 'Expired the killed process lease in its synthetic database; no production time or lease changed.' })
  mark('started-attempt crash recovers one result with a separate unknown receipt and no duplicate successful dispatch')
  await stop(crashed)

  const missed = await context('missed-superseded-fill')
  const missingAnswer = sql(missed, db => {
    const answer = db.prepare("SELECT * FROM query_snapshots WHERE id='simple-answer'").get()
    db.prepare("DELETE FROM query_snapshots WHERE id='simple-answer'").run()
    db.prepare("UPDATE runs SET status='partial', finished_at=NULL WHERE id='simple-run'").run()
    return answer
  })
  await start(missed); await enable(missed); await enable(missed, 'advanced')
  assert.equal((await http(missed, 'simple')).coverage.selected, 0)
  assert.equal(missed.providerCalls.length, 0)
  await stop(missed)
  sql(missed, db => db.transaction(() => {
    const columns = Object.keys(missingAnswer)
    db.prepare(`INSERT INTO query_snapshots (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => missingAnswer[column]))
    db.prepare("UPDATE runs SET status='completed', finished_at=? WHERE id='simple-run'").run(new Date().toISOString())
    // A newer source makes the old fill superseded for callbacks, while its durable completion remains eligible.
    copyRow(db, 'runs', 'simple-run', { id: 'newer-simple-run', created_at: new Date().toISOString() })
    const insertReceipt = db.prepare('INSERT INTO sentiment_completion_receipts(project_id,run_id,completion_key,completed_at,kind,trigger,fill_origin) VALUES (?,?,?,?,?,?,?)')
    insertReceipt.run('simple', 'simple-run', 'synthetic-late-fill', new Date().toISOString(), 'answer-visibility', 'manual', 'synthetic-late-fill')
    insertReceipt.run('advanced', 'advanced-run', 'synthetic-missed-initial', new Date().toISOString(), 'answer-visibility', 'manual', null)
  })())
  await start(missed)
  await until(() => receipts(missed).results.length === 3, 'missed completion reconciliation')
  const automatic = sql(missed, db => db.prepare('SELECT origin, state, selection FROM sentiment_jobs ORDER BY project_id').all())
  assert.equal(automatic.length, 2)
  assert(automatic.every(job => job.origin === 'automatic' && job.state === 'complete'))
  assert(automatic.some(job => JSON.parse(job.selection).runId === 'simple-run'))
  assert.equal(missed.providerCalls.length, 3)
  await stop(missed); await start(missed); await wait(5500)
  assert.equal(missed.providerCalls.length, 3)
  assert.equal(sql(missed, db => db.prepare('SELECT count(*) AS n FROM sentiment_jobs').get().n), 2)
  scenarios.push({ name: missed.name, providerCalls: missed.providerCalls, automatic, ...receipts(missed), fixtureBoundary: 'Synthetic fill/superseded and missed-initial receipts were inserted transactionally while the installed server was stopped; this verifies receipt reconciliation rather than the run-writer transaction.' })
  mark('restart reconciles an old superseded fill and missed Advanced completion exactly once')
  for (const value of contexts) assert.deepEqual(value.stubErrors, [])
  const report = { completedAt: new Date().toISOString(), packageRoot, scratch, mode: 'loopback-stub-only', checks, scenarios, limitation: 'Deterministic installed-package fault smoke; no live provider or human-held-out quality claims.' }
  const serialized = JSON.stringify(report, null, 2)
  for (const secret of secrets) assert(!serialized.includes(secret), 'Credential leaked into smoke report.')
  await writeFile(path.join(scratch, 'report.json'), serialized)
  console.log(`REPORT ${path.join(scratch, 'report.json')}`)
} catch (error) {
  console.error(`FAILED ${redact(error.message)}\nSynthetic diagnostics: ${scratch}`)
  process.exitCode = 1
} finally {
  for (const value of contexts) {
    await stop(value)
    await writeFile(path.join(value.directory, 'server-redacted.log'), redact(value.log))
    for (const socket of value.sockets) socket.destroy()
    await new Promise(resolve => value.provider.close(resolve))
  }
}
