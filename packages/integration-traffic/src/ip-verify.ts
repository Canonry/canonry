/**
 * IP-range verification for bot operators that publish their crawler IPs.
 *
 * **Why this exists.** UA-string classification (`classifyCrawler`) is
 * spoofable per-request — any scraper can send
 * `User-Agent: Googlebot/2.1`. Operators that care about being
 * trustworthy publish the IP ranges their crawlers operate from; we use
 * those to promote `claimed_unverified` → `verified` when the request's
 * source IP falls in the published range.
 *
 * **Coverage today.** Operators with ranges bundled under
 * `./ip-ranges/<operator>.json`:
 *   - Googlebot              (developers.google.com/static/crawling/ipranges/common-crawlers.json)
 *   - bingbot                (www.bing.com/toolbox/bingbot.json)
 *   - OpenAI GPTBot          (openai.com/gptbot.json)
 *   - OpenAI ChatGPT-User    (openai.com/chatgpt-user.json)
 *   - OpenAI OAI-SearchBot   (openai.com/searchbot.json)
 *   - OpenAI OAI-AdsBot      (openai.com/adsbot.json)
 *   - OpenAI ChatGPT integrations (openai.com/chatgpt-connectors.json)
 *   - PerplexityBot          (www.perplexity.com/perplexitybot.json)
 *   - Perplexity-User        (www.perplexity.com/perplexity-user.json)
 *   - ClaudeBot, Claude-SearchBot, Claude-User
 *                            (claude.com/crawling/bots.json — Anthropic's
 *                             shared crawler-origin manifest does not split
 *                             ranges by bot, so every Claude-* rule verifies
 *                             against the same published set.)
 *   - Google-Agent           (developers.google.com/static/crawling/ipranges/user-triggered-agents.json
 *                             — Google's agentic user-request list.)
 *   - Google-GeminiNotebook  (developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json)
 *   - Google-CloudVertexBot  (Google common crawlers manifest)
 *   - Parallel ShapBot, Applebot, Common Crawl CCBot
 *   - DuckDuckBot, DuckAssistBot
 *   - MistralAI-User, MistralAI-Index
 *   - Amazonbot, Amzn-SearchBot, Amzn-User
 *
 * **Not covered (yet).** Meta, ByteDance, DeepSeek, xAI, You.com, Cohere,
 * Diffbot, Yandex, and Baidu do not publish a compatible range source.
 * Parallel's Shap-User and MistralAI-Training are also UA-only. Add them the moment an
 * official source appears; never infer crawler identity from cloud ASNs.
 *
 * **User-fetch agents and on-device fetches.** A user-triggered fetch
 * (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, …) does not always
 * leave the operator's servers. Some surfaces fetch the URL server-side,
 * so it egresses from the operator's cloud IP and verifies here. A local
 * app can instead fetch straight from the user's device, egressing from
 * the user's own residential or cellular IP, which no operator publishes
 * and never could. That on-device case is structurally unverifiable: a
 * genuine user fetch then stays `claimed_unverified` permanently, and
 * that is correct, not a coverage gap. Treat the `ai_user_fetch` channel
 * count as the signal; an IP-confirmed `verified` is a bonus subset.
 *
 * **Refresh.** Run `scripts/refresh-ip-ranges.ts` to re-fetch all
 * bundled lists from the publishers. The script is git-friendly: it
 * writes pretty-printed JSON so diffs show exactly which prefixes the
 * operator added/removed.
 */
import type { TrafficVerificationManifest } from '@canonry/canonry-contracts'
import amazonbotRaw from './ip-ranges/amazonbot.json' with { type: 'json' }
import amznSearchbotRaw from './ip-ranges/amzn-searchbot.json' with { type: 'json' }
import amznUserRaw from './ip-ranges/amzn-user.json' with { type: 'json' }
import anthropicRaw from './ip-ranges/anthropic.json' with { type: 'json' }
import applebotRaw from './ip-ranges/applebot.json' with { type: 'json' }
import bingbotRaw from './ip-ranges/bingbot.json' with { type: 'json' }
import ccbotRaw from './ip-ranges/ccbot.json' with { type: 'json' }
import chatgptConnectorsRaw from './ip-ranges/chatgpt-connectors.json' with { type: 'json' }
import chatgptUserRaw from './ip-ranges/chatgpt-user.json' with { type: 'json' }
import duckassistbotRaw from './ip-ranges/duckassistbot.json' with { type: 'json' }
import duckduckbotRaw from './ip-ranges/duckduckbot.json' with { type: 'json' }
import googleUserTriggeredRaw from './ip-ranges/google-user-triggered-agents.json' with { type: 'json' }
import googleUserFetchersRaw from './ip-ranges/google-user-triggered-fetchers.json' with { type: 'json' }
import googlebotRaw from './ip-ranges/googlebot.json' with { type: 'json' }
import gptbotRaw from './ip-ranges/gptbot.json' with { type: 'json' }
import mistralAiIndexRaw from './ip-ranges/mistral-ai-index.json' with { type: 'json' }
import mistralAiUserRaw from './ip-ranges/mistral-ai-user.json' with { type: 'json' }
import oaiAdsbotRaw from './ip-ranges/oai-adsbot.json' with { type: 'json' }
import oaiSearchbotRaw from './ip-ranges/oai-searchbot.json' with { type: 'json' }
import parallelShapbotRaw from './ip-ranges/parallel-shapbot.json' with { type: 'json' }
import perplexityUserRaw from './ip-ranges/perplexity-user.json' with { type: 'json' }
import perplexitybotRaw from './ip-ranges/perplexitybot.json' with { type: 'json' }
import {
  ipRangeManifestContentHash,
  parseCidr,
  parseIp,
  validateIpRangeManifestPayload,
} from './ip-range-manifest.js'
import type { ParsedCidr } from './ip-range-manifest.js'

export {
  ipRangeManifestContentHash,
  ipInCidr,
  parseCidr,
  parseIp,
  validateIpRangeManifestPayload,
} from './ip-range-manifest.js'

export interface IpVerificationDecision {
  verified: boolean
  /** Exact vendored publisher snapshot consulted for this decision. */
  manifest: TrafficVerificationManifest | null
}

interface VerificationData {
  readonly ranges: ParsedCidr[]
  readonly manifest: TrafficVerificationManifest | null
}

/**
 * Maps a classifier rule id (the `id` field on `AiCrawlerRule` in
 * `rules.ts`) to the ranges file for that operator. Rules with no
 * entry here can't be verified by IP — they stay
 * `claimed_unverified` after UA classification. Missing entries are
 * intentional (no publisher data) and should be added the moment an
 * operator publishes ranges.
 */
const RULE_ID_TO_RANGES: Record<string, unknown> = {
  // OpenAI publishes separate lists for each traffic surface because the
  // ranges differ between products.
  // src: https://openai.com/gptbot.json
  'openai-gptbot': gptbotRaw,
  // src: https://openai.com/chatgpt-user.json
  'openai-chatgpt-user': chatgptUserRaw,
  // src: https://openai.com/searchbot.json
  'openai-searchbot': oaiSearchbotRaw,
  // src: https://openai.com/adsbot.json
  'openai-adsbot': oaiAdsbotRaw,
  // src: https://openai.com/chatgpt-connectors.json
  'openai-chatgpt-connector': chatgptConnectorsRaw,

  // Search engines.
  // src: https://developers.google.com/static/crawling/ipranges/common-crawlers.json
  'googlebot': googlebotRaw,
  // src: https://www.bing.com/toolbox/bingbot.json
  // (also covers Copilot grounding — Microsoft routes Copilot's
  // web fetches through bingbot infrastructure)
  'bingbot': bingbotRaw,

  // Google-Agent — Google's agentic user-triggered fetcher (Project
  // Mariner et al.). Verified against Google's user-triggered-agents
  // list. Google publishes a different shared list for its non-agentic
  // user-triggered fetchers such as Gemini Notebook.
  // src: https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json
  'google-agent': googleUserTriggeredRaw,
  // src: https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json
  'google-gemini-notebook': googleUserFetchersRaw,
  // Google documents CloudVertexBot as a common crawler.
  'google-cloudvertexbot': googlebotRaw,

  // Perplexity — split between crawler and user-on-behalf fetcher,
  // same shape as OpenAI's split.
  // src: https://www.perplexity.com/perplexitybot.json
  'perplexity-bot': perplexitybotRaw,
  // src: https://www.perplexity.com/perplexity-user.json
  'perplexity-user': perplexityUserRaw,

  // Parallel publishes ranges for ShapBot, but not Shap-User.
  // src: https://docs.parallel.ai/resources/shapbot.json
  'parallel-shapbot': parallelShapbotRaw,

  // Other publisher manifests with the common Google-style schema.
  // src: https://search.developer.apple.com/applebot.json
  'applebot': applebotRaw,
  // src: https://index.commoncrawl.org/ccbot.json
  'ccbot': ccbotRaw,
  // src: https://duckduckgo.com/duckduckbot.json
  'duckduckbot': duckduckbotRaw,
  // src: https://duckduckgo.com/duckassistbot.json
  'duckassistbot': duckassistbotRaw,
  // src: https://mistral.ai/mistralai-user-ips.json
  'mistral-ai-user': mistralAiUserRaw,
  // src: https://mistral.ai/mistralai-index-ips.json
  'mistral-ai-index': mistralAiIndexRaw,

  // Amazon publishes embedded JSON in documentation pages. The refresh script
  // extracts it and normalizes bare host addresses to /32 or /128.
  // src: https://developer.amazon.com/amazonbot/ip-addresses/
  'amazonbot': amazonbotRaw,
  // src: https://developer.amazon.com/amazonbot/searchbot-ip-addresses/
  'amzn-searchbot': amznSearchbotRaw,
  // src: https://developer.amazon.com/amazonbot/live-ip-addresses/
  'amzn-user': amznUserRaw,

  // Anthropic publishes one shared crawler-origin manifest. It confirms
  // Anthropic origin but does not attribute a prefix to ClaudeBot,
  // Claude-SearchBot, or Claude-User individually, so both classifier rules
  // map to the same file and the UA remains the product discriminator.
  // src: https://claude.com/crawling/bots.json
  'anthropic-claudebot': anthropicRaw,
  'claude-user': anthropicRaw,
}

function manifestMetadata(raw: unknown): TrafficVerificationManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const source = typeof record._source === 'string' ? record._source.trim() : ''
  const version = typeof record.creationTime === 'string' ? record.creationTime.trim() : ''
  if (!source || !version) return null
  const contentHash = ipRangeManifestContentHash(raw)
  return { id: `${source}#${version}#sha256:${contentHash}`, source, version }
}

function verificationDataFromRaw(raw: unknown): VerificationData {
  const validation = validateIpRangeManifestPayload(raw)
  const ranges: ParsedCidr[] = []
  if (validation.ok) {
    for (const entry of validation.value.prefixes) {
      const parsed = parseCidr(entry.ipv4Prefix ?? entry.ipv6Prefix)
      if (parsed) ranges.push(parsed)
    }
  }
  return { ranges, manifest: manifestMetadata(raw) }
}

function decideIpVerification(
  ip: string | null | undefined,
  data: VerificationData,
): IpVerificationDecision {
  // A manifest only CHECKED this request when there was both an address to
  // test and a parsed range set to test it against. Missing either means
  // nothing was consulted, so returning the manifest here would assert a check
  // that never ran — the same claim `backfill.ts` deliberately refuses to make
  // when it replays a sample whose IP was never retained. Returning null is
  // what makes the two outcomes below distinguishable: `manifest: X` means X
  // rejected this IP, `manifest: null` means no comparison happened at all.
  if (!ip || data.ranges.length === 0) return { verified: false, manifest: null }
  const parsed = parseIp(ip)
  if (!parsed) return { verified: false, manifest: null }
  for (const cidr of data.ranges) {
    if (parsed.version !== cidr.version) continue
    if ((parsed.addr & cidr.mask) === cidr.network) {
      return { verified: true, manifest: data.manifest }
    }
  }
  return { verified: false, manifest: data.manifest }
}

/** Pure verification helper for validating a candidate or fixture manifest. */
export function verifyIpAgainstManifest(
  ip: string | null | undefined,
  raw: unknown,
): IpVerificationDecision {
  return decideIpVerification(ip, verificationDataFromRaw(raw))
}

/**
 * Parses every operator's prefixes into the BigInt form at module-load
 * time. Roughly 4,500 prefixes across all manifests today, parsed once per
 * process boot; a verification scans only the one mapped manifest (currently
 * at most ~1,100 prefixes). Could be O(log N) with a sorted-range search if
 * hot — not needed yet. The publisher
 * metadata is cached beside the ranges so every classification can retain
 * the exact vendored snapshot used without any runtime I/O.
 */
const CACHE: Map<string, VerificationData> = (() => {
  const cache = new Map<string, VerificationData>()
  for (const [ruleId, raw] of Object.entries(RULE_ID_TO_RANGES)) {
    cache.set(ruleId, verificationDataFromRaw(raw))
  }
  return cache
})()

/**
 * Decide whether an IP falls in the published ranges for a crawler rule and
 * return the exact vendored manifest that was consulted, or null when none
 * was. Provenance is retained when the IP was actually compared against a
 * parsed range set — whether it matched or not — so callers can distinguish
 * "rejected by snapshot X" from "nothing checked this request". An absent or
 * malformed IP, a rule with no published ranges, and a manifest that failed
 * validation all yield `manifest: null`, because no comparison took place.
 * Resolved without runtime I/O.
 */
export function verifyIpForRuleDecision(
  ip: string | null | undefined,
  ruleId: string,
): IpVerificationDecision {
  const data = CACHE.get(ruleId)
  return data ? decideIpVerification(ip, data) : { verified: false, manifest: null }
}

/**
 * Boolean-compatible verification API retained for existing callers. Use
 * `verifyIpForRuleDecision` when the publisher snapshot must be persisted.
 */
export function verifyIpForRule(ip: string | null | undefined, ruleId: string): boolean {
  return verifyIpForRuleDecision(ip, ruleId).verified
}

/** Whether a rule id has any verification data available at all. */
export function hasVerificationDataFor(ruleId: string): boolean {
  const data = CACHE.get(ruleId)
  return !!data && data.ranges.length > 0
}
