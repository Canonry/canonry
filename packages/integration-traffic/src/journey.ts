import type { JourneyEntry, JourneyEntrySignal, JourneyEventKind, NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { classifyJourneyEntry } from '@canonry/canonry-contracts'
import { classifyAiReferral, classifyAiUserFetch, classifyCrawler, isSelfTraffic } from './classifier.js'

/**
 * AI visitor journeys, pure core. The traffic pipeline hands every pulled or
 * pushed batch of normalized requests through here alongside the hourly
 * rollup: `extractJourneyRequests` keeps the browser requests worth following,
 * and `sessionizeJourneyRequests` groups one visitor's requests into visits and
 * decides which to keep (only visitors who arrived from an AI engine, from that
 * visit until 30 days after their latest AI visit). Storage and the keyed
 * visitor hash live with the caller.
 */

// Static files a page pulls in. JSON and API calls stay: in single-page apps
// they are the only trace of navigation, and form posts are what a visitor did.
const ASSET_EXTENSION_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|map|mjs|mp3|mp4|otf|png|svg|ttf|txt|webm|webmanifest|webp|woff2?|xml)$/i
const ASSET_PATH_PREFIXES = ['/_next/static/', '/_nuxt/', '/_ipx/', '/_vercel/', '/assets/', '/build/', '/dist/', '/fonts/', '/images/', '/img/', '/static/', '/wp-content/', '/wp-includes/', '/cdn-cgi/']
const DATA_PATH_PATTERN = /(?:\.json$|^\/api\/|^\/wp-json\/|^\/graphql)/i
// Automated clients the crawler rules do not name. A journey is a person in a browser.
const NON_BROWSER_PATTERN = /bot|crawl|spider|slurp|scrape|curl\/|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegram|discord|slack/i
// Query parameters kept on a stored path. Everything else can carry personal data.
const KEPT_QUERY_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
const CLICK_ID_PARAMETERS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id', 'twclid']
const MAX_PATH_LENGTH = 512

export interface JourneyRequest {
  eventId: string
  observedAt: string
  method: string | null
  /** Path plus kept utm parameters, at most 512 characters. */
  path: string
  status: number | null
  kind: JourneyEventKind
  remoteIp: string | null
  userAgent: string
  /** True when the referer is this site (a step within a visit, not an entry). */
  sameSiteReferer: boolean
  signal: JourneyEntrySignal
}

function baseHost(host: string | null | undefined): string | null {
  const h = host?.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  return h || null
}

function refererHostOf(referer: string | null): string | null {
  if (!referer) return null
  try {
    return new URL(referer).hostname || null
  } catch {
    return null
  }
}

function hostOfEvent(event: NormalizedTrafficRequest): string | null {
  if (event.host) return event.host
  if (!event.requestUrl) return null
  try {
    return new URL(event.requestUrl).hostname || null
  } catch {
    return null
  }
}

function isAssetPath(path: string): boolean {
  return ASSET_PATH_PREFIXES.some(prefix => path.startsWith(prefix)) || ASSET_EXTENSION_PATTERN.test(path)
}

/** Whether a user agent looks like a person's browser (crawler rules run separately). */
export function isLikelyBrowser(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim()
  return Boolean(ua) && /^Mozilla\//.test(ua!) && !NON_BROWSER_PATTERN.test(ua!)
}

/**
 * The browser requests from one batch that a journey can use: no Canonry
 * self-traffic, crawlers, AI user fetches, non-browser clients, static assets,
 * HEAD or OPTIONS, or unreadable timestamps. Times become UTC ISO strings.
 * Query strings are cut down to utm parameters; a click id is reduced to the
 * fact that one was present.
 */
export function extractJourneyRequests(events: readonly NormalizedTrafficRequest[]): JourneyRequest[] {
  const out: JourneyRequest[] = []
  for (const event of events) {
    const method = event.method?.toUpperCase() ?? null
    if (method === 'HEAD' || method === 'OPTIONS') continue
    // Providers report different precisions and offsets; one form keeps
    // time comparisons on these strings correct.
    const observedMs = Date.parse(event.observedAt)
    if (!Number.isFinite(observedMs)) continue
    const rawPath = event.path.split('?')[0] || '/'
    if (isAssetPath(rawPath)) continue
    if (!isLikelyBrowser(event.userAgent)) continue
    if (isSelfTraffic(event) || classifyCrawler(event) || classifyAiUserFetch(event)) continue

    const params = new URLSearchParams(event.queryString ?? '')
    const kept = KEPT_QUERY_PARAMETERS.flatMap(name => {
      const value = params.get(name)
      return value ? [`${name}=${encodeURIComponent(value)}`] : []
    })
    const path = (kept.length ? `${rawPath}?${kept.join('&')}` : rawPath).slice(0, MAX_PATH_LENGTH)
    const refererHost = refererHostOf(event.referer)
    const siteHost = baseHost(hostOfEvent(event))
    const sameSiteReferer = Boolean(refererHost && siteHost && baseHost(refererHost) === siteHost)
    const ai = classifyAiReferral(event)

    out.push({
      eventId: event.eventId,
      observedAt: new Date(observedMs).toISOString(),
      method,
      path,
      status: event.status,
      kind: DATA_PATH_PATTERN.test(rawPath) ? 'data' : 'page',
      remoteIp: event.remoteIp?.trim() || null,
      userAgent: event.userAgent!.trim(),
      sameSiteReferer,
      signal: {
        aiProduct: ai?.product ?? null,
        aiDomain: ai?.sourceDomain ?? null,
        aiPaid: ai?.trafficClass === 'paid',
        refererHost: sameSiteReferer ? null : refererHost,
        utmSource: params.get('utm_source'),
        utmMedium: params.get('utm_medium'),
        clickId: CLICK_ID_PARAMETERS.some(name => params.has(name)),
      },
    })
  }
  return out
}

/** A request carries entry evidence when it arrived from outside the site. */
export function hasEntryEvidence(request: JourneyRequest): boolean {
  if (request.sameSiteReferer) return false
  const s = request.signal
  return Boolean(s.aiProduct || s.refererHost || s.utmSource || s.utmMedium || s.clickId)
}

function entryKey(entry: JourneyEntry): string {
  return `${entry.entryClass}:${entry.entryName ?? entry.entryHost ?? ''}`
}

export interface StoredJourneyVisit {
  id: string
  startedAt: string
  endedAt: string
  entry: JourneyEntry
  requestCount: number
  pageCount: number
}

export interface JourneyVisitorState {
  firstAiAt: string | null
  firstAiEngine: string | null
  lastAiAt: string | null
  /** This visitor's stored visits near the batch window, any order. */
  visits: StoredJourneyVisit[]
}

export interface KeyedJourneyRequest extends JourneyRequest {
  visitorKey: string
}

export interface JourneyVisitWrite extends StoredJourneyVisit {
  visitorKey: string
  landingPath: string
  isNew: boolean
}

export interface JourneyEventWrite {
  visitId: string
  visitorKey: string
  request: KeyedJourneyRequest
}

export interface JourneyVisitorWrite {
  visitorKey: string
  firstAiAt: string
  firstAiEngine: string
  lastAiAt: string
  userAgent: string
  lastSeenAt: string
}

export interface SessionizeJourneyOptions {
  idleMs: number
  lookbackMs: number
  newId: () => string
}

export interface SessionizeJourneyResult {
  visits: JourneyVisitWrite[]
  events: JourneyEventWrite[]
  visitors: JourneyVisitorWrite[]
  /** Requests not kept: the visitor had no AI visit at or before them within the lookback. */
  dropped: number
}

const ms = (iso: string) => Date.parse(iso)

/**
 * The visit a request at `t` continues: one within the idle gap, from the same
 * outside source when the request arrived from outside. When visits overlap
 * that window, the latest one started at or before `t` wins (a click right
 * after a new arrival belongs to that arrival), else the earliest after it.
 */
function continuedVisit<V extends StoredJourneyVisit>(visits: readonly V[], t: number, outsideEntry: string | null, idleMs: number): V | undefined {
  let before: V | undefined
  let after: V | undefined
  for (const v of visits) {
    if (t < ms(v.startedAt) - idleMs || t > ms(v.endedAt) + idleMs) continue
    if (outsideEntry !== null && outsideEntry !== entryKey(v.entry)) continue
    if (ms(v.startedAt) <= t) {
      if (!before || v.startedAt > before.startedAt) before = v
    } else if (!after || v.startedAt < after.startedAt) {
      after = v
    }
  }
  return before ?? after
}
const laterOf = (a: string | null, b: string): string => (a !== null && a > b ? a : b)

/**
 * Group each visitor's requests into visits and keep the ones that belong to
 * an AI journey. A request continues the visit it falls within (idle gap under
 * `idleMs`) unless it arrives from a different outside source, which starts a
 * new visit, as analytics tools do. A request is kept when it is an AI
 * referral, or the visitor's first AI visit is at or before it and their
 * latest AI visit is within `lookbackMs` before it. Works for backfills that
 * arrive out of order: requests are matched against the visitor's stored
 * visits around them, and an earlier AI visit found later moves the journey
 * start back.
 */
export function sessionizeJourneyRequests(
  requests: readonly KeyedJourneyRequest[],
  state: ReadonlyMap<string, JourneyVisitorState>,
  options: SessionizeJourneyOptions,
): SessionizeJourneyResult {
  const byVisitor = new Map<string, KeyedJourneyRequest[]>()
  for (const request of requests) {
    const list = byVisitor.get(request.visitorKey)
    if (list) list.push(request)
    else byVisitor.set(request.visitorKey, [request])
  }

  const visits = new Map<string, JourneyVisitWrite>()
  const events: JourneyEventWrite[] = []
  const visitors: JourneyVisitorWrite[] = []
  let dropped = 0

  for (const [visitorKey, list] of byVisitor) {
    list.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    const prior = state.get(visitorKey)
    // AI visits in this batch can open the journey earlier than stored state says.
    const aiTimes = list.filter(r => r.signal.aiProduct).map(r => r.observedAt)
    const firstAiAt = [prior?.firstAiAt, aiTimes[0]].filter((t): t is string => Boolean(t)).sort()[0] ?? null
    if (!firstAiAt) {
      dropped += list.length
      continue
    }
    const known: JourneyVisitWrite[] = (prior?.visits ?? []).map(v => ({ ...v, visitorKey, landingPath: '', isNew: false }))
    let lastAiAt = prior?.lastAiAt ?? null
    let firstAiEngine = prior?.firstAiAt && prior.firstAiAt === firstAiAt ? prior.firstAiEngine : null
    let keptAny = false
    let lastSeenAt: string | null = null
    let userAgent = list[0].userAgent

    for (const request of list) {
      const isAi = Boolean(request.signal.aiProduct)
      if (isAi) {
        if (!lastAiAt || request.observedAt > lastAiAt) lastAiAt = request.observedAt
        if (request.observedAt === firstAiAt && !firstAiEngine) firstAiEngine = request.signal.aiProduct
      }
      const inJourney = isAi || (request.observedAt >= firstAiAt && lastAiAt !== null && ms(request.observedAt) - ms(lastAiAt) <= options.lookbackMs)
      if (!inJourney) {
        dropped += 1
        continue
      }
      const entry = classifyJourneyEntry(request.signal)
      const external = hasEntryEvidence(request)
      const t = ms(request.observedAt)
      const visit = continuedVisit(known, t, external ? entryKey(entry) : null, options.idleMs)
      let target: JourneyVisitWrite
      if (visit) {
        target = visit
        if (request.observedAt < target.startedAt) target.startedAt = request.observedAt
        if (request.observedAt > target.endedAt) target.endedAt = request.observedAt
        target.requestCount += 1
        if (request.kind === 'page') target.pageCount += 1
      } else {
        target = {
          id: options.newId(),
          visitorKey,
          startedAt: request.observedAt,
          endedAt: request.observedAt,
          entry,
          requestCount: 1,
          pageCount: request.kind === 'page' ? 1 : 0,
          landingPath: request.path,
          isNew: true,
        }
        known.push(target)
      }
      visits.set(target.id, target)
      events.push({ visitId: target.id, visitorKey, request })
      keptAny = true
      lastSeenAt = laterOf(lastSeenAt, request.observedAt)
      userAgent = request.userAgent
    }

    if (keptAny && lastAiAt) {
      visitors.push({
        visitorKey,
        firstAiAt,
        firstAiEngine: firstAiEngine ?? prior?.firstAiEngine ?? 'AI',
        lastAiAt,
        userAgent,
        lastSeenAt: lastSeenAt!,
      })
    }
  }

  return { visits: [...visits.values()], events, visitors, dropped }
}
