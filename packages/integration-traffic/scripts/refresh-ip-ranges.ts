#!/usr/bin/env tsx
/**
 * Refreshes every bundled crawler IP-range JSON from its upstream
 * publisher. Automation runs this weekly, but a vendored file is rewritten
 * only when its executable prefix set or canonical source URL changes. A
 * publisher that rotates `creationTime` without changing ranges therefore
 * creates no repository churn.
 *
 * Usage (from repo root):
 *   pnpm --filter @canonry/canonry-integration-traffic exec tsx scripts/refresh-ip-ranges.ts
 *
 * Or directly:
 *   tsx packages/integration-traffic/scripts/refresh-ip-ranges.ts
 *
 * Writes pretty-printed JSON so `git diff` shows exactly which
 * prefixes the operator added / removed. A partial failure still updates
 * the lists that succeeded, but exits nonzero so automation cannot silently
 * retain stale data. Prints a per-source summary to stderr.
 *
 * Operators still without a publisher range manifest include Meta,
 * ByteDance, DeepSeek, xAI, You.com, Cohere, Diffbot, Yandex, and Baidu.
 * Parallel's Shap-User and MistralAI-Training are also UA-only. Add a source
 * here and a rule mapping in `src/ip-verify.ts` when an official list appears.
 * OpenAI's chatgpt-agents.json is intentionally absent: official docs assign
 * it to Codex cloud service egress, not a crawler or ChatGPT cloud browser.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ipRangeManifestContentHash,
  parseCidr,
  parseIp,
  validateIpRangeManifestPayload,
} from '../src/ip-range-manifest.js'
import type { ValidatedIpRangeManifestPayload } from '../src/ip-range-manifest.js'
import { describeError } from '@canonry/canonry-contracts'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rangesDir = path.resolve(dirname, '..', 'src', 'ip-ranges')

export interface Source {
  /** Filename under `src/ip-ranges/`. Must match the import in `ip-verify.ts`. */
  file: string
  /** Publisher URL — the operator's canonical JSON. */
  url: string
  /** Display label for the per-source progress line. */
  label: string
  /** Response decoder. Most publishers serve JSON; Amazon embeds it in HTML. */
  format?: 'json' | 'amazon-html'
}

export const SOURCES: Source[] = [
  {
    file: 'anthropic.json',
    url: 'https://claude.com/crawling/bots.json',
    label: 'Anthropic Bots',
  },
  {
    file: 'googlebot.json',
    url: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
    label: 'Googlebot',
  },
  {
    file: 'bingbot.json',
    url: 'https://www.bing.com/toolbox/bingbot.json',
    label: 'bingbot',
  },
  {
    file: 'gptbot.json',
    url: 'https://openai.com/gptbot.json',
    label: 'OpenAI GPTBot',
  },
  {
    file: 'chatgpt-user.json',
    url: 'https://openai.com/chatgpt-user.json',
    label: 'OpenAI ChatGPT-User',
  },
  {
    file: 'oai-searchbot.json',
    url: 'https://openai.com/searchbot.json',
    label: 'OpenAI OAI-SearchBot',
  },
  {
    file: 'oai-adsbot.json',
    url: 'https://openai.com/adsbot.json',
    label: 'OpenAI OAI-AdsBot',
  },
  {
    file: 'chatgpt-connectors.json',
    url: 'https://openai.com/chatgpt-connectors.json',
    label: 'OpenAI ChatGPT integrations',
  },
  {
    file: 'perplexitybot.json',
    url: 'https://www.perplexity.com/perplexitybot.json',
    label: 'PerplexityBot',
  },
  {
    file: 'perplexity-user.json',
    url: 'https://www.perplexity.com/perplexity-user.json',
    label: 'Perplexity-User',
  },
  {
    file: 'google-user-triggered-agents.json',
    url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json',
    label: 'Google-Agent (user-triggered)',
  },
  {
    file: 'google-user-triggered-fetchers.json',
    url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json',
    label: 'Google user fetchers',
  },
  {
    file: 'parallel-shapbot.json',
    url: 'https://docs.parallel.ai/resources/shapbot.json',
    label: 'Parallel ShapBot',
  },
  {
    file: 'applebot.json',
    url: 'https://search.developer.apple.com/applebot.json',
    label: 'Applebot',
  },
  {
    file: 'ccbot.json',
    url: 'https://index.commoncrawl.org/ccbot.json',
    label: 'Common Crawl CCBot',
  },
  {
    file: 'duckduckbot.json',
    url: 'https://duckduckgo.com/duckduckbot.json',
    label: 'DuckDuckBot',
  },
  {
    file: 'duckassistbot.json',
    url: 'https://duckduckgo.com/duckassistbot.json',
    label: 'DuckAssistBot',
  },
  {
    file: 'mistral-ai-user.json',
    url: 'https://mistral.ai/mistralai-user-ips.json',
    label: 'MistralAI-User',
  },
  {
    file: 'mistral-ai-index.json',
    url: 'https://mistral.ai/mistralai-index-ips.json',
    label: 'MistralAI-Index',
  },
  {
    file: 'amazonbot.json',
    url: 'https://developer.amazon.com/amazonbot/ip-addresses/',
    label: 'Amazonbot',
    format: 'amazon-html',
  },
  {
    file: 'amzn-searchbot.json',
    url: 'https://developer.amazon.com/amazonbot/searchbot-ip-addresses/',
    label: 'Amzn-SearchBot',
    format: 'amazon-html',
  },
  {
    file: 'amzn-user.json',
    url: 'https://developer.amazon.com/amazonbot/live-ip-addresses/',
    label: 'Amzn-User',
    format: 'amazon-html',
  },
]

export interface FetchResult {
  source: Source
  ok: boolean
  prefixCount?: number
  changed?: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeHtmlCode(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function normalizeAmazonManifest(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.prefixes)) return value
  const prefixes = value.prefixes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Amazon prefixes[${index}] must be an object`)
    const candidate = entry.ipv4Prefix ?? entry.ipv6Prefix ?? entry.ip_prefix
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new Error(`Amazon prefixes[${index}] has no IP prefix`)
    }
    const raw = candidate.trim()
    const cidr = raw.includes('/')
      ? raw
      : (() => {
          const ip = parseIp(raw)
          if (!ip) return raw
          return `${raw}/${ip.version === 4 ? 32 : 128}`
        })()
    const parsed = parseCidr(cidr)
    if (!parsed) throw new Error(`Amazon prefixes[${index}] is not a valid IP prefix`)
    return parsed.version === 4 ? { ipv4Prefix: cidr } : { ipv6Prefix: cidr }
  })
  return { creationTime: value.creationTime, prefixes }
}

/** Decode one publisher response into the common fail-closed manifest shape. */
export function decodeSourcePayload(source: Source, body: string): unknown {
  if (source.format !== 'amazon-html') return JSON.parse(body)

  const blocks = body.matchAll(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi)
  for (const match of blocks) {
    try {
      const parsed = JSON.parse(decodeHtmlCode(match[1]!)) as unknown
      if (isRecord(parsed) && Object.hasOwn(parsed, 'creationTime') && Array.isArray(parsed.prefixes)) {
        return normalizeAmazonManifest(parsed)
      }
    } catch {
      // Keep scanning: Amazon pages can contain unrelated code examples.
    }
  }
  throw new Error('Amazon page did not contain a crawler IP manifest')
}

function sortedManifest(value: ValidatedIpRangeManifestPayload): ValidatedIpRangeManifestPayload {
  const prefixes = [...value.prefixes].sort((left, right) => {
    const leftKey = 'ipv4Prefix' in left ? `4:${left.ipv4Prefix}` : `6:${left.ipv6Prefix}`
    const rightKey = 'ipv4Prefix' in right ? `4:${right.ipv4Prefix}` : `6:${right.ipv6Prefix}`
    return leftKey.localeCompare(rightKey)
  })
  return { creationTime: value.creationTime, prefixes }
}

/**
 * Compare executable ranges, not volatile publisher metadata. This keeps a
 * weekly safety check from opening a PR when only `creationTime` or ordering
 * changed. A canonical source URL change still updates provenance.
 */
export function manifestNeedsUpdate(
  source: Source,
  current: unknown,
  next: ValidatedIpRangeManifestPayload,
): boolean {
  if (!isRecord(current) || current._source !== source.url) return true
  const validation = validateIpRangeManifestPayload(current)
  if (!validation.ok) return true
  return ipRangeManifestContentHash(validation.value) !== ipRangeManifestContentHash(next)
}

async function refreshOne(source: Source): Promise<FetchResult> {
  try {
    const res = await fetch(source.url, {
      headers: {
        // Some publishers (Bing) return a 403 to unidentified clients.
        // A vanilla `curl`-style UA gets through reliably.
        'User-Agent': 'canonry-ip-range-refresher/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return { source, ok: false, error: `HTTP ${res.status}` }
    }
    const validation = validateIpRangeManifestPayload(decodeSourcePayload(source, await res.text()))
    if (!validation.ok) return { source, ok: false, error: validation.error }
    const normalized = sortedManifest(validation.value)
    const target = path.join(rangesDir, source.file)
    let current: unknown = null
    try {
      current = JSON.parse(await fs.readFile(target, 'utf-8')) as unknown
    } catch {
      // Missing or invalid vendored data is replaced by the validated response.
    }
    if (!manifestNeedsUpdate(source, current, normalized)) {
      return { source, ok: true, prefixCount: normalized.prefixes.length, changed: false }
    }
    // Inject `_source` at the top of the file so anyone opening the
    // JSON directly sees where it came from. Re-injected on every
    // refresh because publishers strip unknown fields from their
    // payload — we don't want to lose this trail.
    const annotated = { _source: source.url, ...normalized }
    await fs.writeFile(target, JSON.stringify(annotated, null, 2) + '\n', 'utf-8')
    return { source, ok: true, prefixCount: normalized.prefixes.length, changed: true }
  } catch (err) {
    return {
      source,
      ok: false,
      error: describeError(err),
    }
  }
}

export async function runRefresh(
  sources: readonly Source[] = SOURCES,
  refresh: (source: Source) => Promise<FetchResult> = refreshOne,
  write: (message: string) => unknown = message => process.stderr.write(message),
): Promise<number> {
  write(`Refreshing ${sources.length} crawler IP-range files in ${rangesDir}\n\n`)
  // Run in parallel — publishers are independent and the script is
  // bounded by request latency, not local CPU.
  const results = await Promise.all(sources.map(refresh))
  let updated = 0
  let unchanged = 0
  let failed = 0
  for (const r of results) {
    if (r.ok) {
      if (r.changed === false) {
        unchanged++
        write(`  = ${r.source.label.padEnd(24)} ${r.source.file}  (${r.prefixCount} prefixes, unchanged)\n`)
      } else {
        updated++
        write(`  ✓ ${r.source.label.padEnd(24)} ${r.source.file}  (${r.prefixCount} prefixes)\n`)
      }
    } else {
      failed++
      write(`  ✗ ${r.source.label.padEnd(24)} ${r.source.file}  ${r.error}\n`)
    }
  }
  write(`\nDone. ${updated} updated, ${unchanged} unchanged, ${failed} failed.\n`)
  if (failed > 0) {
    write(`Failed sources kept their previous JSON — re-run when reachable.\n`)
  }
  return failed > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRefresh()
}
