import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.CANONRY_PLAYWRIGHT_MODULE ?? 'playwright')
const base = new URL(process.env.SENTIMENT_SMOKE_URL)
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname), 'Browser smoke requires its isolated loopback server')
const output = process.env.SENTIMENT_BROWSER_ARTIFACTS
assert(output?.startsWith('/tmp/canonry-sentiment-engines-'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CANONRY_BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] })
const report = { complete: false, checks: [], screenshots: [], reads: [], httpErrors: [], consoleErrors: [], pageErrors: [], externalRequests: [] }
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true, extraHTTPHeaders: { authorization: 'Bearer cnry_sentiment_synthetic_admin' } })
async function restrict(context) { await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== base.origin) { report.externalRequests.push(route.request().url()); await route.abort() } else await route.continue() }) }
await restrict(context)
const page = await context.newPage()
function observe(page) {
  page.on('request', request => { const url = new URL(request.url()); if (request.method() === 'GET' && url.pathname.includes('/sentiment')) report.reads.push(url.pathname + url.search) })
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }) })
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
  page.on('pageerror', error => report.pageErrors.push(error.message))
}
observe(page)
const simpleQuery = 'Reliable repair services in Aurora City'
const advancedQuery = 'Best apartments in Harbor and Marina'
const labels = { favorable: 'Favorable', unfavorable: 'Unfavorable', 'subject-not-mentioned': 'Not mentioned' }
const mark = message => report.checks.push(message)
async function screenshot(name) { const file = `${output}/${name}.png`; await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file) }
async function summary(project, scope = {}) {
  const url = new URL(`api/v1/projects/${project}/sentiment`, base)
  url.search = new URLSearchParams({ mode: project === 'simple' ? 'simple' : 'advanced', queryClass: 'non-brand', scope: 'project', runId: `${project}-run`, ...scope }).toString()
  const response = await context.request.get(url.href)
  assert.equal(response.status(), 200)
  return response.json()
}
async function visit(project, extra = '') {
  await page.goto(new URL(`projects/${project}?queryClass=non-brand&measurementRunId=${project}-run${extra}`, base).href, { waitUntil: 'networkidle' })
  await page.getByLabel('Non-brand favorable share', { exact: true }).waitFor()
}
async function checkScore(value, queryText) {
  await page.getByLabel('Non-brand favorable share', { exact: true }).getByText(value.score.favorableDisplay, { exact: true }).waitFor()
  const button = page.getByRole('button', { name: `View Non-brand sentiment evidence for ${queryText}`, exact: true })
  await button.waitFor()
  assert((await button.innerText()).includes(value.queries[0].score.favorableDisplay))
}
async function expandSimple() {
  const button = page.getByRole('button', { name: simpleQuery, exact: true })
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  await page.locator('.query-evidence-engine-row').first().waitFor()
  await page.waitForLoadState('networkidle')
}
async function exactEvidence(row, scope, queryText, checkKeyboard = false) {
  const label = labels[row.outcome] ?? 'Not classified'
  const button = scope.getByRole('button', { name: `View ${row.provider} sentiment evidence for ${row.subjectLabel}: ${label}`, exact: true })
  await button.waitFor()
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/sentiment/evidence'))
  await button.click()
  const response = await responsePromise
  assert.equal(response.status(), 200)
  const value = await response.json(), requested = new URL(response.url())
  assert.equal(requested.searchParams.get('assessmentId'), row.assessmentId)
  assert.equal(value.selection.assessmentId, row.assessmentId)
  assert.equal(value.selection.queryClass, 'non-brand')
  assert.equal(value.items.length, 1)
  assert.equal(value.items[0].assessmentId, row.assessmentId)
  assert.equal(value.items[0].sourceSnapshotId, row.sourceSnapshotId)
  assert.equal(value.items[0].outcome, row.outcome)
  assert.equal(value.items[0].context.provider, row.provider)
  assert.equal(value.items[0].context.servedModel, row.servedModel)
  assert.equal(value.items[0].context.location, row.location)
  const dialog = page.getByRole('dialog', { name: `Sentiment evidence: ${queryText} · ${row.provider} · ${row.subjectLabel}`, exact: true })
  await dialog.waitFor()
  if (row.outcome === 'favorable' || row.outcome === 'unfavorable') await dialog.locator('blockquote').first().waitFor()
  assert((await dialog.innerText()).includes(row.subjectLabel))
  if (checkKeyboard) {
    await page.keyboard.press('Tab')
    assert(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), 'Drawer must contain keyboard focus')
  }
  await screenshot(`evidence-${row.sourceSnapshotId}-${row.subjectId}`)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  const opener = await button.elementHandle()
  await page.waitForFunction(node => node !== null && node.ownerDocument.activeElement === node, opener, { timeout: 3000 })
  await opener?.dispose()
}
try {
  assert.equal((await context.request.post(new URL('api/v1/session', base).href, { data: { apiKey: 'cnry_sentiment_synthetic_admin' } })).status(), 200)
  const initial = report.reads.length
  await visit('simple')
  const simple = await summary('simple')
  await checkScore(simple, simpleQuery)
  const initialReads = report.reads.slice(initial).filter(url => new URL(url, base).pathname.endsWith('/sentiment'))
  assert.equal(initialReads.length, 2, 'Initial engine rows must share one summary per query class')
  assert.deepEqual(initialReads.map(url => new URL(url, base).searchParams.get('queryClass')).sort(), ['branded', 'non-brand'])
  const beforeExpand = report.reads.length
  await expandSimple()
  assert.equal(report.reads.length, beforeExpand, 'Expanding engine rows must not issue per-row sentiment reads')
  assert.equal(await page.locator('.query-evidence-engine-row').count(), 4)
  for (const row of simple.queries[0].assessments) {
    const cell = page.locator('.query-evidence-engine-row').getByLabel(`${row.provider} sentiment`, { exact: true })
    await cell.getByText(labels[row.outcome] ?? 'Not classified', { exact: true }).waitFor()
    if (!row.assessmentId) assert.equal(await cell.getByRole('button', { name: /^View / }).count(), 0)
  }
  await screenshot('simple-all-engines')
  mark('One batched read per class renders opposite engine verdicts plus absent/unclassified states; expansion adds zero sentiment reads')
  for (const provider of ['openai', 'gemini', 'claude', 'perplexity']) {
    const start = report.reads.length
    await page.getByRole('combobox', { name: 'Answer engine', exact: true }).selectOption(provider)
    await page.waitForLoadState('networkidle')
    const value = await summary('simple', { provider })
    await checkScore(value, simpleQuery)
    await expandSimple()
    assert.equal(await page.locator('.query-evidence-engine-row').count(), 1)
    const row = value.queries[0].assessments[0]
    const cell = page.locator('.query-evidence-engine-row').getByLabel(`${provider} sentiment`, { exact: true })
    await cell.getByText(labels[row.outcome] ?? 'Not classified', { exact: true }).waitFor()
    const reads = report.reads.slice(start).filter(url => new URL(url, base).pathname.endsWith('/sentiment'))
    assert.equal(reads.length, 2, 'Engine changes must use exactly the two class summary reads')
    assert(reads.every(url => new URL(url, base).searchParams.get('provider') === provider))
    if (row.assessmentId) await exactEvidence(row, cell, simpleQuery, provider === 'openai')
  }
  mark('Simple engine filter changes headline/query scores, visible engine verdicts and exact assessment evidence together; excluded sources remain Unavailable')
  await page.getByRole('combobox', { name: 'Answer engine', exact: true }).selectOption('')
  await page.waitForLoadState('networkidle'); await expandSimple()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileCell = page.locator('.query-evidence-engine-row').getByLabel('openai sentiment', { exact: true })
  await mobileCell.scrollIntoViewIfNeeded()
  assert(await mobileCell.evaluate(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= node.ownerDocument.documentElement.clientWidth }), 'Mobile engine verdict must remain reachable within the viewport')
  await screenshot('simple-engines-mobile')
  await exactEvidence(simple.queries[0].assessments.find(row => row.provider === 'openai'), mobileCell, simpleQuery)
  await page.setViewportSize({ width: 1440, height: 1100 })
  mark('Mobile engine verdict and drawer remain reachable; Escape restores the exact row opener')

  await visit('advanced')
  const allAdvanced = await summary('advanced')
  const beforeAdvancedExpand = report.reads.length
  await page.locator('[data-query-results="non-brand"] > summary').click()
  await page.waitForLoadState('networkidle')
  assert.equal(report.reads.length, beforeAdvancedExpand, 'Advanced engine disclosure must consume shared summaries')
  await checkScore(allAdvanced, advancedQuery)
  for (const row of allAdvanced.queries[0].assessments) {
    const cell = page.locator('.measurement-result-engine').getByLabel(`${row.provider} sentiment`, { exact: true })
    await cell.getByRole('button', { name: `View ${row.provider} sentiment evidence for ${row.subjectLabel}: ${labels[row.outcome]}`, exact: true }).waitFor()
  }
  await exactEvidence(allAdvanced.queries[0].assessments.find(row => row.provider === 'openai' && row.subjectLabel === 'Bayside Homes'), page.locator('.measurement-result-engine').getByLabel('openai sentiment', { exact: true }), advancedQuery)
  await screenshot('advanced-shared-subjects')
  mark('Advanced shared answers retain separate opposite subject verdicts and opening one never blends its sibling')
  await visit('advanced', '&measurementScope=property&measurementScopeKey=harbor&measurementMarketKey=market-harbor')
  const advancedScope = { scope: 'property', scopeKey: 'harbor', marketKey: 'market-harbor' }
  const advanced = await summary('advanced', advancedScope)
  await page.locator('[data-query-results="non-brand"] > summary').click()
  await checkScore(advanced, advancedQuery)
  for (const row of advanced.queries[0].assessments) {
    const cell = page.locator('.measurement-result-engine').getByLabel(`${row.provider} sentiment`, { exact: true })
    await cell.getByText(`${row.subjectLabel} · ${labels[row.outcome]}`, { exact: true }).waitFor()
    assert(!(await cell.innerText()).includes('Bayside Homes'), 'Property scope leaked sibling subject verdict')
  }
  await screenshot('advanced-all-engines')
  for (const provider of ['openai', 'gemini']) {
    const filters = page.getByRole('button', { name: /^Filters/ })
    if (!await page.getByRole('combobox', { name: 'Answer engine', exact: true }).isVisible()) await filters.click()
    await page.getByRole('combobox', { name: 'Answer engine', exact: true }).selectOption(provider)
    await page.waitForLoadState('networkidle')
    const value = await summary('advanced', { ...advancedScope, provider })
    await checkScore(value, advancedQuery)
    const disclosure = page.locator('[data-query-results="non-brand"]')
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
    const cell = page.locator('.measurement-result-engine').getByLabel(`${provider} sentiment`, { exact: true })
    await exactEvidence(value.queries[0].assessments[0], cell, advancedQuery)
    assert.equal(await page.locator('.measurement-engine-result').count(), 1)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const advancedMobileCell = page.locator('.measurement-result-engine').getByLabel('gemini sentiment', { exact: true })
  await advancedMobileCell.scrollIntoViewIfNeeded()
  assert(await advancedMobileCell.evaluate(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= node.ownerDocument.documentElement.clientWidth }), 'Advanced mobile verdict must fit its engine result')
  await screenshot('advanced-engine-mobile')
  await page.setViewportSize({ width: 1440, height: 1100 })
  mark('Advanced engine filtering preserves frozen Property/market/model/location/source identity and exact subject verdicts on desktop and mobile')
  const readContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, extraHTTPHeaders: { authorization: 'Bearer cnry_sentiment_synthetic_read' } })
  await restrict(readContext)
  assert.equal((await readContext.request.post(new URL('api/v1/session', base).href, { data: { apiKey: 'cnry_sentiment_synthetic_read' } })).status(), 200)
  const viewer = await readContext.newPage(); observe(viewer)
  await viewer.goto(new URL('projects/simple?queryClass=non-brand&measurementRunId=simple-run&measurementProvider=gemini', base).href, { waitUntil: 'networkidle' })
  await viewer.getByRole('combobox', { name: 'Answer engine', exact: true }).selectOption('gemini')
  await viewer.getByLabel('Non-brand favorable share', { exact: true }).getByText('0%', { exact: true }).waitFor()
  assert.equal(await viewer.getByRole('button', { name: 'Manage sentiment', exact: true }).count(), 0)
  assert.equal((await readContext.request.put(new URL('api/v1/projects/simple/sentiment/settings', base).href, { data: { enabled: false } })).status(), 403)
  await readContext.close()
  for (const project of ['simple', 'advanced']) assert.equal((await context.request.put(new URL(`api/v1/projects/${project}/sentiment/settings`, base).href, { data: { enabled: false } })).status(), 200)
  await page.goto(new URL('projects/simple?queryClass=non-brand&measurementRunId=simple-run', base).href, { waitUntil: 'networkidle' })
  assert.equal(await page.getByRole('columnheader', { name: 'Favorable', exact: true }).count(), 0)
  await page.getByRole('button', { name: simpleQuery, exact: true }).click()
  assert.equal(await page.locator('.query-evidence-engine-row').getByLabel('openai sentiment', { exact: true }).count(), 0)
  mark('Read-only users can inspect filtered stored verdicts but cannot configure; disabling hides row sentiment')
  assert.equal(report.httpErrors.length, 0); assert.equal(report.consoleErrors.length, 0); assert.equal(report.pageErrors.length, 0); assert.equal(report.externalRequests.length, 0)
  report.complete = true
} catch (error) { report.failure = error.stack ?? error.message; await screenshot('failure'); process.exitCode = 1 }
finally { await writeFile(`${output}/browser-report.json`, JSON.stringify(report, null, 2) + '\n'); await browser.close() }
console.log(JSON.stringify({ complete: report.complete, failure: report.failure ?? null, report: `${output}/browser-report.json` }))
