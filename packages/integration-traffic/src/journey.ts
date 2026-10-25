import type { JourneyEntry, JourneyEntrySignal, JourneyEventKind, NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { classifyJourneyEntry } from '@canonry/canonry-contracts'
import { classifyAiReferral, classifyAiUserFetch, classifyCrawler, isSelfTraffic } from './classifier.js'

/**
 * AI visitor journeys, pure core. The traffic pipeline hands every pulled or
 * pushed batch of normalized requests through here alongside the hourly
 * rollup: `extractJourneyRequests` keeps the browser requests worth following,
 * and `sessionizeJourneyRequests` groups one visitor's requests into visits and
 * decides which to keep (only visitors who arrived from an AI engine, from that
 * visit and up to 30 days after each AI visit). Storage and the keyed
 * visitor hash live with the caller.
 */

// Static files a page pulls in. JSON and API calls stay: in single-page apps
// they are the only trace of navigation, and form posts are what a visitor did.
const ASSET_EXTENSION_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|map|mjs|mp3|mp4|otf|png|svg|ttf|txt|webm|webmanifest|webp|woff2?|xml)$/i
const ASSET_PATH_PREFIXES = ['/_next/static/', '/_nuxt/', '/_ipx/', '/_vercel/', '/assets/', '/build/', '/dist/', '/fonts/', '/images/', '/img/', '/static/', '/wp-content/', '/wp-includes/', '/cdn-cgi/']
const DATA_PATH_PATTERN = /\.json$|^\/api\/|^\/wp-json\/|^\/graphql/i
// Automated clients the crawler rules do not name. A journey is a person in a browser.
const NON_BROWSER_PATTERN = /bot|crawl|spider|slurp|scrape|curl\/|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegram|discord|slack/i
// Query parameters kept on a stored path. Everything else can carry personal data.
const KEPT_QUERY_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
// Click ids only ads add: paid evidence.
const AD_CLICK_ID_PARAMETERS = ['gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'ttclid', 'li_fat_id']
// Click ids platforms also add to unpaid links: they name the network, not a payment.
const NETWORK_CLICK_ID_PARAMETERS: Readonly<Record<string, string>> = { fbclid: 'Facebook', twclid: 'X' }
// Hosted pages that send a visitor straight back to the site: sign-in,
// payment and checkout, and hotel and lodging booking engines (the guest
// books and pays there, then returns to a confirmation page). Their referer
// is a step inside the visit, not a new arrival. Only hosts that do nothing
// but the transaction belong here: a marketplace where people also discover
// a business (a restaurant or event listing site) sends real referrals.
const STEP_REFERER_HOSTS = [
  // Sign-in.
  'accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com',
  'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com', 'github.com/login',
  'auth0.com', 'okta.com', 'onelogin.com', 'amazoncognito.com', 'clerk.accounts.dev',
  // Payment and checkout.
  'pay.google.com', 'checkout.stripe.com', 'js.stripe.com', 'hooks.stripe.com', 'pay.stripe.com', 'connect.stripe.com',
  'paypal.com', 'pay.amazon.com', 'checkout.shopify.com', 'pay.shopify.com', 'shop.app', 'klarna.com', 'afterpay.com',
  'squareup.com', 'checkout.square.site', 'adyen.com', 'braintreegateway.com',
  // Hotel and lodging booking engines.
  'mews.com', 'cloudbeds.com', 'synxis.com', 'travelclick.com', 'thebookingbutton.com', 'webrezpro.com',
  'littlehotelier.com', 'book-directonline.com', 'beds24.com', 'resnexus.com', 'thinkreservations.com',
]
const MAX_PATH_LENGTH = 512
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i
const TOKEN_CHARSET = /^[\w-]+$/
const JWT_SEGMENT = /^eyJ[\w-]+\.[\w-]+/

export interface JourneyRequest {
  eventId: string
  observedAt: string
  method: string | null
  /** Path with secret-like segments masked, plus kept utm parameters, at most 512 characters. */
  path: string
  status: number | null
  kind: JourneyEventKind
  remoteIp: string | null
  userAgent: string
  /**
   * True when the referer is this site or a sign-in or payment page: a step
   * within a visit, not an arrival.
   */
  stepReferer: boolean
  /** How the AI-referral classifier saw the AI engine, when it did. */
  aiEvidence: 'referer' | 'utm' | 'referer-utm' | null
  signal: JourneyEntrySignal
}

export interface ExtractJourneyOptions {
  /** The project's own domains (canonical and owned). Referers on them are steps. */
  siteDomains?: readonly string[]
}

function baseHost(host: string | null | undefined): string | null {
  const h = host?.trim().toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '')
  return h || null
}

/** A host from a bare domain or a URL-like value ("https://www.example.com/"). */
function domainOf(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  try {
    return baseHost(new URL(v.includes('://') ? v : `https://${v}`).hostname)
  } catch {
    return null
  }
}

function refererUrlOf(referer: string | null): URL | null {
  if (!referer) return null
  try {
    return new URL(referer)
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

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

function isStepRefererHost(host: string, path: string): boolean {
  return STEP_REFERER_HOSTS.some(entry => {
    const slash = entry.indexOf('/')
    if (slash < 0) return onDomain(host, entry)
    return host === entry.slice(0, slash) && path.startsWith(entry.slice(slash))
  })
}

function isAssetPath(path: string): boolean {
  return ASSET_PATH_PREFIXES.some(prefix => path.startsWith(prefix)) || ASSET_EXTENSION_PATTERN.test(path)
}

function looksSecret(segment: string): boolean {
  if (UUID_SEGMENT.test(segment) || LONG_HEX_SEGMENT.test(segment) || JWT_SEGMENT.test(segment)) return true
  if (segment.length < 20 || !TOKEN_CHARSET.test(segment)) return false
  const digits = segment.replace(/\D/g, '').length
  const letters = segment.replace(/[^a-z]/gi, '').length
  const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment)
  // Random tokens mix digits and letters; readable slugs separate words with dashes.
  return digits >= 3 && letters >= 3 && (mixedCase || !/[-_]/.test(segment))
}

/**
 * A request path safe to keep: matrix parameters (";jsessionid=") dropped and
 * path segments that look like secrets (UUIDs, long hex, JWTs, random tokens,
 * email addresses) replaced, so reset, invite and share links are not stored.
 * Readable slugs and short numeric ids stay: they are what a journey shows.
 */
export function maskJourneyPath(path: string): string {
  return (path || '/').split('/').map(raw => {
    const segment = raw.split(';')[0]!
    if (!segment) return segment
    if (/@|%40/.test(segment)) return ':email'
    return looksSecret(segment) ? ':token' : segment
  }).join('/') || '/'
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
 * Query strings are cut down to utm parameters and secret-like path segments
 * are masked; a click id is reduced to the fact that one was present.
 */
export function extractJourneyRequests(events: readonly NormalizedTrafficRequest[], options: ExtractJourneyOptions = {}): JourneyRequest[] {
  const siteDomains = (options.siteDomains ?? []).map(domainOf).filter((d): d is string => Boolean(d))
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
    const maskedPath = maskJourneyPath(rawPath)
    const path = (kept.length ? `${maskedPath}?${kept.join('&')}` : maskedPath).slice(0, MAX_PATH_LENGTH)
    const refererUrl = refererUrlOf(event.referer)
    const refererHost = refererUrl?.hostname || null
    const refererBase = baseHost(refererHost)
    const siteHost = baseHost(hostOfEvent(event))
    const sameSite = Boolean(refererBase && (
      (siteHost && (onDomain(refererBase, siteHost) || onDomain(siteHost, refererBase)))
      || siteDomains.some(domain => onDomain(refererBase, domain))
    ))
    const stepReferer = sameSite || Boolean(refererBase && isStepRefererHost(refererBase, refererUrl?.pathname ?? '/'))
    const ai = classifyAiReferral(event)
    const networkClickId = Object.keys(NETWORK_CLICK_ID_PARAMETERS).find(name => params.has(name))

    out.push({
      eventId: event.eventId,
      observedAt: new Date(observedMs).toISOString(),
      method,
      path,
      status: event.status,
      kind: DATA_PATH_PATTERN.test(rawPath) ? 'data' : 'page',
      remoteIp: event.remoteIp?.trim() || null,
      userAgent: event.userAgent!.trim(),
      stepReferer,
      aiEvidence: ai?.evidenceType ?? null,
      signal: {
        aiProduct: ai?.product ?? null,
        aiDomain: ai?.sourceDomain ?? null,
        aiPaid: ai?.trafficClass === 'paid',
        refererHost: stepReferer ? null : refererHost,
        utmSource: params.get('utm_source'),
        utmMedium: params.get('utm_medium'),
        adClickId: AD_CLICK_ID_PARAMETERS.some(name => params.has(name)),
        clickNetwork: networkClickId ? NETWORK_CLICK_ID_PARAMETERS[networkClickId]! : null,
      },
    })
  }
  return out
}

/** A request carries entry evidence when it arrived from outside the site. */
export function hasEntryEvidence(request: JourneyRequest): boolean {
  if (request.stepReferer) return false
  const s = request.signal
  return Boolean(s.aiProduct || s.refererHost || s.utmSource || s.utmMedium || s.adClickId || s.clickNetwork)
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
  /** Times of this visitor's stored AI touches near the batch, any order. */
  aiTimes?: readonly string[]
  /** This visitor's stored visits near the batch window, any order. */
  visits: StoredJourneyVisit[]
  /** Requests already stored per UTC day (YYYY-MM-DD) in the batch's days. */
  requestsByDay?: Readonly<Record<string, number>>
}

export interface KeyedJourneyRequest extends JourneyRequest {
  visitorKey: string
}

export interface JourneyVisitWrite extends StoredJourneyVisit {
  visitorKey: string
  landingPath: string
  isNew: boolean
  /** A stored visit gained an earlier first request: its landing path and entry changed. */
  headChanged: boolean
  /**
   * This new visit is a late arrival inside a stored visit: that visit's
   * requests after `after` belong to this one, as they would have in time order.
   */
  splitFrom?: { visitId: string; after: string }
}

export interface JourneyEventWrite {
  visitId: string
  visitorKey: string
  request: KeyedJourneyRequest
  /** The request was an AI touch (it starts or renews the lookback). */
  aiTouch: boolean
}

export interface JourneyVisitorWrite {
  visitorKey: string
  firstAiAt: string
  firstAiEngine: string
  lastAiAt: string
  userAgent: string
  lastSeenAt: string
  /** UTC days (YYYY-MM-DD) on which this batch hit the daily cap for the visitor. */
  cappedDays: string[]
}

export interface SessionizeJourneyOptions {
  idleMs: number
  lookbackMs: number
  /** Requests stored per visitor per UTC day; the rest are counted, not stored. */
  maxRequestsPerDay: number
  newId: () => string
}

export interface SessionizeJourneyResult {
  visits: JourneyVisitWrite[]
  events: JourneyEventWrite[]
  visitors: JourneyVisitorWrite[]
  /** Requests not kept: outside every AI journey, or background data calls that would open a visit. */
  dropped: number
  /** Requests over the per-visitor daily cap (AI touches are never capped). */
  capped: number
}

const ms = (iso: string) => Date.parse(iso)
const DIRECT_ENTRY: JourneyEntry = { entryClass: 'direct', entryName: null, entryHost: null, paid: false }
const laterOf = (a: string | null, b: string): string => (a !== null && a > b ? a : b)

interface Placement<V> {
  visit: V | undefined
  /** The request becomes the visit's first request. */
  head: boolean
  /** The visit in progress at the request's time, whether or not it continues it. */
  current: V | undefined
}

/**
 * Where a request at `t` goes, as if requests had arrived in time order. The
 * current visit is the latest one started at or before `t` and not idle at
 * `t`. A request with no entry evidence continues it. An arrival from outside
 * continues it only from the same source. Otherwise the request starts a visit,
 * and a later visit that begins within the idle gap and could only have
 * continued this one (it opened with no entry evidence, or from the same
 * source) takes this request as its first.
 */
function placeRequest<V extends StoredJourneyVisit>(visits: readonly V[], t: number, outsideEntry: string | null, idleMs: number): Placement<V> {
  let current: V | undefined
  let next: V | undefined
  for (const v of visits) {
    const start = ms(v.startedAt)
    if (start <= t) {
      if (t <= ms(v.endedAt) + idleMs && (!current || v.startedAt > current.startedAt)) current = v
    } else if (start - t <= idleMs && (!next || v.startedAt < next.startedAt)) {
      next = v
    }
  }
  if (current && (outsideEntry === null || outsideEntry === entryKey(current.entry))) return { visit: current, head: false, current }
  if (next && (next.entry.entryClass === 'direct' || outsideEntry === entryKey(next.entry))) return { visit: next, head: true, current }
  return { visit: undefined, head: false, current }
}

/** Insert into a sorted array at the right place. */
function insertSorted(values: string[], value: string): void {
  let i = values.length
  while (i > 0 && values[i - 1]! > value) i -= 1
  if (values[i - 1] !== value) values.splice(i, 0, value)
}

/**
 * Group each visitor's requests into visits and keep the ones that belong to
 * an AI journey. Visits follow `placeRequest`: an idle gap of `idleMs` or an
 * arrival from a different outside source starts a new visit, as analytics
 * tools do. A request is kept when it is an AI touch, when an AI touch came
 * within `lookbackMs` before it, or when it continues a kept visit. A
 * background data call with no entry evidence never opens a visit.
 *
 * An AI engine seen only on a same-site referer's utm (the landing page was
 * served from a cache the logs never saw) counts as an AI touch only when the
 * visitor had none within the lookback; otherwise it is an ordinary step.
 *
 * Out-of-order batches (backfills) are matched against the visitor's stored
 * visits and AI touches around them, so a late request joins or heads the
 * right visit, a late arrival from elsewhere inside a stored visit takes that
 * visit's later requests (`splitFrom`), and an earlier AI visit moves the
 * journey start back. AI touches are always stored and marked, so the
 * lookback can be rebuilt exactly. A late request does not merge two stored
 * visits, and a push request dropped before the visitor's AI landing arrived
 * is not recovered.
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
  let capped = 0

  for (const [visitorKey, list] of byVisitor) {
    list.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    const prior = state.get(visitorKey)
    const isWeakAi = (r: JourneyRequest) => Boolean(r.signal.aiProduct) && r.stepReferer
    const isStrongAi = (r: JourneyRequest) => Boolean(r.signal.aiProduct) && !r.stepReferer
    // Known AI touches, sorted: stored ones and this batch's direct AI arrivals.
    // Weak ones (same-site utm only) are added below when they count.
    const aiTimes = [...new Set([
      prior?.firstAiAt,
      prior?.lastAiAt,
      ...(prior?.aiTimes ?? []),
      ...list.filter(isStrongAi).map(r => r.observedAt),
    ].filter((t): t is string => Boolean(t)))].sort()
    if (aiTimes.length === 0 && !list.some(isWeakAi)) {
      dropped += list.length
      continue
    }
    const engineAt = new Map<string, string>()
    const known: JourneyVisitWrite[] = (prior?.visits ?? []).map(v => ({ ...v, visitorKey, landingPath: '', isNew: false, headChanged: false }))
    const requestsByDay = new Map(Object.entries(prior?.requestsByDay ?? {}))
    let keptAny = false
    const cappedDays = new Set<string>()
    let lastSeenAt: string | null = null
    let userAgent = list[0].userAgent
    // Index of the latest AI touch at or before the current request.
    let aiIndex = -1

    for (const request of list) {
      const t = ms(request.observedAt)
      while (aiIndex + 1 < aiTimes.length && aiTimes[aiIndex + 1]! <= request.observedAt) aiIndex += 1
      const withinLookback = aiIndex >= 0 && t - ms(aiTimes[aiIndex]!) <= options.lookbackMs
      let aiTouch = isStrongAi(request)
      if (isWeakAi(request) && !withinLookback) {
        aiTouch = true
        insertSorted(aiTimes, request.observedAt)
        aiIndex = aiTimes.indexOf(request.observedAt)
      }
      if (aiTouch && request.signal.aiProduct && !engineAt.has(request.observedAt)) engineAt.set(request.observedAt, request.signal.aiProduct)

      // A step (same-site, sign-in or payment referer) that opens a visit after
      // an idle gap came from nowhere new: utm tags carried on internal links
      // do not name a source for it.
      const entry = aiTouch
        ? classifyJourneyEntry(request.signal)
        : request.stepReferer
          ? DIRECT_ENTRY
          : classifyJourneyEntry({ ...request.signal, aiProduct: null, aiDomain: null, aiPaid: false })
      const outside = aiTouch || hasEntryEvidence(request)
      const placement = placeRequest(known, t, outside ? entryKey(entry) : null, options.idleMs)
      const continues = placement.visit !== undefined && !placement.head
      const kept = aiTouch || withinLookback || continues
      const opensVisit = placement.visit === undefined
      if (!kept || (opensVisit && request.kind === 'data' && !outside)) {
        dropped += 1
        continue
      }
      const day = request.observedAt.slice(0, 10)
      const stored = requestsByDay.get(day) ?? 0
      if (stored >= options.maxRequestsPerDay && !aiTouch) {
        cappedDays.add(day)
        capped += 1
        continue
      }
      requestsByDay.set(day, stored + 1)

      let target: JourneyVisitWrite
      if (placement.visit) {
        target = placement.visit
        if (placement.head) {
          target.startedAt = request.observedAt
          target.landingPath = request.path
          if (outside) target.entry = entry
          target.headChanged = !target.isNew
        }
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
          headChanged: false,
        }
        // An arrival from elsewhere inside a visit that already has later
        // requests: those requests followed this arrival, so they move to it.
        const inside = placement.current
        if (outside && inside && request.observedAt < inside.endedAt) {
          target.splitFrom = { visitId: inside.id, after: request.observedAt }
          target.endedAt = inside.endedAt
          inside.endedAt = request.observedAt
          visits.set(inside.id, inside)
        }
        known.push(target)
      }
      visits.set(target.id, target)
      events.push({ visitId: target.id, visitorKey, request, aiTouch })
      keptAny = true
      lastSeenAt = laterOf(lastSeenAt, request.observedAt)
      userAgent = request.userAgent
    }

    if ((keptAny || cappedDays.size > 0) && aiTimes.length > 0) {
      const firstAiAt = aiTimes[0]!
      visitors.push({
        visitorKey,
        firstAiAt,
        firstAiEngine: (prior?.firstAiAt === firstAiAt ? prior?.firstAiEngine : null) ?? engineAt.get(firstAiAt) ?? prior?.firstAiEngine ?? 'AI',
        lastAiAt: aiTimes[aiTimes.length - 1]!,
        userAgent,
        lastSeenAt: lastSeenAt ?? prior?.lastAiAt ?? firstAiAt,
        cappedDays: [...cappedDays].sort(),
      })
    }
  }

  return { visits: [...visits.values()], events, visitors, dropped, capped }
}
