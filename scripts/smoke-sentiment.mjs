/** Run with tsx after installing the built tarball outside this checkout.
 * The only source import seeds synthetic rows; all behavior uses installed binaries.
 * Live mode is explicitly bounded by the separate source-free preload.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seedSentimentSmoke, SMOKE_ADMIN, SMOKE_READ, SMOKE_SCOPED } from './sentiment-smoke-seed.js'

const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
assert(args.includes('--package-root'), 'Pass --package-root for a tarball installed outside the source tree.')
const packageRoot = path.resolve(option('--package-root'))
const checkoutRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const installedRoot = await realpath(packageRoot)
assert(!installedRoot.startsWith(`${checkoutRoot}/`) && installedRoot.includes('/node_modules/@canonry/canonry'), 'Smoke package must resolve to a scratch node_modules installation outside the checkout')
assert.equal(JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8')).name, '@canonry/canonry')
await access(path.join(installedRoot, 'assets/index.html'))
const live = args.includes('--live-key-file')
const zeroJudgment = args.includes('--zero-judgment')
const queryClass = args.includes('--non-brand') ? 'non-brand' : 'branded'
const absentSubject = args.includes('--absent-subject')
assert(!(live && (queryClass === 'non-brand' || absentSubject)), 'Expanded scope smoke is deterministic only')
assert(!absentSubject || (queryClass === 'non-brand' && !zeroJudgment), '--absent-subject requires --non-brand and cannot combine with --zero-judgment')
assert(!(live && zeroJudgment), '--zero-judgment is deterministic only and cannot be combined with --live-key-file')
const scratch = await mkdtemp(path.join(tmpdir(), `canonry-sentiment-${live ? 'live' : zeroJudgment ? 'zero-judgment' : 'stub'}-`))
const preload = fileURLToPath(new URL('./sentiment-smoke-preload.mjs', import.meta.url))
const receiptPath = path.join(scratch, 'provider-receipts.jsonl')
const database = path.join(scratch, 'synthetic.sqlite')
const installedRequire = createRequire(path.join(packageRoot, 'package.json'))
const sdk = name => import(pathToFileURL(installedRequire.resolve(`@modelcontextprotocol/sdk/${name}`)).href)
const { Client } = await sdk('client/index.js')
const { StdioClientTransport } = await sdk('client/stdio.js')
const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js')
const bin = path.join(packageRoot, 'bin/canonry.mjs')
const mcpBin = path.join(packageRoot, 'bin/canonry-mcp.mjs')
const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'TZ', 'USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
const isolatedHome = path.join(scratch, 'home')
await mkdir(isolatedHome)
const baseEnv = { ...cleanEnv, HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), NODE_OPTIONS: `--import=${preload}`, CI: 'true', DO_NOT_TRACK: '1', CANONRY_TELEMETRY_DISABLED: '1', CANONRY_DISABLE_UPDATE_CHECK: '1', CANONRY_SENTIMENT_SMOKE_GUARD: '1', CANONRY_SENTIMENT_SMOKE_RECEIPTS: receiptPath }
const checks = []
const mark = name => { checks.push(name); console.log(`PASS ${name}`) }
let child
let provider
const clients = []
let output = ''
const secrets = [SMOKE_ADMIN, SMOKE_READ, SMOKE_SCOPED]
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
function assertSafe(value) { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const secret of secrets) assert(!text.includes(secret), 'A credential leaked into a response or client frame') }
async function receipts() { try { return (await readFile(receiptPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function run(file, argv, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [file, ...argv], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Installed CLI timed out')) }, 45_000)
    proc.on('error', reject)
    proc.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
async function call(client, name, parameters, denied = false) {
  const scoped = ['canonry_sentiment', 'canonry_sentiment_evidence', 'canonry_sentiment_compare'].includes(name) ? { queryClass, ...parameters } : parameters
  const result = await client.callTool({ name, arguments: scoped })
  assertSafe(result)
  if (denied) { assert.equal(result.isError, true); return result }
  assert.notEqual(result.isError, true, JSON.stringify(result))
  if (result.structuredContent) return result.structuredContent
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return JSON.parse(text)
}
async function connect(transport) {
  const client = new Client({ name: 'canonry-sentiment-packaged-smoke', version: '1.0.0' })
  clients.push(client); await client.connect(transport); return client
}
function stable(value) { const cloned = JSON.parse(JSON.stringify(value)); delete cloned.generatedAt; return cloned }
try {
  seedSentimentSmoke(database, { queryClass, absentSubject })
  if (!live) {
    provider = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        assert.equal(body.model, 'jev-1.13.0')
        assert.deepEqual(Object.keys(body.questions).sort(), ['complaint', 'conclusion', 'identity', 'judgment', 'stance'])
        assert(!Object.hasOwn(body.state, 'themes'))
        const negative = body.state.subject.displayName === 'Bayside Homes'
        const sentences = Object.keys(body.state.answerSentences)
        const conclusion = negative ? sentences.at(-1) : sentences[1] ?? sentences[0]
        const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
          const choice = id === 'identity' ? zeroJudgment && negative ? 'wrong' : 'correct' : id === 'judgment' ? zeroJudgment ? 'factual' : 'judged' : id === 'stance' ? negative ? 'unfavorable' : 'favorable' : id === 'conclusion' ? conclusion : id === 'complaint' ? negative ? conclusion : 'absent' : id.endsWith('_evidence') ? 'absent' : 'no'
          assert(Object.hasOwn(question.criteria, choice), `Stub choice ${choice} invalid for ${id}`)
          return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
        }))
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1500, output_tokens: 0 } }))
      } catch { response.writeHead(400); response.end('{}') }
    })
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
    baseEnv.CANONRY_SENTIMENT_SMOKE_PROVIDER_URL = `http://127.0.0.1:${provider.address().port}/v1/systemone`
  } else baseEnv.CANONRY_SENTIMENT_SMOKE_LIVE = '1'
  const port = await freePort()
  const base = `http://127.0.0.1:${port}/smoke`
  const configs = {}
  for (const [name, token] of Object.entries({ admin: SMOKE_ADMIN, read: SMOKE_READ, scoped: SMOKE_SCOPED })) {
    const configDir = path.join(scratch, name); await mkdir(configDir)
    const config = { apiUrl: base, apiKey: token, database, port, host: '127.0.0.1', basePath: '/smoke/', telemetry: false, updateCheck: false, providers: {}, sentiment: { enabled: true, model: 'jev-1.13.0', maxConcurrency: 1, maxAttempts: 2, maxRequestsPerMinute: 6, maxInputTokensPerMinute: 150000 } }
    await writeFile(path.join(configDir, 'config.yaml'), JSON.stringify(config), { mode: 0o600 })
    configs[name] = { ...baseEnv, CANONRY_CONFIG_DIR: configDir }
  }
  // The key remains in process memory/environment only; neither logs nor YAML contain it.
  const apiKey = live ? (await readFile(option('--live-key-file'), 'utf8')).trim() : 'synthetic-typesafe-key'
  assert(apiKey.length > 0, 'The API key file is empty')
  secrets.push(apiKey)
  child = spawn(process.execPath, [bin, 'serve', '--host', '127.0.0.1', '--port', String(port)], { cwd: scratch, env: { ...configs.admin, TYPESAFE_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'] })
  const capture = data => { output += String(data); if (output.length > 50000) output = output.slice(-50000) }
  child.stdout.on('data', capture); child.stderr.on('data', capture)
  async function http(project, suffix = '', { method = 'GET', key = SMOKE_ADMIN, body, expected = 200 } = {}) {
    const selectionRead = method === 'GET' && ['', '/evidence', '/compare', '/backfill-preview'].includes(suffix.split('?')[0])
    if (selectionRead && !new URLSearchParams(suffix.split('?')[1] ?? '').has('queryClass')) suffix += `${suffix.includes('?') ? '&' : '?'}queryClass=${queryClass}`
    const response = await fetch(`${base}/api/v1/projects/${project}/sentiment${suffix}`, { method, signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await response.json(); assertSafe(data); assert.equal(response.status, expected, JSON.stringify(data)); return data
  }
  async function cli(argv, role = 'admin', denied = false) {
    const op = ['settings', 'jobs', 'job', 'configure', 'backfill', 'evidence', 'compare'].includes(argv[0]) ? argv[0] : 'summary'
    const scoped = ['summary', 'evidence', 'compare'].includes(op) && !argv.includes('--query-class') ? [...argv, '--query-class', queryClass] : argv
    const result = await run(bin, ['sentiment', ...scoped, '--format', 'json'], configs[role])
    assertSafe(result.stdout); assertSafe(result.stderr)
    if (denied) { assert.notEqual(result.code, 0); return result }
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout)
  }
  for (let tries = 0; ; tries++) {
    try { const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) }); if (health.ok) break } catch { /* bounded readiness polling */ }
    if (tries >= 120 || child.exitCode !== null) throw new Error(`Installed server failed readiness: ${output}`)
    await wait(500)
  }
  mark('installed tarball serves non-root /smoke/ path')
  const before = await http('simple')
  assert.equal(before.state, 'disabled'); assert.equal(before.score.favorableRate, null)
  const settings = await http('simple', '/settings'); assert.equal(settings.enabled, false)
  for (const removed of ['themes', 'preset', 'customThemes']) assert(!Object.hasOwn(settings, removed))
  await http('simple', '/settings', { method: 'PUT', key: SMOKE_READ, body: { enabled: true }, expected: 403 })
  await http('advanced', '', { key: SMOKE_SCOPED, expected: 403 })
  await cli(['configure', 'simple', '--enabled', 'true'], 'read', true)
  await cli(['advanced'], 'scoped', true)
  assert.equal((await receipts()).length, 0)
  mark('default-off reads and REST/CLI permission denials spend nothing')
  const jobs = []
  for (const [project, count] of [['simple', 1], ['advanced', 2]]) {
    await http(project, '/settings', { method: 'PUT', body: { enabled: true } })
    assert.equal((await http(project, '/jobs')).jobs.length, 0)
    const preview = await http(project, `/backfill-preview?runId=${project}-run`)
    assert.equal(preview.eligibleAssessments, count, JSON.stringify(preview)); assert(preview.previewToken)
    const body = { previewToken: preview.previewToken, idempotencyKey: `synthetic-${project}` }
    const job = await http(project, '/backfills', { method: 'POST', body }); jobs.push({ project, body, id: job.id })
    assert.equal((await http(project, '/backfills', { method: 'POST', body })).id, job.id)
  }
  mark('explicit frozen backfill admits exactly three assessments and replays receipts')
  for (const { project, id } of jobs) {
    for (let tries = 0; ; tries++) {
      const job = await http(project, `/jobs/${id}`)
      if (job.state === 'complete') break
      if (['failed', 'canceled'].includes(job.state) || tries >= 180) throw new Error(`Job did not complete: ${JSON.stringify(job)}`)
      await wait(1000)
    }
  }
  const summaries = {}; const evidence = {}; const comparisons = {}
  for (const [project, count] of [['simple', 1], ['advanced', 2]]) {
    summaries[project] = await http(project)
    evidence[project] = await http(project, '/evidence')
    assert.equal(summaries[project].coverage.selected, count)
    assert.equal(summaries[project].coverage.distinctSourceAnswers, 1)
    assert.equal(evidence[project].items.length, count)
    for (const item of evidence[project].items) for (const span of [...item.conclusion, ...(item.complaint ?? []), ]) assert.equal(item.sourceText.slice(span.start, span.end), span.text)
    assert.deepEqual(stable(await cli([project])), stable(summaries[project]))
    assert.deepEqual(stable(await cli(['evidence', project])), stable(evidence[project]))
    assert(!Object.hasOwn(summaries[project], 'themes'))
    assert(evidence[project].items.every(item => !Object.hasOwn(item, 'themes')))
    const perQuery = await http(project, `?queryId=${project}-query`)
    assert.deepEqual(await cli([project, '--query-id', `${project}-query`]), perQuery)
    assert.equal(perQuery.coverage.selected, count)
    const otherClass = await http(project, `?queryClass=${queryClass === 'branded' ? 'non-brand' : 'branded'}`)
    assert.equal(otherClass.coverage.selected, 0)
    assert.equal(otherClass.score.favorableRate, null)
    comparisons[project] = await http(project, `/compare?fromRunId=${project}-run&toRunId=${project}-run`)
    assert.deepEqual(stable(await cli(['compare', project, '--from-run-id', `${project}-run`, '--to-run-id', `${project}-run`])), stable(comparisons[project]))
    assert.deepEqual(await cli(['settings', project]), await http(project, '/settings'))
    assert.deepEqual(await cli(['jobs', project]), await http(project, '/jobs'))
    const receipt = jobs.find(job => job.project === project)
    assert.deepEqual(await cli(['job', project, receipt.id]), await http(project, `/jobs/${receipt.id}`))
    assert.equal((await cli(['backfill', project, '--preview-token', receipt.body.previewToken, '--idempotency-key', receipt.body.idempotencyKey])).id, receipt.id)
  }
  if (absentSubject) {
    for (const [project, count] of [['simple', 1], ['advanced', 2]]) {
      const summary = summaries[project]
      assert.equal(summary.coverage.counts['subject-not-mentioned'], count)
      assert.equal(summary.coverage.judged, 0)
      assert.equal(summary.coverage.counts.unfavorable, 0)
      assert.equal(summary.score.favorableRate, null)
      assert.equal(summary.score.favorableDisplay, 'Unavailable')
      assert.equal(summary.score.interval, null)
    }
    mark('non-brand absent subjects abstain locally without adverse judgments or provider calls')
  } else if (zeroJudgment) {
    for (const project of ['simple', 'advanced']) {
      const summary = summaries[project]
      assert.equal(summary.state, 'complete'); assert.equal(summary.coverage.judged, 0)
      assert.equal(summary.coverage.counts.factual, 1)
      assert.equal(summary.coverage.counts['wrong-subject'], project === 'advanced' ? 1 : 0)
      assert.equal(summary.score.interval, null)
      for (const verdict of ['favorable', 'mixed', 'unfavorable']) {
        assert.equal(summary.coverage.counts[verdict], 0)
        assert.equal(summary.score[`${verdict}Rate`], null)
        assert.equal(summary.score[`${verdict}Display`], 'Unavailable')
      }
      assert.equal(comparisons[project].verdict, null)
      assert.equal(comparisons[project].favorableRateDelta, null)
      assert.deepEqual(comparisons[project].refusalReasons, ['insufficient-judgments'])
      const human = await run(bin, ['sentiment', project, '--query-class', queryClass, '--format', 'text'], configs.admin)
      assertSafe(human.stdout); assertSafe(human.stderr); assert.equal(human.code, 0, human.stderr)
      assert(human.stdout.includes('Favorable: Unavailable · Mixed: Unavailable · Unfavorable: Unavailable'))
      assert(human.stdout.includes('No evaluative answers.')); assert(human.stdout.includes('factual: 1'))
      if (project === 'advanced') assert(human.stdout.includes('wrong-subject: 1'))
    }
    assert.deepEqual(evidence.simple.items.map(item => item.outcome), ['factual'])
    assert.deepEqual(evidence.advanced.items.map(item => item.outcome).sort(), ['factual', 'wrong-subject'])
  } else if (!live) {
    assert.equal(summaries.simple.score.favorableRate, 1)
    assert.equal(summaries.advanced.score.favorableRate, 0.5)
    assert.deepEqual(evidence.advanced.items.map(item => item.outcome).sort(), ['favorable', 'unfavorable'])
  }
  const allMarket = await http('advanced', '?scope=market&scopeKey=market-all')
  assert.equal(allMarket.coverage.selected, 2); assert.equal(allMarket.coverage.distinctSourceAnswers, 1)
  const singleMarket = await http('advanced', '?scope=market&scopeKey=market-harbor')
  assert.equal(singleMarket.coverage.selected, 1)
  mark('persisted HTTP/CLI summaries and exact evidence agree; shared Advanced answer deduplicates')
  const completeReceipts = await receipts(); assert(completeReceipts.length <= 6 && (absentSubject || completeReceipts.length > 0))
  if (!live) assert.equal(completeReceipts.length, absentSubject ? 0 : 3)
  for (const role of ['admin', 'read', 'scoped']) {
    for (const kind of ['http', 'stdio']) {
      const token = role === 'admin' ? SMOKE_ADMIN : role === 'read' ? SMOKE_READ : SMOKE_SCOPED
      const transport = kind === 'http' ? new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) : new StdioClientTransport({ command: process.execPath, args: [mcpBin, '--eager'], cwd: scratch, env: configs[role], stderr: 'pipe' })
      const client = await connect(transport)
      assert.deepEqual(stable(await call(client, 'canonry_sentiment', { project: 'simple' })), stable(summaries.simple))
      assert.deepEqual(stable(await call(client, 'canonry_sentiment_evidence', { project: 'simple' })), stable(evidence.simple))
      assert.deepEqual(await call(client, 'canonry_sentiment', { project: 'simple', queryId: 'simple-query' }), await http('simple', '?queryId=simple-query'))
      assert.deepEqual(stable(await call(client, 'canonry_sentiment_compare', { project: 'simple', fromRunId: 'simple-run', toRunId: 'simple-run' })), stable(comparisons.simple))
      if (role === 'admin') {
        assert.deepEqual(await call(client, 'canonry_sentiment_settings', { project: 'simple' }), await http('simple', '/settings'))
        assert.deepEqual(await call(client, 'canonry_sentiment_jobs', { project: 'simple' }), await http('simple', '/jobs'))
        assert.equal((await call(client, 'canonry_sentiment_backfill', { project: 'simple', ...jobs[0].body })).id, jobs[0].id)
        assert.deepEqual(await call(client, 'canonry_sentiment_job', { project: 'simple', jobId: jobs[0].id }), await http('simple', `/jobs/${jobs[0].id}`))
      }
      if (role !== 'scoped') {
        assert.deepEqual(stable(await call(client, 'canonry_sentiment', { project: 'advanced' })), stable(summaries.advanced))
        assert.deepEqual(stable(await call(client, 'canonry_sentiment_evidence', { project: 'advanced' })), stable(evidence.advanced))
        assert.deepEqual(stable(await call(client, 'canonry_sentiment_compare', { project: 'advanced', fromRunId: 'advanced-run', toRunId: 'advanced-run' })), stable(comparisons.advanced))
      }
      if (role === 'scoped') await call(client, 'canonry_sentiment', { project: 'advanced' }, true)
      if (role === 'read') {
        const listed = await client.listTools()
        assert(!listed.tools.some(tool => tool.name === 'canonry_sentiment_configure' || tool.name === 'canonry_sentiment_backfill'))
      }
      await client.close()
    }
  }
  mark('HTTP MCP and installed stdio MCP match persisted results and enforce read/scoped credentials')
  mark('same-period comparison responses agree across HTTP, CLI and both MCP transports')
  mark('frozen query scores agree across every transport and branded/non-brand populations never pool')
  if (zeroJudgment) mark('zero-judgment exclusions and unavailable rates agree across installed clients, including human CLI display')
  for (const { project, body, id } of jobs) {
    await http(project, '/settings', { method: 'PUT', body: { enabled: false } })
    assert.equal((await http(project, '/backfills', { method: 'POST', body })).id, id)
    await http(project); await http(project, '/evidence'); await http(project, '/jobs')
  }
  assert.equal((await receipts()).length, completeReceipts.length)
  mark('repeated reads and disabled receipt replay make zero additional provider calls')
  const report = { mode: live ? 'live' : zeroJudgment ? 'stub-zero-judgment' : absentSubject ? 'stub-absent-subject' : 'stub', queryClass, packageRoot, scratch, completedAt: new Date().toISOString(), checks, receipts: completeReceipts, summaries, evidence, comparisons, qualityGate: 'UNMET: bounded synthetic smoke is not independent human-held-out evaluation.' }
  assertSafe(report); assertSafe(output)
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`REPORT ${path.join(scratch, 'report.json')}`)
} catch (error) {
  await writeFile(path.join(scratch, 'server-redacted.log'), redact(output))
  console.error(`FAILED ${redact(error.message)}\nRedacted diagnostics: ${scratch}`)
  process.exitCode = 1
} finally {
  await Promise.allSettled(clients.map(client => client.close()))
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(10000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  if (provider) await new Promise(resolve => provider.close(resolve))
  // Keep synthetic DB, public config, and redacted receipts for reproducible inspection.
  await rm(path.join(scratch, 'home'), { recursive: true, force: true })
}
