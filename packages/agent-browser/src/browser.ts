// One isolated browser page per agent run, driven over the Chrome DevTools Protocol.
// It connects to a Chrome that is already running (the same kind of endpoint the
// cdp:chatgpt provider uses) or to one this module launched, and opens each run in its
// own browser context, so no cookies, storage or sign-ins carry between runs.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import CDP from 'chrome-remote-interface'
import { describeError, hostOf, jsonValueText } from '@canonry/canonry-contracts'
import { blockedPageHtml, decideFence, egressOrigin } from './fence.js'
import { MODIFIER_BITS, comboSignature, keyDefinition, normalizeKeyName } from './keys.js'

export interface ChromeEndpoint {
  host: string
  port: number
}

export interface ChromeHandle {
  endpoint: ChromeEndpoint
  /** True when this module started the Chrome process and must stop it. */
  launched: boolean
  close(): Promise<void>
}

export interface Viewport {
  width: number
  height: number
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 }

export interface CapturedWrite {
  url: string
  method: string
  body: string | null
  answeredLocally: boolean
  at: number
}

/**
 * The host's outbound address policy: null when the browser may dial this origin
 * (`scheme://host[:port]`), otherwise why not. Asked once per origin per session.
 */
export type EgressCheck = (origin: string) => Promise<string | null>

export interface ActionLogEntry {
  at: number
  action: Record<string, unknown>
}

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/**
 * A Chrome or Chromium binary this host can launch: `CANONRY_CHROME_PATH`, then the usual
 * install locations, then a browser Playwright downloaded. Null when none exists.
 */
export async function findChromeExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.CANONRY_CHROME_PATH?.trim()
  if (explicit) return existsSync(explicit) ? explicit : null
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
  const caches = [path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')]
  for (const cache of caches) {
    let entries: string[]
    try {
      entries = await readdir(cache)
    } catch {
      continue
    }
    const builds = entries.filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()
    for (const build of builds) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = path.join(cache, build, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Starts a headless Chrome with remote debugging on a free port and a throwaway profile. */
export async function launchChrome(executablePath: string, viewport: Viewport = DEFAULT_VIEWPORT): Promise<ChromeHandle> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'canonry-agent-browser-'))
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    `--window-size=${viewport.width},${viewport.height}`,
  ]
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  const child: ChildProcess = spawn(executablePath, [...args, 'about:blank'], { stdio: 'ignore' })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  let port: number | null = null
  while (Date.now() < deadline && !exited) {
    try {
      const [first] = (await readFile(portFile, 'utf8')).split('\n')
      const parsed = Number(first)
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed
        break
      }
    } catch {
      // The file appears once Chrome is listening.
    }
    await sleep(100)
  }
  const stop = async () => {
    if (!exited) child.kill('SIGKILL')
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  if (port === null) {
    await stop()
    throw new Error(`Chrome at ${executablePath} did not start a debugging port within 20 seconds`)
  }
  return { endpoint: { host: '127.0.0.1', port }, launched: true, close: stop }
}

/** A handle for a Chrome someone else runs; closing it leaves that Chrome alone. */
export function connectedChrome(endpoint: ChromeEndpoint): ChromeHandle {
  return { endpoint, launched: false, close: async () => undefined }
}

interface FindState {
  query: string
}

/**
 * One isolated page. Everything an agent does goes through here, so the fence, the action
 * log and the screenshots apply to every agent the same way.
 */
export class BrowserSession {
  readonly writes: CapturedWrite[] = []
  readonly blockedPages: string[] = []
  readonly visited: string[] = []
  readonly log: ActionLogEntry[] = []
  mouse = { x: 0, y: 0 }
  screenshots = 0
  private find: FindState | null = null
  private mainFrameId = ''
  private readonly egressVerdicts = new Map<string, Promise<string | null>>()

  private constructor(
    private readonly browser: CDP.Client,
    readonly page: CDP.Client,
    private readonly browserContextId: string,
    private readonly targetId: string,
    readonly viewport: Viewport,
    private readonly siteHosts: string[],
    private readonly outDir: string | null,
    private readonly egress: EgressCheck,
  ) {
    this.mouse = { x: viewport.width / 2, y: viewport.height / 2 }
  }

  static async open(opts: {
    endpoint: ChromeEndpoint
    siteHosts: string[]
    /** Every request the fence lets through must pass this before it leaves the browser. */
    egress: EgressCheck
    viewport?: Viewport
    outDir?: string | null
  }): Promise<BrowserSession> {
    const viewport = opts.viewport ?? DEFAULT_VIEWPORT
    const { host, port } = opts.endpoint
    const version = await CDP.Version({ host, port })
    const browser = await CDP({ host, port, target: version.webSocketDebuggerUrl })
    const { browserContextId } = await browser.Target.createBrowserContext({ disposeOnDetach: true })
    const { targetId } = await browser.Target.createTarget({ url: 'about:blank', browserContextId })
    const page = await CDP({ host, port, target: targetId })
    const session = new BrowserSession(browser, page, browserContextId, targetId, viewport, [...new Set(opts.siteHosts.map((h) => hostOf(h)).filter((h): h is string => Boolean(h)))], opts.outDir ?? null, opts.egress)
    if (session.outDir) await mkdir(session.outDir, { recursive: true })
    await session.setUp()
    return session
  }

  private async setUp(): Promise<void> {
    const { page, browser } = this
    await Promise.all([page.Page.enable(), page.Runtime.enable(), page.DOM.enable(), page.Network.enable({})])
    await page.Emulation.setDeviceMetricsOverride({ width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false })
    await page.Network.setBypassServiceWorker({ bypass: true })
    const tree = await page.Page.getFrameTree()
    this.mainFrameId = tree.frameTree.frame.id
    page.on('Page.frameNavigated', (event) => {
      if (event.frame.parentId) return
      this.visited.push(event.frame.url)
      this.find = null
    })
    page.on('Fetch.requestPaused', (event) => {
      void this.onRequestPaused(event)
    })
    await page.Fetch.enable({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    // A link that opens a new tab opens in this page instead, so every agent keeps one view.
    await browser.Target.setDiscoverTargets({ discover: true })
    browser.on('Target.targetCreated', (event) => {
      const info = event.targetInfo
      if (info.openerId !== this.targetId || info.targetId === this.targetId) return
      void this.foldPopup(info.targetId, info.url)
    })
  }

  private async foldPopup(targetId: string, firstUrl: string): Promise<void> {
    let url = firstUrl
    for (let i = 0; i < 20 && (!url || url === 'about:blank'); i += 1) {
      await sleep(250)
      const { targetInfos } = await this.browser.Target.getTargets().catch(() => ({ targetInfos: [] }))
      url = targetInfos.find((t) => t.targetId === targetId)?.url ?? url
    }
    await this.browser.Target.closeTarget({ targetId }).catch(() => undefined)
    this.log.push({ at: Date.now(), action: { event: 'new-tab-folded', url } })
    if (/^https?:/.test(url)) await this.navigate(url).catch(() => undefined)
  }

  /** Why the egress policy refuses this URL's origin, or null; refused when the check itself fails. */
  private egressRefusal(url: string): Promise<string | null> {
    const origin = egressOrigin(url)
    if (origin === null) return Promise.resolve(null)
    let verdict = this.egressVerdicts.get(origin)
    if (!verdict) {
      verdict = this.egress(origin).catch((err: unknown) => `the address check failed: ${describeError(err)}`)
      this.egressVerdicts.set(origin, verdict)
    }
    return verdict
  }

  private async onRequestPaused(event: { requestId: string; request: { url: string; method: string; postData?: string; postDataEntries?: Array<{ bytes?: string }>; headers: Record<string, string> }; resourceType: string; frameId: string }): Promise<void> {
    const { requestId, request } = event
    const isMainFrameDocument = event.resourceType === 'Document' && event.frameId === this.mainFrameId
    const decision = decideFence({ url: request.url, method: request.method, isMainFrameDocument }, this.siteHosts)
    const body = request.postData ?? (request.postDataEntries?.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : '')).join('') || null)
    try {
      switch (decision.action) {
        case 'continue': {
          // Only requests that will really be dialed reach this check; answered writes, drops
          // and block pages never leave the browser.
          const refusal = await this.egressRefusal(request.url)
          if (refusal === null) {
            await this.page.Fetch.continueRequest({ requestId })
            return
          }
          this.log.push({ at: Date.now(), action: { event: 'egress-refused', url: request.url, reason: refusal } })
          if (!isMainFrameDocument) {
            await this.page.Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' })
            return
          }
          this.blockedPages.push(request.url)
          await this.page.Fetch.fulfillRequest({
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(blockedPageHtml(request.url, 'This check opens only public web addresses.')).toString('base64'),
          })
          return
        }
        case 'answer-write': {
          this.writes.push({ url: request.url, method: request.method, body, answeredLocally: true, at: Date.now() })
          const origin = request.headers.Origin ?? request.headers.origin
          const headers = [{ name: 'Content-Type', value: 'application/json' }]
          if (origin) headers.push({ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' })
          await this.page.Fetch.fulfillRequest({ requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from('{"ok":true}').toString('base64') })
          return
        }
        case 'drop':
          if (decision.reason === 'offsite-write') this.writes.push({ url: request.url, method: request.method, body, answeredLocally: false, at: Date.now() })
          await this.page.Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' })
          return
        case 'block-page':
          this.blockedPages.push(request.url)
          await this.page.Fetch.fulfillRequest({
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(blockedPageHtml(request.url)).toString('base64'),
          })
          return
      }
    } catch {
      // The request can be gone by the time it is answered (the page navigated away).
    }
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined)
    await this.browser.Target.closeTarget({ targetId: this.targetId }).catch(() => undefined)
    await this.browser.Target.disposeBrowserContext({ browserContextId: this.browserContextId }).catch(() => undefined)
    await this.browser.close().catch(() => undefined)
  }

  async url(): Promise<string> {
    const { result } = await this.page.Runtime.evaluate({ expression: 'location.href', returnByValue: true })
    return jsonValueText(result.value)
  }

  async title(): Promise<string> {
    const { result } = await this.page.Runtime.evaluate({ expression: 'document.title', returnByValue: true })
    return jsonValueText(result.value)
  }

  async navigate(url: string): Promise<void> {
    const result = await this.page.Page.navigate({ url })
    if (result.errorText && result.errorText !== 'net::ERR_ABORTED') throw new Error(`Could not open ${url}: ${result.errorText}`)
    await this.waitForLoad(30_000)
    await sleep(500)
  }

  private async readyState(): Promise<string> {
    try {
      const { result } = await this.page.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true })
      return jsonValueText(result.value)
    } catch {
      return 'loading'
    }
  }

  private async waitForLoad(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.readyState()
      if (state === 'complete' || state === 'interactive') return
      await sleep(100)
    }
  }

  /** Lets the page react to an action: a navigation, a re-render, an animation start. */
  async settle(ms = 400): Promise<void> {
    await sleep(ms)
    await this.waitForLoad(10_000)
    await sleep(150)
  }

  wait(ms: number): Promise<void> {
    return sleep(ms)
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.page.Page.captureScreenshot({ format: 'jpeg', quality: 85 })
    const buf = Buffer.from(data, 'base64')
    this.screenshots += 1
    if (this.outDir) await writeFile(path.join(this.outDir, `shot-${String(this.screenshots).padStart(3, '0')}.jpg`), buf)
    return buf
  }

  async zoom(region: [number, number, number, number]): Promise<Buffer> {
    const [x0, y0, x1, y1] = region
    const clip = { x: Math.max(0, x0), y: Math.max(0, y0), width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), scale: 1 }
    const { data } = await this.page.Page.captureScreenshot({ format: 'jpeg', quality: 90, clip })
    return Buffer.from(data, 'base64')
  }

  record(action: Record<string, unknown>): void {
    this.log.push({ at: Date.now(), action })
  }

  // ---------- mouse ----------

  private modifierMask(modifiers: string[]): number {
    return modifiers.map(normalizeKeyName).reduce((mask, key) => mask | (MODIFIER_BITS[key] ?? 0), 0)
  }

  async click(x: number, y: number, opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: string[] } = {}): Promise<void> {
    if (this.find) await this.closeFind()
    const button = opts.button ?? 'left'
    const count = opts.clickCount ?? 1
    const modifiers = this.modifierMask(opts.modifiers ?? [])
    this.mouse = { x, y }
    await this.holdModifiers(opts.modifiers ?? [], async () => {
      await this.page.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, modifiers })
      for (let i = 1; i <= count; i += 1) {
        await this.page.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button, buttons: 1, clickCount: i, modifiers })
        await this.page.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers })
      }
    })
    await this.settle()
  }

  async move(x: number, y: number): Promise<void> {
    this.mouse = { x, y }
    await this.page.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
    await sleep(250)
  }

  async mouseDown(): Promise<void> {
    await this.page.Input.dispatchMouseEvent({ type: 'mousePressed', x: this.mouse.x, y: this.mouse.y, button: 'left', buttons: 1, clickCount: 1 })
  }

  async mouseUp(): Promise<void> {
    await this.page.Input.dispatchMouseEvent({ type: 'mouseReleased', x: this.mouse.x, y: this.mouse.y, button: 'left', buttons: 0, clickCount: 1 })
    await this.settle()
  }

  async scroll(x: number | null, y: number | null, deltaX: number, deltaY: number, modifiers: string[] = []): Promise<void> {
    const at = x !== null && y !== null ? { x, y } : this.mouse
    this.mouse = at
    await this.page.Input.dispatchMouseEvent({ type: 'mouseMoved', x: at.x, y: at.y })
    await this.page.Input.dispatchMouseEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY, modifiers: this.modifierMask(modifiers) })
    await sleep(500)
  }

  async drag(points: Array<{ x: number; y: number }>): Promise<void> {
    const [first, ...rest] = points
    if (!first) return
    await this.page.Input.dispatchMouseEvent({ type: 'mouseMoved', x: first.x, y: first.y })
    await this.page.Input.dispatchMouseEvent({ type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1 })
    for (const p of rest) await this.page.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 })
    const last = rest.at(-1) ?? first
    await this.page.Input.dispatchMouseEvent({ type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 })
    this.mouse = last
    await this.settle()
  }

  // ---------- keyboard ----------

  private async keyEvent(type: 'keyDown' | 'rawKeyDown' | 'keyUp', name: string, modifiers: number): Promise<boolean> {
    const def = keyDefinition(name)
    if (!def) return false
    const typesText = def.text !== undefined && (modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Alt | MODIFIER_BITS.Meta)) === 0
    await this.page.Input.dispatchKeyEvent({
      type: type === 'keyUp' ? 'keyUp' : typesText ? 'keyDown' : 'rawKeyDown',
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      ...(type !== 'keyUp' && typesText ? { text: def.text, unmodifiedText: def.text } : {}),
      ...(def.location ? { location: def.location } : {}),
    })
    return true
  }

  private async holdModifiers(modifiers: string[], fn: () => Promise<void>): Promise<void> {
    const held = modifiers.map(normalizeKeyName).filter((k) => k in MODIFIER_BITS)
    let mask = 0
    for (const key of held) {
      mask |= MODIFIER_BITS[key]
      await this.keyEvent('rawKeyDown', key, mask)
    }
    try {
      await fn()
    } finally {
      for (const key of [...held].reverse()) {
        mask &= ~MODIFIER_BITS[key]
        await this.keyEvent('keyUp', key, mask)
      }
    }
  }

  /** Types text into whatever has focus, one key at a time like a person. */
  async typeText(text: string): Promise<void> {
    if (this.find) {
      this.find.query += text
      await this.runFind(true)
      return
    }
    for (const char of String(text)) {
      const def = keyDefinition(char)
      if (def?.text !== undefined && char !== '\n') {
        await this.keyEvent('keyDown', char, 0)
        await this.keyEvent('keyUp', char, 0)
      } else if (char === '\n') {
        await this.keyEvent('keyDown', 'Enter', 0)
        await this.keyEvent('keyUp', 'Enter', 0)
      } else {
        await this.page.Input.insertText({ text: char })
      }
      await sleep(8)
    }
    await this.settle(200)
  }

  /**
   * Presses keys together, e.g. ["ctrl", "a"]. Shortcuts that belong to the browser's own
   * interface (back, forward, reload, find, the address bar) are handled here, because this
   * browser shows only the page.
   */
  async pressKeys(keys: string[], repeat = 1): Promise<string> {
    if (!keys.length) return 'No key given.'
    const sig = comboSignature(keys)
    if (['control+l', 'meta+l', 'alt+d', 'f6'].includes(sig)) return 'This browser has no address bar.'
    if (sig === 'control+f' || sig === 'meta+f') {
      this.find = { query: '' }
      await this.runFind(true)
      return 'OK'
    }
    if (this.find) {
      if (sig === 'escape') {
        await this.closeFind()
        return 'OK'
      }
      if (sig === 'enter' || sig === 'shift+enter') {
        for (let i = 0; i < repeat; i += 1) await this.runFind(false, sig === 'shift+enter')
        return 'OK'
      }
      if (sig === 'backspace') {
        this.find.query = this.find.query.slice(0, -Math.max(1, repeat))
        await this.runFind(true)
        return 'OK'
      }
      if (sig === 'control+a' || sig === 'meta+a') return 'OK'
      await this.closeFind()
    }
    for (let i = 0; i < repeat; i += 1) {
      if (sig === 'alt+arrowleft' || sig === 'meta+[' || sig === 'browserback') await this.goBack()
      else if (sig === 'alt+arrowright' || sig === 'meta+]') await this.goForward()
      else if (sig === 'f5' || sig === 'control+r' || sig === 'meta+r') {
        await this.page.Page.reload({}).catch(() => undefined)
        await this.waitForLoad(30_000)
      } else {
        const names = keys.map(normalizeKeyName)
        const main = names.at(-1) ?? ''
        const modifiers = names.slice(0, -1)
        const mainKey = modifiers.length && main.length === 1 ? main.toLowerCase() : main
        await this.holdModifiers(modifiers, async () => {
          const mask = this.modifierMask(modifiers)
          const known = await this.keyEvent('keyDown', mainKey, mask)
          if (!known) throw new Error(`Unknown key: ${main}`)
          await this.keyEvent('keyUp', mainKey, mask)
        })
      }
    }
    await this.settle(250)
    return 'OK'
  }

  async keyDown(name: string): Promise<void> {
    await this.keyEvent('keyDown', normalizeKeyName(name), this.modifierMask([name]))
  }

  async keyUp(name: string): Promise<void> {
    await this.keyEvent('keyUp', normalizeKeyName(name), 0)
  }

  // ---------- history ----------

  private async history(step: -1 | 1): Promise<void> {
    const { currentIndex, entries } = await this.page.Page.getNavigationHistory()
    const entry = entries[currentIndex + step]
    if (!entry) return
    await this.page.Page.navigateToHistoryEntry({ entryId: entry.id })
    await this.settle()
  }

  goBack(): Promise<void> {
    return this.history(-1)
  }

  goForward(): Promise<void> {
    return this.history(1)
  }

  // ---------- find in page ----------

  /**
   * A stand-in for the browser's find bar (Ctrl+F), which a page-only browser does not have.
   * It selects and scrolls to the match and draws a small bar with the query and match count.
   */
  private async runFind(fromTop: boolean, backwards = false): Promise<void> {
    const query = this.find?.query ?? ''
    const script = `(${findInPage.toString()})(${JSON.stringify(query)}, ${fromTop}, ${backwards})`
    await this.page.Runtime.evaluate({ expression: script, returnByValue: true }).catch(() => undefined)
    await sleep(250)
  }

  private async closeFind(): Promise<void> {
    this.find = null
    await this.page.Runtime.evaluate({ expression: 'document.getElementById("__canonry_find")?.remove()' }).catch(() => undefined)
  }

  /** Runs a function in the page with JSON arguments and returns its JSON result. */
  async evaluate<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`
    const { result, exceptionDetails } = await this.page.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value as T
  }
}

// Runs inside the page; it must not reference anything outside its own body.
function findInPage(query: string, fromTop: boolean, backwards: boolean): { found: boolean; total: number } {
  const selection = window.getSelection()
  if (fromTop && selection) {
    selection.removeAllRanges()
    const start = document.createRange()
    start.setStart(document.body, 0)
    start.collapse(true)
    selection.addRange(start)
  }
  // `window.find` is non-standard but supported by Chromium.
  const finder = (window as unknown as { find?: (...args: unknown[]) => boolean }).find
  const found = query && finder ? finder.call(window, query, false, backwards, true, false, false, false) : false
  let total = 0
  if (query) {
    const text = document.body.innerText.toLowerCase()
    const needle = query.toLowerCase()
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) total += 1
  }
  let bar = document.getElementById('__canonry_find')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = '__canonry_find'
    bar.setAttribute('aria-hidden', 'true')
    bar.style.cssText =
      'position:fixed;top:8px;right:16px;z-index:2147483647;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,.25);padding:8px 12px;font:13px system-ui,sans-serif;pointer-events:none;min-width:260px;display:flex;justify-content:space-between;gap:16px'
    document.documentElement.appendChild(bar)
  }
  bar.replaceChildren()
  const left = document.createElement('span')
  left.textContent = query || 'Find in page'
  const right = document.createElement('span')
  right.style.color = '#5f6368'
  right.textContent = !query ? '' : total ? `${total} match${total === 1 ? '' : 'es'}` : 'No results'
  bar.append(left, right)
  return { found: Boolean(found), total }
}

export function describeBrowserError(err: unknown): string {
  return describeError(err)
}
