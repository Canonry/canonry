/** Deterministic installed-package engine verdict smoke. Never accepts a live credential. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { access, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seedSentimentEngineSmoke } from './sentiment-engine-smoke-seed.js'
import { SMOKE_ADMIN, SMOKE_READ, SMOKE_SCOPED } from './sentiment-smoke-seed.js'

const args = process.argv.slice(2)
assert(args.includes('--package-root') && !args.some(arg => arg.includes('live')), 'Pass only a scratch --package-root; this smoke has no live mode')
/**
 * --browser resolves Playwright and its bundled Chromium the normal way. To use
 * another install, set CANONRY_PLAYWRIGHT_MODULE to its index.mjs and
 * CANONRY_BROWSER_EXECUTABLE to a Chromium binary; PLAYWRIGHT_BROWSERS_PATH is
 * passed through too. Only the variables that are set reach the browser child.
 */
const BROWSER_ENV_KEYS = ['CANONRY_PLAYWRIGHT_MODULE', 'CANONRY_BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']
const browserEnv = () => Object.fromEntries(BROWSER_ENV_KEYS.filter(key => process.env[key]).map(key => [key, process.env[key]]))
if (args.includes('--browser')) {
  const specifier = process.env.CANONRY_PLAYWRIGHT_MODULE ?? 'playwright'
  try { await import(specifier) } catch (error) {
    throw new Error(`--browser needs Playwright, and ${JSON.stringify(specifier)} did not load (${error instanceof Error ? error.message : String(error)}). Install the playwright package and its Chromium (npx playwright install chromium), or set CANONRY_PLAYWRIGHT_MODULE to a Playwright index.mjs and CANONRY_BROWSER_EXECUTABLE to a Chromium binary.`)
  }
}
const packageRoot = await realpath(args[args.indexOf('--package-root') + 1])
const checkout = await realpath(fileURLToPath(new URL('../', import.meta.url)))
assert(packageRoot.startsWith('/tmp/canonry-sentiment-') && packageRoot.includes('/node_modules/@canonry/canonry') && !packageRoot.startsWith(checkout), 'Use the fresh installed scratch tarball')
const packageInfo = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
assert.equal(packageInfo.name, '@canonry/canonry')
await access(path.join(packageRoot, 'assets/index.html'))
const scratch = await mkdtemp(path.join(tmpdir(), 'canonry-sentiment-engines-'))
const database = path.join(scratch, 'synthetic.sqlite')
const receiptsFile = path.join(scratch, 'provider-receipts.jsonl')
const report = { packageRoot, packageVersion: packageInfo.version, scratch, mode: 'deterministic-engine-verdicts', checks: [], complete: false, serverStopped: false, providerRequests: [], browser: null }
const mark = message => { report.checks.push(message); console.log(`PASS ${message}`) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
const guard = pathToFileURL(fileURLToPath(new URL('./sentiment-smoke-preload.mjs', import.meta.url))).href
await writeFile(path.join(scratch, 'guard.mjs'), `import {installSentimentSmokeGuard} from ${JSON.stringify(guard)}; installSentimentSmokeGuard({providerUrl:process.env.CANONRY_SENTIMENT_SMOKE_PROVIDER_URL,receiptPath:process.env.CANONRY_SENTIMENT_SMOKE_RECEIPTS,maxAttempts:6,maxAssessments:6,maxInputTokens:150000});\n`)
const baseEnv = { ...cleanEnv, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'home/.config'), NODE_OPTIONS: `--import=${path.join(scratch, 'guard.mjs')}`, CI: 'true', DO_NOT_TRACK: '1', CANONRY_TELEMETRY_DISABLED: '1', CANONRY_DISABLE_UPDATE_CHECK: '1', CANONRY_SENTIMENT_SMOKE_RECEIPTS: receiptsFile }
await mkdir(baseEnv.HOME)
let server, stub, browserProcess
const clients = []
let serverOutput = ''
const configs = {}
const bin = path.join(packageRoot, 'bin/canonry.mjs')
const redact = value => [SMOKE_ADMIN, SMOKE_READ, SMOKE_SCOPED, 'synthetic-engine-key'].reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
async function stop(child, group = false) {
  if (!child || child.exitCode !== null) return
  if (group) { try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error } } else child.kill('SIGTERM')
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(5000)])
  if (child.exitCode === null) { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)) }
}
async function command(file, argv, env, timeout = 45000) {
  const child = spawn(process.execPath, [file, ...argv], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, timeout)
  try { await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }) } finally { clearTimeout(timer) }
  assert.equal(child.exitCode, 0, redact(stderr || stdout))
  return JSON.parse(stdout)
}
async function receiptCount() { try { return (await readFile(receiptsFile, 'utf8')).trim().split('\n').filter(Boolean).length } catch (error) { if (error.code === 'ENOENT') return 0; throw error } }
try {
  seedSentimentEngineSmoke(database)
  stub = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(body.model, 'jev-1.13.0')
      assert.deepEqual(Object.keys(body.questions).sort(), ['complaint', 'conclusion', 'identity', 'judgment', 'stance'])
      const { subject, execution, answerSentences } = body.state
      assert(['openai', 'gemini'].includes(execution.provider), 'Absent and unadmitted sources must not reach the provider')
      const negative = (subject.displayName === 'Bayside Homes') !== (execution.provider === 'gemini')
      const sentence = Object.entries(answerSentences).find(([, text]) => text.includes(subject.displayName))?.[0]
      assert(sentence, 'Stub evidence must be an actual exact source sentence about the subject')
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const choice = id === 'identity' ? 'correct' : id === 'judgment' ? 'judged' : id === 'stance' ? negative ? 'unfavorable' : 'favorable' : id === 'conclusion' ? sentence : negative ? sentence : 'absent'
        assert(Object.hasOwn(question.criteria, choice))
        return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
      }))
      report.providerRequests.push({ provider: execution.provider, subject: subject.displayName, outcome: negative ? 'unfavorable' : 'favorable' })
      assert(report.providerRequests.length <= 6)
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1500, output_tokens: 0 } }))
    } catch (error) { report.stubFailure = error.message; response.writeHead(400); response.end('{}') }
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  baseEnv.CANONRY_SENTIMENT_SMOKE_PROVIDER_URL = `http://127.0.0.1:${stub.address().port}/v1/systemone`
  const portFinder = createServer()
  await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve))
  const port = portFinder.address().port
  await new Promise(resolve => portFinder.close(resolve))
  const base = `http://127.0.0.1:${port}/smoke`
  for (const [role, token] of Object.entries({ admin: SMOKE_ADMIN, read: SMOKE_READ, scoped: SMOKE_SCOPED })) {
    const directory = path.join(scratch, role); await mkdir(directory)
    await writeFile(path.join(directory, 'config.yaml'), JSON.stringify({ apiUrl: base, apiKey: token, database, port, host: '127.0.0.1', basePath: '/smoke/', telemetry: false, updateCheck: false, providers: {}, sentiment: { enabled: true, model: 'jev-1.13.0', maxConcurrency: 2, maxAttempts: 1, maxRequestsPerMinute: 6, maxInputTokensPerMinute: 150000 } }), { mode: 0o600 })
    configs[role] = { ...baseEnv, CANONRY_CONFIG_DIR: directory }
  }
  server = spawn(process.execPath, [bin, 'serve', '--host', '127.0.0.1', '--port', String(port)], { cwd: scratch, env: { ...configs.admin, TYPESAFE_API_KEY: 'synthetic-engine-key' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const capture = data => { serverOutput = (serverOutput + String(data)).slice(-60000) }
  server.stdout.on('data', capture); server.stderr.on('data', capture)
  async function http(project, suffix = '', { selection = {}, method = 'GET', body, key = SMOKE_ADMIN, status = 200 } = {}) {
    const url = new URL(`${base}/api/v1/projects/${project}/sentiment${suffix}`)
    // Summary query rows are compact by default; this smoke checks every engine verdict, so it asks for them.
    if (['', '/evidence', '/backfill-preview'].includes(suffix)) url.search = new URLSearchParams({ mode: project === 'simple' ? 'simple' : 'advanced', queryClass: 'non-brand', scope: 'project', runId: `${project}-run`, ...(suffix === '' ? { include: 'assessments,locations' } : {}), ...selection }).toString()
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data
  }
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch { /* bounded readiness */ }
    assert(tries < 120 && server.exitCode === null, 'Installed server failed readiness')
    await wait(250)
  }
  for (const project of ['simple', 'advanced']) assert.equal((await http(project)).state, 'disabled')
  assert.equal(await receiptCount(), 0)
  await http('simple', '/settings', { method: 'PUT', body: { enabled: true }, key: SMOKE_READ, status: 403 })
  mark('Default-off reads and read-only configuration denial make no provider calls')
  for (const project of ['simple', 'advanced']) await http(project, '/settings', { method: 'PUT', body: { enabled: true } })
  const jobs = []
  for (const [project, selection, count] of [['simple', { provider: 'openai' }, 1], ['simple', { provider: 'gemini' }, 1], ['simple', { provider: 'claude' }, 1], ['advanced', {}, 4]]) {
    const preview = await http(project, '/backfill-preview', { selection })
    assert.equal(preview.eligibleAssessments, count, JSON.stringify(preview))
    const job = await http(project, '/backfills', { method: 'POST', body: { previewToken: preview.previewToken, idempotencyKey: `engine-${project}-${selection.provider ?? 'all'}` } })
    jobs.push({ project, id: job.id })
  }
  for (const { project, id } of jobs) for (let tries = 0; ; tries++) {
    const job = await http(project, `/jobs/${id}`)
    if (job.state === 'complete') break
    assert(tries < 120 && !['failed', 'canceled'].includes(job.state), JSON.stringify(job))
    await wait(500)
  }
  assert.equal(await receiptCount(), 6); assert.equal(report.providerRequests.length, 6); assert(!report.stubFailure, report.stubFailure)
  mark('Seven assessments complete through six deterministic loopback calls; absent subject abstains locally, fourth engine remains unadmitted')
  const simple = await http('simple'), advanced = await http('advanced')
  const simpleRows = simple.queries[0].assessments
  assert.equal(simple.score.favorableRate, 0.5); assert.equal(simple.coverage.judged, 2); assert.equal(simple.coverage.selected, 3); assert.equal(simple.coverage.unadmittedAssessments, 1)
  assert.equal(simpleRows.length, 4)
  for (const [provider, outcome] of [['openai', 'favorable'], ['gemini', 'unfavorable'], ['claude', 'subject-not-mentioned'], ['perplexity', null]]) {
    const row = simpleRows.find(item => item.provider === provider)
    assert(row); assert.equal(row.outcome, outcome); assert.equal(row.sourceSnapshotId, `simple-${provider}`)
    assert.equal(row.requestedModel, `synthetic-${provider}-requested`); assert.equal(row.servedModel, `synthetic-${provider}-served`)
    if (provider === 'perplexity') { assert.equal(row.assessmentId, null); assert.equal(row.state, 'not-measured') }
  }
  assert.equal(advanced.queries[0].assessments.length, 4); assert.equal(advanced.coverage.distinctSourceAnswers, 2)
  assert.equal(advanced.score.favorableRate, 0.5)
  for (const project of ['simple', 'advanced']) {
    const branded = await http(project, '', { selection: { queryClass: 'branded' } })
    assert.equal(branded.coverage.judged, 0); assert.equal(branded.queries.length, 0); assert.equal(branded.score.favorableRate, null)
  }
  mark('Batched engine outcomes preserve exact sources/models and truthful absent/unmeasured states; class populations remain separate')
  const scopedReads = []
  for (const project of ['simple', 'advanced']) for (const provider of ['openai', 'gemini']) {
    const selection = { provider, ...(project === 'advanced' ? { scope: 'property', scopeKey: 'harbor', marketKey: 'market-harbor', location: provider === 'openai' ? 'Harbor' : 'Marina' } : {}), model: `synthetic-${provider}-served` }
    const summary = await http(project, '', { selection })
    assert.equal(summary.score.favorableRate, provider === 'openai' ? 1 : 0)
    assert.equal(summary.coverage.judged, 1)
    const row = summary.queries[0].assessments[0]
    assert.equal(summary.queries[0].assessments.length, 1)
    if (project === 'advanced') assert.equal(row.subjectLabel, 'Harbor Homes')
    const exact = await http(project, '/evidence', { selection: { ...selection, assessmentId: row.assessmentId, evaluationDefinitionId: row.evaluationDefinitionId } })
    assert.equal(exact.selection.assessmentId, row.assessmentId); assert.equal(exact.items.length, 1)
    assert.equal(exact.items[0].assessmentId, row.assessmentId); assert.equal(exact.items[0].sourceSnapshotId, row.sourceSnapshotId); assert.equal(exact.items[0].outcome, row.outcome)
    assert(exact.items[0].conclusion.length > 0)
    for (const span of exact.items[0].conclusion) assert.equal(exact.items[0].sourceText.slice(span.start, span.end), span.text)
    const wrongEngine = await http(project, '/evidence', { selection: { ...selection, provider: provider === 'openai' ? 'gemini' : 'openai', assessmentId: row.assessmentId } })
    assert.equal(wrongEngine.items.length, 0)
    scopedReads.push({ project, selection, summary, exact })
  }
  mark('Provider/served-model/location/property/market filters produce exact scores and single-assessment evidence without widening scope')
  const require = createRequire(path.join(packageRoot, 'package.json'))
  const sdk = name => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${name}`)).href)
  const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js'), { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js')
  for (const transport of [new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${SMOKE_READ}` } } }), new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, 'bin/canonry-mcp.mjs'), '--eager'], cwd: scratch, env: configs.read, stderr: 'pipe' })]) {
    const client = new Client({ name: 'engine-smoke', version: '1' }); clients.push(client); await client.connect(transport)
    for (const { project, selection, summary, exact } of scopedReads) {
      const common = { mode: project === 'simple' ? 'simple' : 'advanced', queryClass: 'non-brand', scope: 'project', runId: `${project}-run`, ...selection }
      for (const [name, parameters, expected] of [['canonry_sentiment', { ...common, include: ['assessments', 'locations'] }, summary], ['canonry_sentiment_evidence', { ...common, assessmentId: exact.selection.assessmentId, evaluationDefinitionId: exact.selection.evaluationDefinitionId }, exact]]) {
        const result = await client.callTool({ name, arguments: { project, ...parameters } })
        assert(!result.isError, JSON.stringify(result)); assert.deepEqual(result.structuredContent ?? JSON.parse(result.content[0].text), expected)
      }
    }
    await client.close()
  }
  for (const { project, selection, summary, exact } of scopedReads) {
    const flags = ['--run-id', `${project}-run`, '--mode', project === 'simple' ? 'simple' : 'advanced', '--query-class', 'non-brand', ...Object.entries(selection).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`, value]), '--format', 'json']
    assert.deepEqual(await command(bin, ['sentiment', project, ...flags, '--include', 'assessments,locations'], configs.read), summary)
    assert.deepEqual(await command(bin, ['sentiment', 'evidence', project, ...flags, '--assessment-id', exact.selection.assessmentId, '--evaluation-definition-id', exact.selection.evaluationDefinitionId], configs.read), exact)
  }
  mark('Installed CLI and both read-only MCP transports preserve batched verdict JSON and exact assessment evidence')
  if (args.includes('--browser')) {
    const env = { ...cleanEnv, ...browserEnv(), SENTIMENT_SMOKE_URL: `${base}/`, SENTIMENT_BROWSER_ARTIFACTS: path.join(scratch, 'browser') }
    browserProcess = spawn(process.execPath, [fileURLToPath(new URL('./smoke-sentiment-engines-browser.mjs', import.meta.url))], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; browserProcess.stdout.on('data', data => { output += String(data) }); browserProcess.stderr.on('data', data => { output += String(data) })
    const timer = setTimeout(() => { process.kill(-browserProcess.pid, 'SIGTERM') }, 180000)
    try { await new Promise(resolve => browserProcess.once('exit', resolve)) } finally { clearTimeout(timer) }
    await writeFile(path.join(scratch, 'browser.log'), redact(output))
    assert.equal(browserProcess.exitCode, 0, redact(output))
    report.browser = JSON.parse(await readFile(path.join(scratch, 'browser/browser-report.json'), 'utf8'))
    mark('Installed browser engine filters, verdicts, exact evidence, mobile layout, permissions and batched reads pass')
  }
  for (const project of ['simple', 'advanced']) {
    await http(project, '/settings', { method: 'PUT', body: { enabled: false } })
    const disabled = await http(project)
    assert.equal(disabled.state, 'disabled'); assert.equal(disabled.score.favorableRate, null)
    assert(disabled.queries.every(query => query.assessments.every(item => item.outcome === null)))
  }
  assert.equal(await receiptCount(), 6)
  report.summaries = { simple, advanced }; report.scopedReads = scopedReads; report.receipts = JSON.parse(`[${(await readFile(receiptsFile, 'utf8')).trim().split('\n').join(',')}]`)
  mark('Repeated reads, filtering, evidence and disabled views add zero provider attempts')
  report.complete = true
} catch (error) { report.failure = redact(error.stack ?? error); process.exitCode = 1 }
finally {
  await Promise.allSettled(clients.map(client => client.close()))
  await stop(browserProcess, true); await stop(server)
  if (stub) await new Promise(resolve => stub.close(resolve))
  report.serverStopped = !server || server.exitCode !== null
  await writeFile(path.join(scratch, 'server-redacted.log'), redact(serverOutput))
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ complete: report.complete, failure: report.failure ?? null, report: path.join(scratch, 'report.json'), serverStopped: report.serverStopped }))
}
