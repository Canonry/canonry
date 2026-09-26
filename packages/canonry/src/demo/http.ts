import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import { apiRoutes, type ApiRoutesOptions } from '@ainyc/canonry-api-routes'
import { percentOf, type AeroPreviewResponse } from '@ainyc/canonry-contracts'
import { apiKeys, bingKeywordStats, bingUrlInspections, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { PACKAGE_VERSION } from '../package-version.js'
import { isDemoApiReadAllowed } from './access.js'
import { DEFAULT_DEMO_TRUSTED_PROXIES } from './trust-proxy.js'

const DEMO_VIEWER = { id: 'public-demo-viewer', name: 'Public demo', scopes: ['read'], projectId: null }
const DEMO_CLIENT_CONFIG = {
  demo: { enabled: true, readOnly: true, sampleData: true },
  dashboard: { showAgentBar: false, showUpdateNotification: false },
}
// A script element written into the document itself rather than loaded by src.
const INLINE_SCRIPT = /<script(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi
// Known dashboard locations. Arbitrary files, API paths and machine endpoints
// never receive the document. The workspace backlink admin page is not part of
// the demo, so it is not served.
const DEMO_DOCUMENT_PATH = /^\/(?:projects(?:\/[^/.]+(?:\/(?:portfolio|discovery|search-console|activity|technical-aeo|conversions|local|queries|backlinks|report|history|settings|properties)(?:\/[^/.]+)*)?)?|runs|history|traffic(?:\/[^/.]+(?:\/[^/.]+)?)?)\/?$/
// Where a request whose path the router cannot decode is routed a second time.
// No route or dashboard location matches it, so it lands in the not-found handler.
const UNDECODABLE_PATH = '/.undecodable-path'
const DEMO_REPORT_DISCLOSURE = '<aside role="note" style="box-sizing:border-box;margin:0;padding:12px 24px;background:#fff7d6;border-bottom:1px solid #e5c75c;color:#4a3a00;font:600 14px/1.5 system-ui,sans-serif;text-align:center">Public Canonry demo: this report contains fictional sample data from stored demo records. No live provider query produced it.</aside>'

/**
 * Scripts may come from this origin, or be one of the inline scripts in the
 * prepared document, matched by hash. Style attributes stay allowed inline.
 */
function demoContentSecurityPolicy(document: string): string {
  const inlineHashes = [...document.matchAll(INLINE_SCRIPT)]
    .filter(match => !/\ssrc\s*=/i.test(match.groups?.attributes ?? ''))
    .map(match => `'sha256-${createHash('sha256').update(match.groups?.body ?? '', 'utf8').digest('base64')}'`)
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inlineHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

function isDemoDocumentRequest(request: FastifyRequest): boolean {
  return (request.method === 'GET' || request.method === 'HEAD')
    && DEMO_DOCUMENT_PATH.test(request.url.split('?')[0] ?? '')
}

/**
 * Only the fixed public files skip the per-visitor budget: built assets, icons,
 * health, robots and the dashboard document. Decide on the route the router
 * matched, never the raw URL. The router decodes percent-escapes, so
 * /%61pi/v1/projects reaches the /api/v1/projects handler. A request that
 * matched no route is charged too, so malformed or encoded paths cannot flood
 * the not-found handler. A path the router cannot decode at all is charged
 * under UNDECODABLE_PATH (see frameworkErrors below).
 */
function isOutsideDemoApiBudget(request: FastifyRequest): boolean {
  const route = request.routeOptions.url
  return route === undefined ? isDemoDocumentRequest(request) : !route.startsWith('/api/')
}

/** Internal HTTP shell. The public command always supplies a fresh synthetic database. */
export async function createDemoHttpServer(options: {
  db: DatabaseClient
  assetsDir: string
  now: Date
  /** Focused test seam; public demo servers use the default API budget. */
  apiRateLimitMax?: number
  /** Proxies whose X-Forwarded-For names the visitor. Defaults to loopback. */
  trustProxy?: readonly string[]
  /** Read-only synthetic stores, never callbacks that invoke providers. */
  readOptions?: Pick<ApiRoutesOptions, 'googleConnectionStore' | 'googleStateSecret' | 'googleMarketingCredentialStore' | 'bingConnectionStore' | 'ga4CredentialStore' | 'getBacklinksStatus' | 'listCachedReleases' | 'assessConversionTrackingIntegrity'>
  /** Scripted Aero turns per project name, built from the seeded rows. Never a live agent. */
  aeroPreviews?: ReadonlyMap<string, AeroPreviewResponse>
}) {
  const { db, assetsDir, now } = options
  const html = readFileSync(join(assetsDir, 'index.html'), 'utf8')
    .replace('<head>', '<head><base href="/">')
    .replace('</head>', `<script>window.__CANONRY_CONFIG__=${JSON.stringify(DEMO_CLIENT_CONFIG)}</script></head>`)
  const contentSecurityPolicy = demoContentSecurityPolicy(html)
  db.insert(apiKeys).values({
    ...DEMO_VIEWER,
    keyHash: randomUUID(),
    keyPrefix: 'demo',
    createdAt: now.toISOString(),
  }).run()
  // Raw requests whose path had an invalid percent-escape, such as /%C0.
  const undecodable = new WeakSet<object>()
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // The API budget is keyed by visitor address. Believe X-Forwarded-For only
    // from the named proxies (a same-machine proxy by default), so a directly
    // connected client cannot pick the address it is counted under.
    trustProxy: [...(options.trustProxy ?? DEFAULT_DEMO_TRUSTED_PROXIES)],
    // The router answers an undecodable path itself, before any hook, so the
    // request would skip the visitor's budget. Route it again under a fixed
    // path instead: the normal hooks then charge it to the forwarded visitor
    // address and add the usual headers before the not-found handler refuses it.
    frameworkErrors: (error, request, reply) => {
      if (error.code !== 'FST_ERR_BAD_URL') {
        const body = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
        reply.raw.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
        reply.raw.end(body)
        return
      }
      undecodable.add(request.raw)
      request.raw.url = UNDECODABLE_PATH
      app.routing(request.raw, reply.raw)
    },
  })
  await app.register(rateLimit, {
    // Not attached per route: route hooks never run for the not-found handler
    // and run after the refusals below. The single hook charges first instead.
    global: false,
    max: options.apiRateLimitMax ?? 600,
    timeWindow: '1 minute',
    // A dashboard load fans out across many immutable chunks. Those reads do
    // not touch the API budget, which stays available for stored-data calls.
    allowList: isOutsideDemoApiBudget,
  })
  const chargeApiBudget = app.rateLimit()
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Content-Security-Policy', contentSecurityPolicy)
    // Throws the 429 once the visitor's budget is spent.
    await chargeApiBudget.call(app, request, reply)
    const method = request.method
    if (method !== 'GET' && method !== 'HEAD') {
      return reply.code(403).send({ error: { code: 'DEMO_READ_ONLY', message: 'This public demo is view only. Changes and live runs are disabled.' } })
    }
    const route = request.routeOptions.url
    if (request.url.startsWith('/api/') || route?.startsWith('/api/')) {
      if (!isDemoApiReadAllowed(method, route)) {
        return reply.code(403).send({ error: { code: 'DEMO_READ_ONLY', message: 'This action is unavailable in the view-only demo.' } })
      }
      // No credentials are accepted or minted. Every visitor has the same
      // synthetic read principal, regardless of bearer or cookie headers.
      request.apiKey = { ...DEMO_VIEWER }
      request.principal = { kind: 'api-key', ...DEMO_VIEWER, viaCookie: false }
      reply.header('Cache-Control', 'no-store')
      // The ordinary Bing performance GET calls Bing live. In this demo the
      // same read contract is served exclusively from seeded stored rows.
      if (route === '/api/v1/projects/:name/bing/coverage') {
        const name = (request.params as { name: string }).name
        const project = db.select().from(projects).where(eq(projects.name, name)).get()
        if (!project) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found.' } })
        const rows = db.select().from(bingUrlInspections).where(eq(bingUrlInspections.projectId, project.id)).orderBy(desc(bingUrlInspections.inspectedAt)).all()
        const latest = new Map<string, typeof rows[number]>()
        for (const row of rows) if (!latest.has(row.url)) latest.set(row.url, row)
        const format = (row: typeof rows[number]) => ({ url: row.url, httpCode: row.httpCode, inIndex: row.inIndex, lastCrawledDate: row.lastCrawledDate, inIndexDate: row.inIndexDate, inspectedAt: row.inspectedAt, documentSize: row.documentSize, anchorCount: row.anchorCount, discoveryDate: row.discoveryDate })
        const indexed = [...latest.values()].filter(row => row.inIndex === true).map(format)
        const notIndexed = [...latest.values()].filter(row => row.inIndex === false).map(format)
        const unknown = [...latest.values()].filter(row => row.inIndex === null).map(format)
        const total = latest.size
        return reply.send({ summary: { total, indexed: indexed.length, notIndexed: notIndexed.length, unknown: unknown.length, percentage: percentOf(indexed.length, total) ?? 0 }, lastInspectedAt: rows[0]?.inspectedAt ?? null, indexed, notIndexed, unknown })
      }
      if (route === '/api/v1/projects/:name/bing/performance') {
        const name = (request.params as { name: string }).name
        const project = db.select().from(projects).where(eq(projects.name, name)).get()
        if (!project) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found.' } })
        return reply.send(db.select().from(bingKeywordStats).where(eq(bingKeywordStats.projectId, project.id)).limit(200).all().map(row => ({
          query: row.query, impressions: row.impressions, clicks: row.clicks,
          ctr: Number(row.ctr), averagePosition: Number(row.averagePosition),
        })))
      }

    }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.url !== '/api/v1/projects/:name/report.html'
      || typeof payload !== 'string'
      || !String(reply.getHeader('content-type')).startsWith('text/html')) {
      return payload
    }
    // Exported HTML can outlive the dashboard chrome, so keep the sample-data
    // disclosure inside the downloaded artifact itself.
    reply.removeHeader('content-length')
    return payload.replace(/<body([^>]*)>/i, `<body$1>${DEMO_REPORT_DISCLOSURE}`)
  })
  app.get('/health', async () => ({ status: 'ok', service: 'canonry-demo', version: PACKAGE_VERSION, demo: true, workerEnabled: false }))
  app.get('/api/v1/session', async () => ({ authenticated: true, setupRequired: false }))
  app.get('/api/v1/demo', async () => ({ mode: 'view-only', sampleData: true, seededAt: now.toISOString() }))
  // The Aero bar replays these scripted turns on the sample data. They were
  // written at startup from the seeded rows; no model or provider is called.
  const aeroPreviews = options.aeroPreviews ?? new Map<string, AeroPreviewResponse>()
  app.get('/api/v1/projects/:name/agent/preview', async (request, reply) => {
    const preview = aeroPreviews.get((request.params as { name: string }).name)
    if (!preview) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found.' } })
    return reply.send(preview)
  })
  // Deliberately register only the shared HTTP readers. The normal server,
  // config loader, provider registry, scheduler and MCP never start, and Aero
  // exists only as the scripted preview above: no agent session or model call.
  await app.register(apiRoutes, { db, skipAuth: true, ...options.readOptions })
  await app.register(fastifyStatic, {
    root: join(assetsDir, 'assets'),
    prefix: '/assets/',
    index: false,
    dotfiles: 'deny',
  })
  const sendDocument = (_request: unknown, reply: FastifyReply) => {
    return reply.header('Cache-Control', 'no-cache').type('text/html').send(html)
  }
  for (const [filename, contentType] of [['favicon.svg', 'image/svg+xml'], ['favicon-32.png', 'image/png'], ['apple-touch-icon.png', 'image/png']] as const) {
    const path = join(assetsDir, filename)
    if (existsSync(path)) {
      const icon = readFileSync(path)
      app.get(`/${filename}`, async (_request, reply) => reply.type(contentType).send(icon))
    }
  }
  app.get('/', sendDocument)
  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'))
  app.setNotFoundHandler(async (request, reply) => {
    if (undecodable.has(request.raw)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'The request path is not a valid URL.' } })
    }
    // Known SPA routes get the document; everything else must never receive a
    // misleading HTML success.
    if (isDemoDocumentRequest(request)) return sendDocument(request, reply)
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Page not found.' } })
  })
  return app
}
