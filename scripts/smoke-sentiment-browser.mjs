import { realpath, mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.CANONRY_PLAYWRIGHT_MODULE ?? 'playwright')

const base = new URL(process.env.SENTIMENT_SMOKE_URL ?? 'http://127.0.0.1:4300/smoke/')
if (!base.pathname.endsWith('/')) base.pathname += '/'
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Browser smoke only supports its isolated loopback fixture server.')
const output = process.env.SENTIMENT_BROWSER_ARTIFACTS ?? '/tmp/canonry-sentiment-browser-artifacts'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ ...(process.env.CANONRY_BROWSER_EXECUTABLE ? { executablePath: process.env.CANONRY_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--no-sandbox'] })
const adminKey = process.env.SENTIMENT_SMOKE_CANONRY_KEY ?? 'cnry_sentiment_synthetic_admin'
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, extraHTTPHeaders: { authorization: `Bearer ${adminKey}` } })
const report = { base: base.href, requests: [], consoleErrors: [], pageErrors: [], screenshots: [], assertions: [], externalEgressBlocked: [] }
await context.route('**/*', async route => {
  const url = new URL(route.request().url())
  if (url.origin !== base.origin) { report.externalEgressBlocked.push(url.origin); await route.abort(); return }
  await route.continue()
})
const page = await context.newPage()
function observePage(observed) {
  observed.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
  observed.on('pageerror', error => report.pageErrors.push(error.message))
  observed.on('response', response => { if (response.status() >= 400) report.requests.push({ path: new URL(response.url()).pathname, status: response.status() }) })
}
observePage(page)
async function capture(name) { const file = `${output}/${name}.png`; await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file) }
async function view(project, query = '') {
  await page.goto(new URL(`projects/${project}?queryClass=branded${query}`, base).href, { waitUntil: 'networkidle' })
  await page.getByRole('region', { name: 'Branded sentiment', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByLabel('Branded favorable share', { exact: true }).waitFor({ timeout: 30_000 })
}
try {
  const session = await context.request.post(new URL('api/v1/session', base).href, { data: { apiKey: adminKey } })
  if (session.status() !== 200) throw new Error(`Synthetic administrator session returned ${session.status()}`)
  await view('simple', '&measurementRunId=simple-run')
  await page.getByRole('region', { name: 'Branded sentiment', exact: true }).scrollIntoViewIfNeeded()
  report.assertions.push('Simple branded score renders from stored results')
  await capture('simple-wide')
  await page.getByRole('button', { name: 'View sentiment evidence', exact: true }).click()
  await page.getByRole('button', { name: 'Open sentiment evidence for Aurora Service', exact: true }).click()
  const simpleDialog = page.getByRole('dialog', { name: 'Sentiment evidence: Aurora Service', exact: true })
  await simpleDialog.waitFor()
  await page.keyboard.press('Tab')
  if (!await simpleDialog.evaluate(node => node.contains(node.ownerDocument.activeElement))) throw new Error('Evidence drawer failed keyboard focus containment')
  await capture('simple-evidence')
  await page.keyboard.press('Escape')
  await simpleDialog.waitFor({ state: 'hidden' })
  const evidenceOpener = await page.getByRole('button', { name: 'Open sentiment evidence for Aurora Service', exact: true }).elementHandle()
  await page.waitForFunction(node => node !== null && node.ownerDocument.activeElement === node, evidenceOpener, { timeout: 3000 })
  await evidenceOpener?.dispose()
  report.assertions.push('Evidence drawer traps keyboard focus, closes on Escape, and restores its opener')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('region', { name: 'Branded sentiment', exact: true }).scrollIntoViewIfNeeded()
  await capture('simple-mobile')
  await page.getByRole('region', { name: 'Branded sentiment', exact: true }).screenshot({ path: `${output}/sentiment-mobile.png` })
  report.screenshots.push(`${output}/sentiment-mobile.png`)
  const sentimentOverflow = await page.getByRole('region', { name: 'Branded sentiment', exact: true }).evaluate(node => node.getBoundingClientRect().width > node.ownerDocument.documentElement.clientWidth)
  if (sentimentOverflow) throw new Error('Sentiment section overflows the mobile viewport')
  report.assertions.push('Sentiment section fits the narrow viewport')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await view('advanced', '&measurementRunId=advanced-run&measurementScope=property&measurementScopeKey=harbor&measurementMarketKey=market-harbor')
  await page.getByRole('region', { name: 'Branded sentiment', exact: true }).scrollIntoViewIfNeeded()
  await capture('advanced-harbor')
  await page.getByRole('button', { name: 'View sentiment evidence', exact: true }).click()
  await page.getByRole('button', { name: 'Open sentiment evidence for Harbor Homes', exact: true }).waitFor()
  if (await page.getByRole('button', { name: 'Open sentiment evidence for Bayside Homes', exact: true }).count()) throw new Error('Advanced property/market scope leaked sibling evidence')
  report.assertions.push('Advanced Property and market filters preserve only the selected subject')
  await page.getByRole('button', { name: 'Open sentiment evidence for Harbor Homes', exact: true }).click()
  await page.getByRole('dialog', { name: 'Sentiment evidence: Harbor Homes', exact: true }).waitFor()
  await capture('advanced-evidence')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Manage sentiment', exact: true }).click()
  await page.getByRole('button', { name: 'Preview sentiment backfill', exact: true }).click()
  await page.getByText('Eligible assessments', { exact: true }).waitFor()
  await capture('advanced-preview')
  report.assertions.push('Administrator preview displays admission counts without submitting work')
  const admittedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${base.pathname}api/v1/projects/advanced/sentiment/backfills`)
  await page.getByRole('button', { name: 'Confirm sentiment backfill', exact: true }).click()
  const admission = await admittedResponse
  if (admission.status() !== 200) throw new Error(`Browser backfill admission returned ${admission.status()}`)
  const admittedJob = await admission.json()
  if (admittedJob.state !== 'complete' || admittedJob.selected !== 1 || admittedJob.counts.favorable !== 1) throw new Error('Browser backfill did not reuse the completed Harbor assessment')
  report.admittedJob = { id: admittedJob.id, state: admittedJob.state, selected: admittedJob.selected }
  await page.getByText('Backfill submitted. Progress is available in Recent jobs.', { exact: true }).waitFor()
  await page.getByText('Sentiment jobs and comparison', { exact: true }).click()
  await page.getByRole('region', { name: 'Sentiment jobs', exact: true }).getByRole('row').nth(1).getByText('Complete', { exact: true }).waitFor()
  await capture('advanced-backfill')
  report.assertions.push('Administrator confirms a real backfill and sees its completed job receipt reusing the existing assessment')
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: 'Bearer cnry_sentiment_synthetic_read' } })
  await viewerContext.route('**/*', async route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort())
  const viewerSession = await viewerContext.request.post(new URL('api/v1/session', base).href, { data: { apiKey: 'cnry_sentiment_synthetic_read' } })
  if (viewerSession.status() !== 200) throw new Error(`Synthetic viewer session returned ${viewerSession.status()}`)
  const viewer = await viewerContext.newPage()
  observePage(viewer)
  await viewer.goto(new URL('projects/simple?queryClass=branded&measurementRunId=simple-run', base).href, { waitUntil: 'networkidle' })
  await viewer.getByLabel('Branded favorable share', { exact: true }).waitFor({ timeout: 30_000 })
  if (await viewer.getByRole('button', { name: 'Manage sentiment', exact: true }).count()) throw new Error('Read-only browser displayed administrator controls')
  const denied = await viewer.request.put(new URL('api/v1/projects/simple/sentiment/settings', base).href, { data: { enabled: false } })
  if (denied.status() !== 403) throw new Error(`Read-only mutation returned ${denied.status()}, expected 403`)
  await viewer.screenshot({ path: `${output}/simple-readonly.png`, fullPage: true })
  report.screenshots.push(`${output}/simple-readonly.png`)
  report.assertions.push('Read-only browser shows stored sentiment, hides administrator controls, and its write is denied')
  await viewerContext.close()
  if (!process.env.SENTIMENT_SMOKE_DATABASE) throw new Error('SENTIMENT_SMOKE_DATABASE must name the copied synthetic.sqlite fixture for open-session demotion coverage')
  const databasePath = await realpath(process.env.SENTIMENT_SMOKE_DATABASE)
  if (!databasePath.startsWith('/tmp/canonry-sentiment-') || !databasePath.endsWith('/synthetic.sqlite')) throw new Error('Permission-change smoke only edits a copied /tmp/canonry-sentiment-*/synthetic.sqlite fixture')
  const { DatabaseSync } = await import('node:sqlite')
  const createdResponse = await context.request.post(new URL('api/v1/keys', base).href, { data: { name: 'Synthetic sentiment browser demotion', scopes: ['*'] } })
  if (createdResponse.status() !== 200) throw new Error(`Synthetic permission-change credential creation returned ${createdResponse.status()}`)
  const created = await createdResponse.json()
  const changingContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: `Bearer ${created.key}` } })
  try {
    await changingContext.route('**/*', async route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort())
    const changingSession = await changingContext.request.post(new URL('api/v1/session', base).href, { data: { apiKey: created.key } })
    if (changingSession.status() !== 200) throw new Error('Synthetic permission-change session failed')
    const changing = await changingContext.newPage()
    observePage(changing)
    await changing.goto(new URL('projects/simple?queryClass=branded&measurementRunId=simple-run', base).href, { waitUntil: 'networkidle' })
    await changing.getByRole('button', { name: 'Manage sentiment', exact: true }).click()
    await changing.getByRole('button', { name: 'Save sentiment settings', exact: true }).waitFor()
    const database = new DatabaseSync(databasePath)
    try {
      const result = database.prepare('UPDATE api_keys SET scopes = ? WHERE id = ? AND name = ?').run(JSON.stringify(['read']), created.id, 'Synthetic sentiment browser demotion')
      if (result.changes !== 1) throw new Error('Permission-change fixture must match the REST-created credential')
    } finally { database.close() }
    const writes = []
    changing.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/sentiment/settings')) writes.push(request.url()) })
    await changing.getByRole('button', { name: 'Save sentiment settings', exact: true }).click()
    await changing.getByRole('button', { name: 'Manage sentiment', exact: true }).waitFor({ state: 'hidden' })
    if (writes.length !== 0) throw new Error('Open settings editor submitted a write after permission demotion')
    const deniedAfterChange = await changing.request.put(new URL('api/v1/projects/simple/sentiment/settings', base).href, { data: { enabled: false } })
    if (deniedAfterChange.status() !== 403) throw new Error('Demoted browser session retained write authority')
    await changing.screenshot({ path: `${output}/permission-changed.png`, fullPage: true })
    report.screenshots.push(`${output}/permission-changed.png`)
    report.assertions.push('An open administrator editor rechecks changed permissions, closes before writing, and the server denies the demoted session')
  } finally {
    await changingContext.close()
    const revoked = await context.request.post(new URL(`api/v1/keys/${created.id}/revoke`, base).href)
    if (revoked.status() !== 200) report.cleanupFailed = true
  }
  if (report.cleanupFailed) throw new Error('Synthetic permission-change credential cleanup failed')
  if (report.requests.length || report.consoleErrors.length || report.pageErrors.length) throw new Error('Unexpected browser HTTP or console errors; inspect the report')
  report.complete = true
} catch (error) {
  report.complete = false
  report.failure = error.message
  await capture('failure')
} finally {
  await writeFile(`${output}/browser-report.json`, JSON.stringify(report, null, 2) + '\n')
  await browser.close()
}
console.log(JSON.stringify({ complete: report.complete, failure: report.failure ?? null, report: `${output}/browser-report.json` }))
process.exitCode = report.complete && report.pageErrors.length === 0 ? 0 : 1
