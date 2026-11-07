/** Built SPA -> real API/forwarder -> intercepted collector, using synthetic data only. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(script), '..')
const key = 'cnry_screen_time_synthetic_operator'
const basePath = '/ui-time-smoke/'
const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]))

if (process.argv.includes('--build-spa')) {
  const webRoot = path.join(root, 'apps/web')
  const require = createRequire(path.join(webRoot, 'package.json'))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  await build({ root: webRoot, envDir: false, build: { outDir: process.env.UI_TIME_ASSETS, emptyOutDir: true } })
} else if (process.argv.includes('--server')) {
  const fixture = process.env.CANONRY_CONFIG_DIR
  assert(fixture && path.basename(fixture).startsWith('fixture-'))
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === 'https://canonry.ai/api/feedback') {
      const feedback = await request.json()
      appendFileSync(path.join(fixture, 'feedback.jsonl'), JSON.stringify(feedback) + '\n')
      return Response.json({ accepted: true, id: feedback.feedbackId }, { status: 202 })
    }
    assert.equal(request.url, 'https://canonry.ai/api/telemetry', 'Unexpected outbound fetch')
    appendFileSync(path.join(fixture, 'captured.jsonl'), await request.text() + '\n')
    return new Response('{}', { status: 202 })
  }
  net.Socket.prototype.connect = function () { throw new Error('All outbound sockets are blocked') }
  const { createClient, migrate, apiKeys, projects } = await import('../packages/db/src/index.ts')
  const { createServer, loadConfig } = await import('../packages/canonry/dist/index.js')
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)
  const now = '2026-11-05T00:00:00.000Z'
  db.insert(apiKeys).values({ id: 'key_default', name: 'Synthetic smoke', keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 9), scopes: ['*'], createdAt: now }).run()
  db.insert(projects).values({ id: 'screen-time-smoke', name: 'screen-time-smoke', displayName: 'Synthetic project', canonicalDomain: 'synthetic.invalid', country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now }).run()
  const app = await createServer({ config, db, host: '127.0.0.1', assetsDir: process.env.UI_TIME_ASSETS, logger: false })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  process.send?.({ base: origin + basePath })
  process.once('SIGTERM', () => { void app.close().finally(() => { db.$client.close(); process.exit(0) }) })
} else {
  const output = process.env.UI_TIME_ARTIFACTS ?? await mkdtemp(path.join(tmpdir(), 'canonry-ui-time-'))
  await mkdir(output, { recursive: true })
  const report = { status: 'running', assertions: [], externalRequests: [], errors: [], timing: [] }
  const mark = text => { report.assertions.push(text); console.log(`PASS ${text}`) }
  let browser
  let server
  const run = (args, env, log, command = process.execPath) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => appendFileSync(path.join(output, log), data))
    child.stderr.on('data', data => appendFileSync(path.join(output, log), data))
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${log}: exit ${code}`)))
  })
  try {
    await run(['build:cli'], cleanEnv, 'cli-build.log', 'pnpm')
    const assets = path.join(output, 'spa')
    await run(['--import', 'tsx', script, '--build-spa'], { ...cleanEnv, VITE_API_KEY: key, UI_TIME_ASSETS: assets }, 'web-build.log')
    const fixture = await mkdtemp(path.join(output, 'fixture-'))
    await writeFile(path.join(fixture, 'config.yaml'), JSON.stringify({
      apiUrl: `http://127.0.0.1${basePath}`, apiKey: key, database: path.join(fixture, 'synthetic.sqlite'),
      host: '127.0.0.1', basePath, telemetry: true, updateCheck: false, providers: {},
      dashboard: { showAgentBar: false, showUpdateNotification: false, showResourceLinks: false },
    }), { mode: 0o600 })
    server = spawn(process.execPath, ['--import', 'tsx', script, '--server'], {
      cwd: root, env: { ...cleanEnv, CANONRY_CONFIG_DIR: fixture, CANONRY_AGENT_DISABLED: '1',
        CANONRY_DISABLE_UPDATE_CHECK: '1', CANONRY_OPERATOR_KEY_IDS: 'key_default', UI_TIME_ASSETS: assets },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    server.stdout.on('data', data => appendFileSync(path.join(output, 'server.log'), data))
    server.stderr.on('data', data => appendFileSync(path.join(output, 'server.log'), data))
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 30_000)
      server.once('message', value => { clearTimeout(timeout); resolve(value.base) })
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)) })
      server.once('error', reject)
    })
    const { chromium } = await import(process.env.CANONRY_PLAYWRIGHT_MODULE ?? 'playwright')
    browser = await chromium.launch({ headless: true, ...(process.env.CANONRY_BROWSER_EXECUTABLE ? { executablePath: process.env.CANONRY_BROWSER_EXECUTABLE } : {}) })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) {
        report.externalRequests.push(route.request().url())
        return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    const sent = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === `${basePath}api/v1/telemetry/ui`) sent.push(request.postDataJSON())
    })
    await page.clock.install()
    await page.goto(new URL('settings', base).href, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    await page.bringToFront()
    assert(await page.evaluate(() => globalThis.document.hasFocus() && globalThis.document.visibilityState === 'visible'))
    await page.clock.runFor(20_000)
    const runsResolved = page.waitForRequest(request => {
      if (!request.url().endsWith('/telemetry/ui')) return false
      const event = request.postDataJSON()
      return event?.event === 'ui.page_viewed' && event.page === '/runs'
    })
    await page.getByRole('link', { name: 'Runs', exact: true }).first().click()
    await page.waitForURL('**/runs')
    await runsResolved
    await page.clock.runFor(70_000)
    // A real visibility transition is covered by browser navigation; lifecycle arithmetic
    // and idle/background/suspension edges also have deterministic browser-DOM tests.
    await page.goto(new URL('settings', base).href, { waitUntil: 'networkidle' })
    const captured = (await readFile(path.join(fixture, 'captured.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    report.timing = captured.filter(e => e.event === 'ui.page_time')
    assert(report.timing.some(e => e.properties.page === '/settings' && e.properties.foregroundMs >= 20_000 && e.properties.completed))
    assert(report.timing.some(e => e.properties.page === '/runs' && e.properties.foregroundMs >= 60_000))
    assert(report.timing.every(e => e.source === 'dashboard' && e.eventId && e.properties.visitId))
    assert(sent.some(e => e.event === 'ui.page_time' && e.page === '/settings'))
    assert(!JSON.stringify(report.timing).includes('synthetic.invalid'))
    mark('Built SPA emits real screen timings through the SDK, mounted API and server forwarder')
    if (process.env.CANONRY_TELEMETRY_VALIDATOR) {
      const { telemetrySchema } = await import(pathToFileURL(process.env.CANONRY_TELEMETRY_VALIDATOR).href)
      for (const event of report.timing) telemetrySchema.parse(event)
      mark('Actual forwarded envelopes pass the updated collector schema')
    }
    // Exhaust the real host gate, including a browser checkpoint during the
    // throttle. A consent-shaped refusal here would permanently stop its timer.
    const sample = sent.find(e => e.event === 'ui.page_time')
    const flood = await Promise.all(Array.from({ length: 70 }, () => context.request.post(new URL('api/v1/telemetry/ui', base).href, {
      headers: { authorization: `Bearer ${key}` }, data: sample,
    })))
    assert(flood.some(response => response.status() === 429))
    const throttled = page.waitForResponse(response => response.url().endsWith('/telemetry/ui') && response.status() === 429)
    await page.clock.runFor(70_000)
    await throttled
    await new Promise(resolve => setTimeout(resolve, 1_200))
    const recovered = page.waitForResponse(response => response.url().endsWith('/telemetry/ui') && response.status() === 202)
    await page.clock.runFor(70_000)
    assert.deepEqual(await (await recovered).json(), { accepted: true })
    mark('Browser timing recovers after a real server rate limit')

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.clock.runFor(300)
    await page.screenshot({ path: path.join(output, 'feedback-closed.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Feedback', exact: true }).click()
    const feedback = page.getByRole('dialog', { name: 'Share feedback' })
    await page.screenshot({ path: path.join(output, 'feedback-empty.png'), animations: 'disabled' })
    await feedback.getByRole('textbox', { name: 'Your feedback' }).fill('It would help to compare time spent across screens.')
    await page.screenshot({ path: path.join(output, 'feedback-dark.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await feedback.waitFor({ state: 'hidden' })
    // Radix restores focus on a timer after unmount; advance the browser clock.
    await page.clock.runFor(50)
    assert(await page.getByRole('button', { name: 'Feedback', exact: true }).evaluate(el => el === el.ownerDocument.activeElement))
    await page.getByRole('radio', { name: 'Light', exact: true }).click()
    await page.getByRole('button', { name: 'Feedback', exact: true }).click()
    assert.equal(await feedback.getByRole('textbox').inputValue(), 'It would help to compare time spent across screens.')
    await page.screenshot({ path: path.join(output, 'feedback-light.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.clock.runFor(300)
    assert.equal(await page.locator('header.topbar').count(), 1)
    await page.screenshot({ path: path.join(output, 'feedback-mobile.png'), animations: 'disabled' })
    const bounds = await feedback.boundingBox()
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390)
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth))
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 844 })
      const panel = await feedback.boundingBox()
      assert(panel && panel.x >= 0 && panel.x + panel.width <= width, `Feedback fits at ${width}px`)
      assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `Page fits at ${width}px`)
    }
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('radio', { name: 'Dark', exact: true }).click()
    mark('Feedback preserves its draft and focus across dismissal; desktop themes and mobile fit')

    const optOut = await context.request.put(new URL('api/v1/telemetry', base).href, { headers: { authorization: `Bearer ${key}` }, data: { enabled: false } })
    assert.equal(optOut.status(), 200)
    const readTimings = async () => (await readFile(path.join(fixture, 'captured.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.event === 'ui.page_time').length
    const before = await readTimings()
    await page.clock.runFor(70_000)
    const declined = await context.request.post(new URL('api/v1/telemetry/ui', base).href, { headers: { authorization: `Bearer ${key}` }, data: sent.find(e => e.event === 'ui.page_time') })
    assert.deepEqual(await declined.json(), { accepted: false })
    const after = await readTimings()
    assert.equal(after, before)
    mark('Persisted opt-out declines timings and forwards no further screen-time data')
    await page.getByRole('button', { name: 'Feedback', exact: true }).click()
    await feedback.getByRole('button', { name: 'Send feedback' }).click()
    await feedback.getByRole('status').waitFor()
    await page.screenshot({ path: path.join(output, 'feedback-sent.png'), animations: 'disabled' })
    const received = (await readFile(path.join(fixture, 'feedback.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(received.length, 1)
    assert.equal(received[0].source, 'dashboard')
    assert.equal(received[0].summary, 'It would help to compare time spent across screens.')
    assert.equal(received[0].details, 'Screen: /settings')
    assert(!('anonymousId' in received[0]))
    if (process.env.CANONRY_FEEDBACK_VALIDATOR) {
      const { feedbackSchema } = await import(pathToFileURL(process.env.CANONRY_FEEDBACK_VALIDATOR).href)
      feedbackSchema.parse(received[0])
    }
    mark('Explicit feedback reaches the collector with telemetry off, without an install id')
    assert.deepEqual(report.externalRequests, [])
    assert.deepEqual(report.errors, [])
    mark('No browser external requests or runtime errors; all server egress is intercepted or blocked')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  } finally {
    await browser?.close()
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise(resolve => {
        const timeout = setTimeout(() => { server.kill('SIGKILL'); resolve() }, 5000)
        server.once('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ status: report.status, output, error: report.error }))
  }
}
