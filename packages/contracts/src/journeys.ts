import { z } from 'zod'
import { fraction } from './ratio-unit.js'

/**
 * AI visitor journeys: what a visitor who arrived from an AI engine did on the
 * site afterwards, across later visits through any channel. Built from the
 * server-side traffic every source already pulls, with no site code and no
 * per-site setup. A visitor is a keyed hash of what the provider reports
 * (IP + user agent, or the user agent alone), never a person.
 */

/** Visits starting within this long after one of a visitor's AI-referred visits are kept. */
export const JOURNEY_LOOKBACK_DAYS = 30
/** Journey rows are deleted after this long. */
export const JOURNEY_RETENTION_DAYS = 180
/** A visit ends after this long without a request. */
export const JOURNEY_VISIT_IDLE_MINUTES = 30

/**
 * Requests stored per visitor per UTC day. One person rarely makes more; a
 * user-agent-only key (a source without an IP) can merge everyone on the same
 * device and browser version, and the cap keeps such a key from storing that
 * whole cohort's traffic. AI touches are always stored. The days a key reached
 * the cap are kept in `cappedDays`.
 */
export const JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY = 300

/**
 * Traffic source types whose logs hold only part of a visitor's requests, so
 * journeys from them miss later visits. Reads name these sources.
 */
export const JOURNEY_PARTIAL_SOURCE_TYPES: Readonly<Record<string, string>> = {
  cloudflare: 'The Worker forwards only AI-referred and bot requests, so later visits from this source are not recorded. Reconnect with --forward-page-views and redeploy the Worker to record them.',
}

/** A Cloudflare source set to forward page views whose deployed Worker has not reported it yet. */
export const JOURNEY_PAGE_VIEWS_PENDING_REASON = 'Page-view forwarding is on, but the deployed Worker has not reported it yet. Redeploy the Worker and send a request through it.'

/** Visits nested under each visitor in a journeys list: the first ones, in order. */
export const JOURNEY_LIST_VISITS_PER_VISITOR = 20

/**
 * What a visitor key was computed from. `ip-ua` (Cloud Run, Cloudflare,
 * WordPress) separates people on one network poorly when they share a browser
 * build and splits one person whose IP changes. `ua` (Vercel, which reports no
 * client IP) joins every visitor with the same browser build, so its matches
 * are weaker.
 */
export const journeyKeyBasisSchema = z.enum(['ip-ua', 'ua'])
export type JourneyKeyBasis = z.infer<typeof journeyKeyBasisSchema>
export const JourneyKeyBases = journeyKeyBasisSchema.enum

/** Where a visit came from, judged from its first request. */
export const journeyEntryClassSchema = z.enum(['ai', 'search', 'social', 'paid', 'referral', 'direct'])
export type JourneyEntryClass = z.infer<typeof journeyEntryClassSchema>
export const JourneyEntryClasses = journeyEntryClassSchema.enum

/** `page`: a document request. `data`: a JSON or API request the page made (SPA navigation, form posts). */
export const journeyEventKindSchema = z.enum(['page', 'data'])
export type JourneyEventKind = z.infer<typeof journeyEventKindSchema>

/** The entry evidence on one request, as the traffic pipeline sees it. */
export interface JourneyEntrySignal {
  /** Set when the AI-referral classifier matched (product name, e.g. "ChatGPT"). */
  aiProduct: string | null
  aiDomain: string | null
  aiPaid: boolean
  /** External referer host, or null when absent, on the same site, or a sign-in or payment page. */
  refererHost: string | null
  utmSource: string | null
  utmMedium: string | null
  /** An ad click id (gclid, gbraid, wbraid, dclid, msclkid, ttclid, li_fat_id) was present; only its presence is kept. */
  adClickId: boolean
  /** Network named by a click id platforms also add to unpaid links (fbclid: Facebook, twclid: X). Not paid evidence. */
  clickNetwork: string | null
}

export interface JourneyEntry {
  entryClass: JourneyEntryClass
  /** Engine, search engine, network or host the visit came from; null for direct. */
  entryName: string | null
  entryHost: string | null
  paid: boolean
}

const SEARCH_ENGINES: ReadonlyArray<{ name: string; match: (host: string) => boolean }> = [
  // Search hosts only: accounts.google.com, mail.yahoo.com and the like are not search.
  { name: 'Google', match: h => /^google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(h) },
  { name: 'Bing', match: h => h === 'bing.com' || h === 'cn.bing.com' },
  { name: 'DuckDuckGo', match: h => h === 'duckduckgo.com' || h === 'html.duckduckgo.com' },
  { name: 'Yahoo', match: h => /(?:^|\.)search\.yahoo\.[a-z.]+$/.test(h) },
  { name: 'Yandex', match: h => /^yandex\.[a-z]{2,3}$/.test(h) || h === 'ya.ru' },
  { name: 'Baidu', match: h => h === 'baidu.com' || h === 'm.baidu.com' },
  { name: 'Ecosia', match: h => h === 'ecosia.org' },
  { name: 'Brave Search', match: h => h === 'search.brave.com' },
  { name: 'Naver', match: h => h === 'search.naver.com' || h === 'm.search.naver.com' },
  { name: 'Startpage', match: h => h === 'startpage.com' || h.endsWith('.startpage.com') },
  { name: 'Qwant', match: h => h === 'qwant.com' || h.endsWith('.qwant.com') },
]

const SOCIAL_NETWORKS: ReadonlyArray<{ name: string; hosts: readonly string[] }> = [
  { name: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  { name: 'Instagram', hosts: ['instagram.com'] },
  { name: 'X', hosts: ['x.com', 'twitter.com', 't.co'] },
  { name: 'LinkedIn', hosts: ['linkedin.com', 'lnkd.in'] },
  { name: 'Reddit', hosts: ['reddit.com', 'redd.it'] },
  { name: 'Pinterest', hosts: ['pinterest.com', 'pin.it'] },
  { name: 'TikTok', hosts: ['tiktok.com'] },
  { name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { name: 'Threads', hosts: ['threads.net', 'threads.com'] },
  { name: 'Bluesky', hosts: ['bsky.app'] },
]

// utm_source values that name a search engine or network without a referer.
// A Map, so a value such as "constructor" or "__proto__" never reaches an
// inherited object property.
const SOURCE_NAMES: ReadonlyMap<string, { entryClass: JourneyEntryClass; name: string }> = new Map([
  ['google', { entryClass: 'search', name: 'Google' }],
  ['bing', { entryClass: 'search', name: 'Bing' }],
  ['duckduckgo', { entryClass: 'search', name: 'DuckDuckGo' }],
  ['yahoo', { entryClass: 'search', name: 'Yahoo' }],
  ['facebook', { entryClass: 'social', name: 'Facebook' }],
  ['fb', { entryClass: 'social', name: 'Facebook' }],
  ['instagram', { entryClass: 'social', name: 'Instagram' }],
  ['ig', { entryClass: 'social', name: 'Instagram' }],
  ['twitter', { entryClass: 'social', name: 'X' }],
  ['x', { entryClass: 'social', name: 'X' }],
  ['linkedin', { entryClass: 'social', name: 'LinkedIn' }],
  ['reddit', { entryClass: 'social', name: 'Reddit' }],
  ['pinterest', { entryClass: 'social', name: 'Pinterest' }],
  ['tiktok', { entryClass: 'social', name: 'TikTok' }],
  ['youtube', { entryClass: 'social', name: 'YouTube' }],
])

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'paidsocial', 'paid_social', 'paid-social', 'cpm', 'display', 'ads', 'ad'])

function baseHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

function socialName(host: string): string | null {
  for (const network of SOCIAL_NETWORKS) {
    if (network.hosts.some(h => host === h || host.endsWith(`.${h}`))) return network.name
  }
  return null
}

function searchName(host: string): string | null {
  return SEARCH_ENGINES.find(engine => engine.match(host))?.name ?? null
}

/**
 * Where a visit came from. AI referrals win (the AI-referral classifier already
 * judged them); then a paid marker (paid utm_medium or an ad click id); then
 * the external referer host; then a utm_source with no referer; then a network
 * click id (fbclid) with neither; else direct.
 */
export function classifyJourneyEntry(signal: JourneyEntrySignal): JourneyEntry {
  if (signal.aiProduct) {
    return { entryClass: 'ai', entryName: signal.aiProduct, entryHost: signal.aiDomain, paid: signal.aiPaid }
  }
  const host = signal.refererHost ? baseHost(signal.refererHost) : null
  const medium = signal.utmMedium?.trim().toLowerCase() ?? ''
  const source = signal.utmSource?.trim().toLowerCase() ?? ''
  const paid = PAID_MEDIUMS.has(medium) || signal.adClickId
  const fromHost = host ? (searchName(host) ? { entryClass: 'search' as const, name: searchName(host)! } : socialName(host) ? { entryClass: 'social' as const, name: socialName(host)! } : null) : null
  const fromSource = source ? SOURCE_NAMES.get(source.replace(/\.com$/, '')) ?? null : null
  if (paid) {
    return { entryClass: 'paid', entryName: fromHost?.name ?? fromSource?.name ?? signal.clickNetwork ?? (source || host), entryHost: host, paid: true }
  }
  if (fromHost) return { entryClass: fromHost.entryClass, entryName: fromHost.name, entryHost: host, paid: false }
  if (host) return { entryClass: 'referral', entryName: host, entryHost: host, paid: false }
  if (fromSource) return { entryClass: fromSource.entryClass, entryName: fromSource.name, entryHost: null, paid: false }
  if (source) return { entryClass: 'referral', entryName: source, entryHost: null, paid: false }
  if (signal.clickNetwork) return { entryClass: 'social', entryName: signal.clickNetwork, entryHost: null, paid: false }
  return { entryClass: 'direct', entryName: null, entryHost: null, paid: false }
}

/**
 * Safari major version from which the iOS version in the user agent is
 * frozen (iOS 26 reports "OS 18_6", later "18_7"). From then on Safari's
 * Version token carries the real iOS major version.
 */
const SAFARI_FROZEN_IOS_VERSION_FROM = 26

/**
 * A short device label for display ("iPhone · iOS 27 · Safari",
 * "Mac · Chrome 155"). The full user agent is stored; interfaces show this.
 */
export function journeyDeviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? ''
  if (!ua) return 'Unknown device'
  const browser = (() => {
    const edge = /Edg(?:e|A|iOS)?\/(\d+)/.exec(ua)
    if (edge) return `Edge ${edge[1]}`
    const firefox = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua)
    if (firefox) return `Firefox ${firefox[1]}`
    const samsung = /SamsungBrowser\/(\d+)/.exec(ua)
    if (samsung) return `Samsung Internet ${samsung[1]}`
    const chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(ua)
    if (chrome) return `Chrome ${chrome[1]}`
    if (!/Safari\//.test(ua)) return null
    const safari = /Version\/(\d+(?:\.\d+)?)/.exec(ua)
    return safari ? `Safari ${safari[1]}` : 'Safari'
  })()
  const ios = /(iPhone|iPad|iPod).*?OS (\d+)_(\d+)/.exec(ua)
  if (ios) {
    const thirdParty = /CriOS|FxiOS|EdgiOS/.test(ua)
    // Chrome, Firefox and Edge on iOS still report the real OS version.
    const safariMajor = thirdParty ? NaN : Number(/Version\/(\d+)/.exec(ua)?.[1])
    const iosVersion = safariMajor >= SAFARI_FROZEN_IOS_VERSION_FROM ? String(safariMajor) : `${ios[2]}.${ios[3]}`
    return [ios[1], `iOS ${iosVersion}`, thirdParty ? browser : 'Safari'].filter(Boolean).join(' · ')
  }
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  if (android) return ['Android ' + android[1], browser].filter(Boolean).join(' · ')
  const os = /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null
  if (os || browser) return [os, browser].filter(Boolean).join(' · ')
  return ua.length > 40 ? `${ua.slice(0, 39)}…` : ua
}

const isoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.date()], { error: 'Expected an ISO timestamp or YYYY-MM-DD date' })

export const journeysQuerySchema = z.object({
  since: isoInstant.optional(),
  until: isoInstant.optional(),
  /** AI engine product name, e.g. "ChatGPT" (case-insensitive). */
  engine: z.string().min(1).optional(),
  /** Only visitors who came back after their first AI visit. */
  returned: z.enum(['true', 'false']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
})
export type JourneysQuery = z.infer<typeof journeysQuerySchema>

export const journeySummaryQuerySchema = journeysQuerySchema.pick({ since: true, until: true })
export type JourneySummaryQuery = z.infer<typeof journeySummaryQuerySchema>

/** Project traffic sources whose journeys miss later visits, with the reason. */
export const journeyPartialSourcesSchema = z.array(z.object({
  sourceId: z.string(),
  sourceType: z.string(),
  reason: z.string(),
}))
export type JourneyPartialSources = z.infer<typeof journeyPartialSourcesSchema>

export const journeyVisitDtoSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  entryClass: journeyEntryClassSchema,
  entryName: z.string().nullable(),
  entryHost: z.string().nullable(),
  paid: z.boolean(),
  landingPath: z.string(),
  requestCount: z.number().int(),
  pageCount: z.number().int(),
})
export type JourneyVisitDto = z.infer<typeof journeyVisitDtoSchema>

export const journeyVisitorDtoSchema = z.object({
  /** Keyed hash, unique per project. Never an IP or a person. */
  visitorKey: z.string(),
  keyBasis: journeyKeyBasisSchema,
  /** Short label for display. */
  device: z.string(),
  /** Full user agent as reported. */
  userAgent: z.string().nullable(),
  firstAiAt: z.string(),
  firstAiEngine: z.string(),
  lastAiAt: z.string(),
  lastSeenAt: z.string(),
  visitCount: z.number().int(),
  aiVisitCount: z.number().int(),
  /** Came back in a later visit after the first AI visit. */
  returned: z.boolean(),
  /** Entry classes of the visits after the first AI visit, in order. */
  returnChannels: z.array(journeyEntryClassSchema),
  /** UTC days on which this key reached the daily request cap; a key that reaches it often is probably a user agent many people share. */
  cappedDays: z.number().int(),
})
export type JourneyVisitorDto = z.infer<typeof journeyVisitorDtoSchema>

export const journeysResponseSchema = z.object({
  project: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  lookbackDays: z.literal(JOURNEY_LOOKBACK_DAYS),
  retentionDays: z.literal(JOURNEY_RETENTION_DAYS),
  totalVisitors: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  partialSources: journeyPartialSourcesSchema,
  /** Each visitor's first visits, at most JOURNEY_LIST_VISITS_PER_VISITOR; `visitCount` is the total. */
  visitors: z.array(journeyVisitorDtoSchema.extend({ visits: z.array(journeyVisitDtoSchema) })),
})
export type JourneysResponse = z.infer<typeof journeysResponseSchema>

export const journeyEventDtoSchema = z.object({
  ts: z.string(),
  method: z.string().nullable(),
  path: z.string(),
  status: z.number().int().nullable(),
  kind: journeyEventKindSchema,
  /** This request was an AI touch: it started or renewed the 30-day window. */
  aiTouch: z.boolean(),
})
export type JourneyEventDto = z.infer<typeof journeyEventDtoSchema>

export const journeyDetailQuerySchema = z.object({
  /** Visits per page, in time order. */
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
})
export type JourneyDetailQuery = z.infer<typeof journeyDetailQuerySchema>

export const journeyDetailResponseSchema = z.object({
  project: z.string(),
  visitor: journeyVisitorDtoSchema,
  totalVisits: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  visits: z.array(journeyVisitDtoSchema.extend({ events: z.array(journeyEventDtoSchema) })),
})
export type JourneyDetailResponse = z.infer<typeof journeyDetailResponseSchema>

export const journeySummaryResponseSchema = z.object({
  project: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  lookbackDays: z.literal(JOURNEY_LOOKBACK_DAYS),
  /** Visitors whose first AI visit started in the window. */
  aiVisitors: z.number().int(),
  /** AI-referred visits that started in the window. */
  aiVisits: z.number().int(),
  /** Of aiVisitors, those who came back in a later visit. */
  returningVisitors: z.number().int(),
  /** returningVisitors / aiVisitors; null with no AI visitors. */
  returnRate: fraction().nullable(),
  /** Later visits of those visitors, by how they came back. */
  returnedVia: z.record(journeyEntryClassSchema, z.number().int()),
  /** Median days from a visitor's first AI visit to their first later visit; null with none. */
  medianDaysToReturn: z.number().nullable(),
  byEngine: z.array(z.object({ engine: z.string(), visitors: z.number().int(), returningVisitors: z.number().int() })),
  keyBasis: z.object({ ipUa: z.number().int(), ua: z.number().int() }),
  partialSources: journeyPartialSourcesSchema,
})
export type JourneySummaryResponse = z.infer<typeof journeySummaryResponseSchema>
