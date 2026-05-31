/**
 * Guest-report routes — the anonymous free-first-report flow that powers
 * the /aero onboarding experience.
 *
 *   POST   /api/v1/guest/report           — create a new guest report (no auth)
 *   GET    /api/v1/guest/report/:id        — read report state (no auth)
 *   GET    /api/v1/guest/report/:id/stream — SSE stream of live progress (no auth)
 *   POST   /api/v1/guest/report/:id/claim  — claim into the user's workspace (authed)
 *
 * The visitor drops a domain on the front page, we create a transient
 * `projects` row + a `guest_reports` row, and an in-process simulator
 * emits the audit + AI-visibility events that the SPA renders as Aero's
 * live work. The DB column `progress_events` doubles as an SSE replay
 * buffer so a flaky reconnect doesn't lose state.
 *
 * The simulator is intentionally self-contained (no worker dispatch) so
 * the /aero flow can be exercised end-to-end without spinning up the
 * full audit + sweep pipeline. Real audit hooks land in a follow-up that
 * replaces `runDemoSimulation` with a worker callback.
 */
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { eq, lt, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { guestReports, projects, users } from '@ainyc/canonry-db'
import { validationError, notFound, authRequired } from '@ainyc/canonry-contracts'

const REPORT_TTL_DAYS = 7

/**
 * Status state machine for guest reports.
 *
 *   pending → auditing → audit-complete → sweeping → completed
 *                     ↘ failed
 */
const STATUSES = {
  pending: 'pending',
  auditing: 'auditing',
  auditDone: 'audit-complete',
  sweeping: 'sweeping',
  completed: 'completed',
  failed: 'failed',
} as const

export interface GuestReportProgressEvent {
  at: string
  type:
    | 'sitemap-pulled'
    | 'page-audited'
    | 'audit-complete'
    | 'sweep-started'
    | 'provider-checked'
    | 'overall-complete'
    | 'failed'
  payload: Record<string, unknown>
}

/**
 * In-process pub/sub for SSE subscribers. Key: guest report id; value:
 * EventEmitter that emits `'event'` with each new progress event. Cleared
 * when no listeners remain to avoid leaking.
 */
const liveBus = new Map<string, EventEmitter>()

function getBus(id: string): EventEmitter {
  let bus = liveBus.get(id)
  if (!bus) {
    bus = new EventEmitter()
    bus.setMaxListeners(0) // arbitrary subscribers
    liveBus.set(id, bus)
  }
  return bus
}

function disposeBusIfEmpty(id: string): void {
  const bus = liveBus.get(id)
  if (bus && bus.listenerCount('event') === 0) {
    liveBus.delete(id)
  }
}

function shortId(): string {
  // 12-char URL-safe id, plenty for non-PII guest report identifiers.
  return crypto.randomBytes(9).toString('base64url')
}

/**
 * Normalize a user-entered domain to bare host. Accepts "https://www.acme.com/path",
 * "acme.com", "Acme.com" and returns "acme.com". Throws on garbage.
 */
export function normalizeDomain(raw: string): string {
  const trimmed = (raw ?? '').trim().toLowerCase()
  if (!trimmed) throw validationError('domain is required')
  // Use linear, non-backtracking string ops instead of regex on the
  // user-controlled value (CodeQL: polynomial-regex ReDoS on a string of
  // many '/'). Strip the scheme, then the path/query/fragment, then a
  // leading `www.`.
  let host = trimmed
  const schemeIdx = host.indexOf('://')
  if (schemeIdx !== -1) host = host.slice(schemeIdx + 3)
  host = host.split('/', 1)[0]! // drop everything from the first slash on — O(n), no backtracking
  if (host.startsWith('www.')) host = host.slice(4)
  // Single linear character-class strip (no quantifier ambiguity → ReDoS-safe).
  const stripped = host.replace(/[^a-z0-9.-]/g, '')
  if (!stripped.includes('.') || stripped.length < 4) {
    throw validationError('Enter a valid domain — e.g. acme.com')
  }
  return stripped
}

export interface GuestReportRoutesOptions {
  /** Optional override: drive the audit/sweep using real workers instead of
   *  the bundled simulator. Default (undefined) uses the simulator so the
   *  /aero flow is exercisable without the worker pipeline.
   *
   *  When set, the function should kick off async work that calls
   *  `appendProgressEvent` as findings arrive and finalize the row via the
   *  database directly. The simulator is the reference implementation. */
  driver?: (input: {
    db: FastifyInstance['db']
    guestReportId: string
    domain: string
    projectId: string
    onProgress: (event: GuestReportProgressEvent) => void
    onAuditComplete: (data: {
      auditScore: number
      pagesCrawled: number
      findingsCount: number
      topFindings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low'; title: string; url: string; pointsLost: number }>
    }) => void
    onComplete: (data: {
      overallScore: number
      citedCount: number
      mentionedCount: number
      queryCount: number
      topCompetitor: string | null
      topCompetitorCitedCount: number | null
      proposedPlan: Array<{ label: string; pointsImpact: number; rationale: string }>
    }) => void
    onFailed: (errorMessage: string) => void
  }) => void
}

/**
 * Default demo simulator. Emits a tight, narratively-strong sequence of
 * events that map to Aero's voice on the front-end. Tuned to feel like
 * an analyst reading the site and asking questions out loud.
 *
 * Total duration: ~22 seconds. Phase split:
 *   0-2s   sitemap pull
 *   2-10s  audit (page-by-page)
 *   10-11s audit reveal
 *   11-12s sweep handoff
 *   12-22s AI engines (one event per provider per query)
 *   22s    overall reveal
 *
 * Real workers will replace this; the timing here is what looks right in
 * the front-end. Don't shorten without re-validating the visual pacing.
 */
function runDemoSimulation(input: {
  guestReportId: string
  domain: string
  onProgress: (event: GuestReportProgressEvent) => void
  onAuditComplete: (data: Parameters<NonNullable<GuestReportRoutesOptions['driver']>>[0]['onAuditComplete'] extends (d: infer D) => void ? D : never) => void
  onComplete: (data: Parameters<NonNullable<GuestReportRoutesOptions['driver']>>[0]['onComplete'] extends (d: infer D) => void ? D : never) => void
}): void {
  const { domain } = input
  // Stable pseudo-random based on the domain so the same input gives the same
  // demo (helps with testing + screenshots).
  const seed = crypto.createHash('sha256').update(domain).digest()
  const randInt = (offset: number, min: number, max: number): number => {
    const byte = seed[offset % seed.length] ?? 0
    return min + (byte % (max - min + 1))
  }

  const pageCount = randInt(0, 12, 47)
  const auditScore = randInt(1, 32, 58)
  const overallScore = Math.max(20, auditScore - randInt(2, 8, 18))
  const queryCount = randInt(3, 12, 18)
  const citedCount = randInt(4, 1, Math.min(6, queryCount - 4))
  const mentionedCount = Math.max(citedCount, randInt(5, citedCount, Math.min(citedCount + 3, queryCount)))
  const topCompetitorCitedCount = randInt(6, queryCount - 4, queryCount - 1)

  const queries = [
    `${domain.split('.')[0]} reviews`,
    'best in town',
    'open weekends',
    'pricing',
    'how it works',
    'contact information',
    'service area',
  ].slice(0, queryCount)
  const competitors = ['competitor-a.com', 'competitor-b.com', 'rival-pro.com']
  const topCompetitor = competitors[seed[7]! % competitors.length]!

  let cancelled = false
  const cancel = () => { cancelled = true }

  const fire = (event: GuestReportProgressEvent) => {
    if (cancelled) return
    input.onProgress(event)
  }

  const at = (ms: number, fn: () => void) => {
    setTimeout(() => {
      if (!cancelled) fn()
    }, ms)
  }

  // Phase 1: sitemap pull
  at(700, () => fire({
    at: new Date().toISOString(),
    type: 'sitemap-pulled',
    payload: { pageCount, sitemapUrl: `https://${domain}/sitemap.xml` },
  }))

  // Phase 2: page-by-page audit — emit 5 representative pages
  const samplePages = [
    { path: '/', score: randInt(20, 60, 85) },
    { path: '/about', score: randInt(21, 50, 78) },
    { path: '/services', score: randInt(22, 35, 65) },
    { path: '/faq', score: randInt(23, 65, 92) },
    { path: '/contact', score: randInt(24, 55, 80) },
  ]
  samplePages.forEach((p, i) => {
    at(2500 + i * 1300, () => fire({
      at: new Date().toISOString(),
      type: 'page-audited',
      payload: { url: `https://${domain}${p.path}`, score: p.score, pageIndex: i + 1, total: samplePages.length },
    }))
  })

  // Phase 3: audit complete + reveal
  at(9500, () => {
    const topFindings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low'; title: string; url: string; pointsLost: number }> = [
      { severity: 'high', title: 'Missing FAQ schema on most pages', url: `https://${domain}`, pointsLost: 18 },
      { severity: 'high', title: 'Thin content on key service pages', url: `https://${domain}/services`, pointsLost: 12 },
      { severity: 'medium', title: 'No author or Person schema', url: `https://${domain}/about`, pointsLost: 8 },
      { severity: 'medium', title: 'Outdated dateModified fields', url: `https://${domain}/about`, pointsLost: 5 },
    ]
    fire({
      at: new Date().toISOString(),
      type: 'audit-complete',
      payload: { auditScore, pagesCrawled: pageCount, findingsCount: 12, topFindings },
    })
    input.onAuditComplete({
      auditScore,
      pagesCrawled: pageCount,
      findingsCount: 12,
      topFindings,
    })
  })

  // Phase 4: sweep handoff
  at(11000, () => fire({
    at: new Date().toISOString(),
    type: 'sweep-started',
    payload: { providerCount: 3, queryCount, providers: ['ChatGPT', 'Claude', 'Gemini'] },
  }))

  // Phase 5: AI engines, one event per provider per query (sampled to ~6 visible events)
  const sampleQueries = queries.slice(0, Math.min(4, queries.length))
  const providers: Array<'ChatGPT' | 'Claude' | 'Gemini'> = ['ChatGPT', 'Claude', 'Gemini']
  let sweepIdx = 0
  sampleQueries.forEach((q, qi) => {
    providers.forEach((prov, pi) => {
      const cited = (qi + pi) % 4 === 0
      const competitorCited = !cited
      at(12500 + sweepIdx * 700, () => fire({
        at: new Date().toISOString(),
        type: 'provider-checked',
        payload: {
          provider: prov,
          query: q,
          citedYou: cited,
          competitorCited: competitorCited ? topCompetitor : null,
        },
      }))
      sweepIdx += 1
    })
  })

  // Phase 6: overall complete + reveal
  const totalSweepMs = 12500 + sweepIdx * 700 + 1200
  at(totalSweepMs, () => {
    const proposedPlan: Array<{ label: string; pointsImpact: number; rationale: string }> = [
      { label: '5 focused FAQ pages targeting your top under-cited queries', pointsImpact: 8, rationale: 'AI engines weight Q&A structure heavily.' },
      { label: 'Author + Person schema across your team pages', pointsImpact: 5, rationale: 'AI prefers cited sources with named experts.' },
      { label: 'Expand 12 thin service pages with depth matching competitors', pointsImpact: 6, rationale: 'Your service pages average half the depth of the top citer.' },
      { label: 'Cross-link your existing FAQ + service pages', pointsImpact: 3, rationale: 'Helps AI understand the topical authority of your site.' },
    ]
    fire({
      at: new Date().toISOString(),
      type: 'overall-complete',
      payload: {
        overallScore,
        citedCount,
        mentionedCount,
        queryCount,
        topCompetitor,
        topCompetitorCitedCount,
        proposedPlan,
      },
    })
    input.onComplete({
      overallScore,
      citedCount,
      mentionedCount,
      queryCount,
      topCompetitor,
      topCompetitorCitedCount,
      proposedPlan,
    })
  })

  // Cleanup hook — caller can ignore, this is here for hot-path testing.
  void cancel
}

/**
 * Append an event to the report's progress buffer (durable for SSE replay)
 * and broadcast to any live subscribers.
 *
 * Failures to write the DB column are non-fatal — we still emit the live
 * event so connected clients see it; the SSE buffer just won't have it on
 * reconnect.
 */
function appendProgress(
  db: FastifyInstance['db'],
  guestReportId: string,
  event: GuestReportProgressEvent,
): void {
  try {
    const row = db.select().from(guestReports).where(eq(guestReports.id, guestReportId)).get()
    if (row) {
      const next = [...(row.progressEvents ?? []), event]
      db.update(guestReports).set({ progressEvents: next }).where(eq(guestReports.id, guestReportId)).run()
    }
  } catch {
    // swallow — live event still fires below
  }
  getBus(guestReportId).emit('event', event)
}

/** Map a guest report row to the SDK shape the SPA consumes. */
function serializeGuestReport(row: typeof guestReports.$inferSelect): {
  id: string
  domain: string
  projectId: string
  status: string
  auditScore: number | null
  auditPagesCrawled: number
  auditFindingsCount: number
  auditTopFindings: Array<{ severity: string; title: string; url: string; pointsLost: number }>
  overallScore: number | null
  aiCitedCount: number | null
  aiQueryCount: number | null
  aiMentionedCount: number | null
  topCompetitor: string | null
  topCompetitorCitedCount: number | null
  proposedPlan: Array<{ label: string; pointsImpact: number; rationale: string }>
  progressEvents: GuestReportProgressEvent[]
  errorMessage: string | null
  createdAt: string
  expiresAt: string
  claimedAt: string | null
} {
  return {
    id: row.id,
    domain: row.domain,
    projectId: row.projectId,
    status: row.status,
    auditScore: row.auditScore,
    auditPagesCrawled: row.auditPagesCrawled,
    auditFindingsCount: row.auditFindingsCount,
    auditTopFindings: row.auditTopFindings,
    overallScore: row.overallScore,
    aiCitedCount: row.aiCitedCount,
    aiQueryCount: row.aiQueryCount,
    aiMentionedCount: row.aiMentionedCount,
    topCompetitor: row.topCompetitor,
    topCompetitorCitedCount: row.topCompetitorCitedCount,
    proposedPlan: row.proposedPlan,
    progressEvents: row.progressEvents as GuestReportProgressEvent[],
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
  }
}

export async function guestReportRoutes(app: FastifyInstance, opts: GuestReportRoutesOptions = {}) {
  // Abuse guard for the anonymous /guest/report surface. `@fastify/rate-limit`
  // is scoped to this encapsulated plugin (only guest routes live here), so it
  // never touches the rest of the API. The 60/min default is generous for the
  // SPA's status polling + SSE; `create` (spins up a project + audit) and
  // `claim` (performs authorization) tighten via per-route config.
  await app.register(rateLimit, { global: true, max: 60, timeWindow: '1 minute' })

  /** Sweep expired unclaimed rows on startup. Cheap — bounded to a few hundred
   *  per deployment in practice. We also clear the transient guest project so
   *  the projects list stays clean. */
  try {
    const nowIso = new Date().toISOString()
    const stale = app.db
      .select()
      .from(guestReports)
      .where(lt(guestReports.expiresAt, nowIso))
      .all()
    const unclaimedProjectIds = stale.filter((r) => !r.claimedAt).map((r) => r.projectId)
    if (stale.length > 0) {
      app.db.delete(guestReports).where(lt(guestReports.expiresAt, nowIso)).run()
    }
    for (const pid of unclaimedProjectIds) {
      try {
        app.db.delete(projects).where(eq(projects.id, pid)).run()
      } catch {
        // project may have been claimed + renamed; ignore
      }
    }
  } catch (err) {
    app.log.warn({ err }, 'guest-report: startup cleanup failed')
  }

  // POST /api/v1/guest/report — start a new guest report.
  // Anonymous — no auth required.
  app.post<{ Body: { domain?: string } }>('/guest/report', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const domain = normalizeDomain(request.body?.domain ?? '')
    const id = shortId()
    const projectId = crypto.randomUUID()
    const projectName = `guest-${id}`
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + REPORT_TTL_DAYS * 86_400_000).toISOString()

    // One transaction: create the transient project + the guest report row.
    // The project is named `guest-<id>` and tagged with `configSource='guest'`
    // so it's visually distinguishable in DB inspections and can be reaped by
    // the startup cleanup if the row expires without a claim.
    app.db.transaction((tx) => {
      tx.insert(projects).values({
        id: projectId,
        name: projectName,
        displayName: domain,
        canonicalDomain: domain,
        country: 'US',
        language: 'en',
        configSource: 'guest',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()
      tx.insert(guestReports).values({
        id,
        domain,
        projectId,
        status: STATUSES.auditing,
        createdAt: now,
        expiresAt,
      }).run()
    })

    // Kick off the audit/sweep simulator (or the real driver if injected).
    // setImmediate so the POST response returns before any progress event
    // fires; the client connects to /stream and replays from the DB buffer
    // for anything that landed before the SSE subscription started.
    setImmediate(() => {
      try {
        const onProgress = (event: GuestReportProgressEvent) => appendProgress(app.db, id, event)
        const onAuditComplete = (data: {
          auditScore: number
          pagesCrawled: number
          findingsCount: number
          topFindings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low'; title: string; url: string; pointsLost: number }>
        }) => {
          app.db.update(guestReports).set({
            status: STATUSES.sweeping,
            auditScore: data.auditScore,
            auditPagesCrawled: data.pagesCrawled,
            auditFindingsCount: data.findingsCount,
            auditTopFindings: data.topFindings,
          }).where(eq(guestReports.id, id)).run()
        }
        const onComplete = (data: {
          overallScore: number
          citedCount: number
          mentionedCount: number
          queryCount: number
          topCompetitor: string | null
          topCompetitorCitedCount: number | null
          proposedPlan: Array<{ label: string; pointsImpact: number; rationale: string }>
        }) => {
          app.db.update(guestReports).set({
            status: STATUSES.completed,
            overallScore: data.overallScore,
            aiCitedCount: data.citedCount,
            aiMentionedCount: data.mentionedCount,
            aiQueryCount: data.queryCount,
            topCompetitor: data.topCompetitor,
            topCompetitorCitedCount: data.topCompetitorCitedCount,
            proposedPlan: data.proposedPlan,
          }).where(eq(guestReports.id, id)).run()
        }
        const onFailed = (message: string) => {
          app.db.update(guestReports).set({
            status: STATUSES.failed,
            errorMessage: message,
          }).where(eq(guestReports.id, id)).run()
          appendProgress(app.db, id, {
            at: new Date().toISOString(),
            type: 'failed',
            payload: { message },
          })
        }

        if (opts.driver) {
          opts.driver({
            db: app.db,
            guestReportId: id,
            domain,
            projectId,
            onProgress,
            onAuditComplete,
            onComplete,
            onFailed,
          })
        } else {
          runDemoSimulation({
            guestReportId: id,
            domain,
            onProgress,
            onAuditComplete,
            onComplete,
          })
        }
      } catch (err) {
        app.log.error({ err, guestReportId: id }, 'guest-report: driver crashed')
        try {
          app.db.update(guestReports).set({
            status: STATUSES.failed,
            errorMessage: err instanceof Error ? err.message : String(err),
          }).where(eq(guestReports.id, id)).run()
        } catch {
          // last-ditch — DB unreachable
        }
      }
    })

    return reply.status(201).send({ id, domain, status: STATUSES.auditing, expiresAt })
  })

  // GET /api/v1/guest/report/:id — read full state (polling fallback).
  app.get<{ Params: { id: string } }>('/guest/report/:id', async (request) => {
    const row = app.db.select().from(guestReports).where(eq(guestReports.id, request.params.id)).get()
    if (!row) throw notFound('Guest report', request.params.id)
    return serializeGuestReport(row)
  })

  // GET /api/v1/guest/report/:id/stream — SSE live progress + replay.
  // Replays the durable progress_events buffer first so clients that
  // reconnect (or arrive late) don't miss any events that already landed.
  app.get<{ Params: { id: string } }>('/guest/report/:id/stream', async (request, reply) => {
    const row = app.db.select().from(guestReports).where(eq(guestReports.id, request.params.id)).get()
    if (!row) throw notFound('Guest report', request.params.id)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write('retry: 5000\n\n')

    const write = (event: { type: string; data: unknown }) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      } catch {
        // socket closed
      }
    }

    // Replay durable events first.
    for (const e of row.progressEvents as GuestReportProgressEvent[]) {
      write({ type: 'progress', data: e })
    }
    // Also send a `state` snapshot so the client has the latest computed
    // fields (audit score, etc.) without re-querying.
    write({ type: 'state', data: serializeGuestReport(row) })

    // If the report is already finished, close the stream after replay.
    if (row.status === STATUSES.completed || row.status === STATUSES.failed) {
      reply.raw.write('event: done\ndata: {}\n\n')
      reply.raw.end()
      return
    }

    // Subscribe to the live bus.
    const bus = getBus(request.params.id)
    const onEvent = (event: GuestReportProgressEvent) => {
      write({ type: 'progress', data: event })
      if (event.type === 'overall-complete' || event.type === 'failed') {
        // Send a fresh state snapshot + signal completion.
        const updated = app.db.select().from(guestReports).where(eq(guestReports.id, request.params.id)).get()
        if (updated) write({ type: 'state', data: serializeGuestReport(updated) })
        write({ type: 'done', data: {} })
      }
    }
    bus.on('event', onEvent)

    const close = () => {
      bus.off('event', onEvent)
      disposeBusIfEmpty(request.params.id)
      try {
        reply.raw.end()
      } catch {
        // already closed
      }
    }
    request.raw.on('close', close)
    request.raw.on('end', close)
  })

  // POST /api/v1/guest/report/:id/claim — claim into the user's workspace.
  // Requires auth (cookie or API key). After claim, the transient guest
  // project becomes a regular project — name stays as `guest-<id>` for now
  // (the SPA can offer rename later) but configSource flips to 'dashboard'.
  app.post<{ Params: { id: string } }>('/guest/report/:id/claim', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!request.apiKey) throw authRequired()
    const row = app.db.select().from(guestReports).where(eq(guestReports.id, request.params.id)).get()
    if (!row) throw notFound('Guest report', request.params.id)
    if (row.claimedAt) {
      // Already claimed — return the project info so the SPA can navigate.
      const project = app.db.select().from(projects).where(eq(projects.id, row.projectId)).get()
      return reply.send({
        alreadyClaimed: true,
        projectName: project?.name ?? null,
        projectId: row.projectId,
      })
    }
    const claimedAt = new Date().toISOString()
    // Look up the user this API key belongs to (created at signup time).
    const userRow = app.db.select().from(users).where(eq(users.apiKeyId, request.apiKey.id)).get()
    const userId = userRow?.id ?? null
    app.db.transaction((tx) => {
      tx.update(guestReports).set({
        claimedAt,
        claimedByUserId: userId,
      }).where(eq(guestReports.id, request.params.id)).run()
      tx.update(projects).set({
        configSource: 'dashboard',
        updatedAt: claimedAt,
      }).where(eq(projects.id, row.projectId)).run()
    })
    const project = app.db.select().from(projects).where(eq(projects.id, row.projectId)).get()
    return reply.send({
      claimed: true,
      projectName: project?.name ?? null,
      projectId: row.projectId,
    })
  })

  // `isNull` reserved for a future reaper that purges `claimed_at IS NULL`
  // rows older than the expiry; declared as `void` so the import survives
  // tree-shaking while the reaper is still TODO.
  void isNull
}
