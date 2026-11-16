import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserSession, createEgressGate, findChromeExecutable, launchChrome, startEgressProxy } from '../src/index.js'
import type { ChromeHandle, EgressProxy } from '../src/index.js'

// A real Chrome behind the real proxy and fence, on fixtures that try every way out a page
// has: a popup, a cross-site iframe, a dedicated worker, a service worker, a beacon, WebSockets
// and requests to a refused address. Neither server may receive a single write or connection
// it should not. Skipped on a machine without Chrome (CANONRY_CHROME_PATH or an install).
const chromePath = await findChromeExecutable()
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!chromePath)('the check browser lets nothing out', () => {
  // site.test and frame.test do not resolve: only the proxy's vetted address reaches the site.
  const siteWrites: string[] = []
  const siteSockets: string[] = []
  const elsewhere: string[] = []
  let elsewhereConnections = 0
  let site: http.Server
  let refusedServer: http.Server
  let S = 0
  let R = 0
  let proxy: EgressProxy
  let chrome: ChromeHandle
  let session: BrowserSession

  const page = (body: string) => `<!doctype html><title>fixture</title><body>${body}</body>`
  const offsite = (from: string) => `fetch('http://127.0.0.1:${R}/collect?from=${from}',{method:'POST',body:'x',mode:'no-cors'}).catch(()=>{})`

  beforeAll(async () => {
    refusedServer = http.createServer((req, res) => {
      elsewhere.push(`${req.method} ${req.url}`)
      res.end('x')
    })
    refusedServer.on('connection', () => (elsewhereConnections += 1))
    refusedServer.on('upgrade', (req, socket: net.Socket) => {
      elsewhere.push(`WS ${req.url}`)
      socket.destroy()
    })
    site = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (req.method !== 'GET') siteWrites.push(`${req.method} ${url}`)
      const send = (type: string, body: string) => res.writeHead(200, { 'content-type': type }).end(body)
      if (url === '/popup') return send('text/html', page(`<a id="link" href="/popup-target" target="_blank" style="display:block;padding:40px">open</a>`))
      if (url === '/popup-target') return send('text/html', page(`popup<script>fetch('/collect?from=popup',{method:'POST',body:'p'});navigator.sendBeacon('/collect?from=beacon','b');${offsite('popup')}</script>`))
      if (url === '/frames') return send('text/html', page(`<script>window.frameSockets=[];addEventListener('message',(e)=>window.frameSockets.push(e.data))</script><iframe src="http://frame.test:${S}/frame"></iframe><iframe src="http://127.0.0.1:${R}/frame"></iframe>`))
      if (url === '/frame') return send('text/html', page(`<script>parent.postMessage(typeof WebSocket,'*');fetch('/collect?from=oopif',{method:'POST',body:'f'});fetch('http://site.test:${S}/collect?from=oopif-to-site',{method:'POST',body:'f',mode:'no-cors'});${offsite('oopif')}</script>`))
      if (url === '/worker') return send('text/html', page(`<script>new Worker('/worker.js').onmessage=(e)=>{window.workerSocket=e.data}</script>`))
      if (url === '/worker.js') return send('text/javascript', `postMessage(typeof WebSocket);fetch('/collect?from=worker',{method:'POST',body:'w'});${offsite('worker')}`)
      if (url === '/sw') return send('text/html', page(`<script>navigator.serviceWorker.register('/sw.js').then(()=>{},()=>{})</script>`))
      if (url === '/sw.js') return send('text/javascript', `self.addEventListener('install',()=>{fetch('/collect?from=sw',{method:'POST',body:'s'});${offsite('sw')}})`)
      if (url === '/ws') return send('text/html', page(`<script>window.socketErrors=[];for(const u of ['ws://site.test:${S}/socket','ws://127.0.0.1:${R}/socket']){try{const w=new WebSocket(u);w.onopen=()=>w.send('frame')}catch(e){window.socketErrors.push(e.name)}}</script>`))
      if (url.startsWith('/collect')) return send('text/plain', 'ok')
      return send('text/html', page('home'))
    })
    site.on('upgrade', (req, socket: net.Socket) => {
      siteSockets.push(req.url ?? '')
      socket.destroy()
    })
    const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    S = await listen(site)
    R = await listen(refusedServer)
    // The policy: the fixture names are public and live at 127.0.0.1; 127.0.0.1 itself is refused.
    // sw.localhost serves the service-worker page: workers need a secure context, which *.localhost is.
    const named = new Set(['site.test', 'frame.test', 'sw.localhost'])
    const gate = createEgressGate(async (host) => (named.has(host) ? { ok: true, address: '127.0.0.1' } : { ok: false, reason: 'which is loopback' }))
    proxy = await startEgressProxy(gate)
    chrome = await launchChrome(chromePath ?? '', undefined, { proxyServer: proxy.url })
    session = await BrowserSession.open({ endpoint: chrome.endpoint, siteHosts: ['site.test', 'sw.localhost'], gate })
  }, 60_000)

  afterAll(async () => {
    await session?.close().catch(() => undefined)
    await chrome?.close().catch(() => undefined)
    await proxy?.close().catch(() => undefined)
    site?.close()
    refusedServer?.close()
  })

  // Which of a fixture's writes the check answered (true) or dropped (false); arrival order varies.
  const writesFrom = (from: string) => session.writes.filter((w) => new URL(w.url).searchParams.get('from') === from).map((w) => w.answeredLocally).sort()

  it('folds a popup into the page, and the folded page is fenced like any other', async () => {
    await session.navigate(`http://site.test:${S}/popup`)
    const box = await session.evaluate<{ x: number; y: number }>(() => {
      const rect = (document.getElementById('link') as HTMLElement).getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await session.click(box.x, box.y)
    await settle(3_000)
    expect(session.log.some((entry) => entry.action.event === 'new-tab-folded')).toBe(true)
    expect(await session.url()).toBe(`http://site.test:${S}/popup-target`)
    expect(writesFrom('popup')).toEqual([false, true])
    expect(writesFrom('beacon')).toEqual([true])
  }, 30_000)

  it('fences a cross-site iframe and a dedicated worker, switches sockets off in both, and holds a service worker', async () => {
    await session.navigate(`http://site.test:${S}/frames`)
    await settle(2_500)
    // The iframe is another site (frame.test): its own write is dropped, its write to the site answered.
    expect(writesFrom('oopif')).toEqual([false, false])
    expect(writesFrom('oopif-to-site')).toEqual([true])
    expect(await session.evaluate<string[]>(() => (window as unknown as { frameSockets: string[] }).frameSockets)).toEqual(['undefined'])
    await session.navigate(`http://site.test:${S}/worker`)
    await settle(2_500)
    expect(writesFrom('worker')).toEqual([false, true])
    expect(await session.evaluate<string>(() => (window as unknown as { workerSocket: string }).workerSocket)).toBe('undefined')
    await session.navigate(`http://sw.localhost:${S}/sw`)
    await settle(2_500)
    expect(writesFrom('sw')).toEqual([])
    expect(session.log.some((entry) => entry.action.event === 'service-worker-held')).toBe(true)
  }, 40_000)

  it('switches WebSockets off in the page', async () => {
    await session.navigate(`http://site.test:${S}/ws`)
    await settle(1_500)
    expect(await session.evaluate<string[]>(() => (window as unknown as { socketErrors: string[] }).socketErrors)).toEqual(['TypeError', 'TypeError'])
    expect(siteSockets).toEqual([])
  }, 30_000)

  it('delivered no write to the site and nothing at all to the refused address', () => {
    expect(siteWrites).toEqual([])
    expect(elsewhere).toEqual([])
    expect(elsewhereConnections).toBe(0)
  })
})
