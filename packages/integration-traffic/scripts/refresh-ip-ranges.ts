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
import type { IpRangePrefix, ParsedCidr, ValidatedIpRangeManifestPayload } from '../src/ip-range-manifest.js'
import { describeError } from '@canonry/canonry-contracts'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rangesDir = path.resolve(dirname, '..', 'src', 'ip-ranges')

interface SourceFields {
  /** Filename under `src/ip-ranges/`. Must match the import in `ip-verify.ts`. */
  file: string
  /** Publisher URL — the operator's canonical range list. */
  url: string
  /** Display label for the per-source progress line. */
  label: string
}

/**
 * Response decoder. Most publishers serve JSON; Amazon embeds it in HTML.
 * A SAIL file (TOML) lists several services' prefixes, so a SAIL source
 * names the service to read.
 */
export type Source =
  | SourceFields & { format?: 'json' | 'amazon-html'; sailService?: never }
  | SourceFields & { format: 'sail-toml'; sailService: string }

export const SOURCES: Source[] = [
  {
    file: 'anthropic.json',
    url: 'https://claude.com/crawling/bots.json',
    label: 'Anthropic Bots',
  },
  {
    file: 'claude-agent.json',
    url: 'https://claude.com/.well-known/sail',
    label: 'Anthropic Claude-Agent',
    format: 'sail-toml',
    sailService: 'Claude-Agent',
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

/** One publisher prefix as a manifest entry. A bare host address becomes /32 or /128. */
function prefixEntry(raw: string, where: string): IpRangePrefix {
  const ip = raw.includes('/') ? null : parseIp(raw)
  const cidr = ip ? `${raw}/${ip.version === 4 ? 32 : 128}` : raw
  const parsed = parseCidr(cidr)
  if (!parsed) throw new Error(`${where} is not a valid IP prefix`)
  return parsed.version === 4 ? { ipv4Prefix: cidr } : { ipv6Prefix: cidr }
}

function normalizeAmazonManifest(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.prefixes)) return value
  const prefixes = value.prefixes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Amazon prefixes[${index}] must be an object`)
    const candidate = entry.ipv4Prefix ?? entry.ipv6Prefix ?? entry.ip_prefix
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new Error(`Amazon prefixes[${index}] has no IP prefix`)
    }
    return prefixEntry(candidate.trim(), `Amazon prefixes[${index}]`)
  })
  return { creationTime: value.creationTime, prefixes }
}

/**
 * The SAIL draft this decoder reads (Anthropic's Claude-Agent egress list).
 * A new revision fails the refresh, so a person reads it before it is trusted.
 */
const SAIL_SCHEMA = 'draft-kelley-webbotauth-sail-00'

type SailValue = string | number | boolean | string[]
type SailTable = Map<string, SailValue>

interface SailDocument {
  root: SailTable
  /** `[[name]]` table arrays, in file order. */
  tables: Map<string, SailTable[]>
}

const TOML_BARE_KEY = /^[\w-]+$/
const TOML_TABLE_ARRAY = /^\[\[\s*([\w-]+)\s*\]\]$/
const TOML_INTEGER = /^[+-]?(?:0|[1-9](?:_?\d)*)$/
const TOML_DATETIME = /^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})?)?$/i
const TOML_ESCAPES = new Map([['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['"', '"'], ['\\', '\\']])

/**
 * Address space that is not globally reachable unicast (the IANA
 * special-purpose registries, plus multicast). Draft-00 §4.4.2 makes a SAIL
 * document that lists any of it invalid; vendored, it would verify every
 * request claiming the service from, say, a private address.
 */
const NON_GLOBAL_PREFIXES: readonly ParsedCidr[] = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '::/127', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64', '2001:2::/48', '2001:db8::/32', '3fff::/20',
  'fc00::/7', 'fe80::/10', 'ff00::/8',
].map((cidr) => {
  const parsed = parseCidr(cidr)
  if (!parsed) throw new Error(`invalid special-purpose prefix ${cidr}`)
  return parsed
})

/** Two same-family CIDR blocks either nest or are disjoint; they overlap when the broader mask agrees. */
function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.version !== b.version) return false
  const broader = a.mask < b.mask ? a.mask : b.mask
  return (a.network & broader) === (b.network & broader)
}

/** Whether `inner` lies inside `outer` and is strictly more specific. */
function cidrStrictlyInside(inner: ParsedCidr, outer: ParsedCidr): boolean {
  return inner.version === outer.version && inner.mask > outer.mask && (inner.network & outer.mask) === outer.network
}

/** TOML strings may hold a tab but no other control character. */
function isTomlControlChar(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0)
    return (code < 0x20 && code !== 0x09) || code === 0x7f
  })
}

/**
 * Walk `text` outside its TOML strings: `visit` sees each character that is
 * not inside a string and returns true to stop there. Returns that index, or -1.
 */
function scanOutsideStrings(text: string, visit: (char: string, index: number) => boolean): number {
  let quote: string | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote === '"' && char === '\\') {
      index++
    } else if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (visit(char, index)) {
      return index
    }
  }
  return -1
}

function withoutComment(line: string): string {
  const hash = scanOutsideStrings(line, char => char === '#')
  return hash === -1 ? line : line.slice(0, hash)
}

/**
 * A TOML basic string's value by TOML's own rules: the escapes \b \t \n \f \r
 * \" \\ \uXXXX \UXXXXXXXX, a raw tab but no other control character, and no
 * surrogate code point. Multi-line strings and anything else throw.
 */
function tomlBasicString(token: string, where: string): string {
  const unsupported = () => new Error(`${where}: unsupported string ${token}`)
  const end = token.length - 1
  if (end < 1 || token[end] !== '"') throw unsupported()
  let value = ''
  for (let index = 1; index < end; index++) {
    const char = token[index]!
    if (char === '"' || isTomlControlChar(char)) throw unsupported()
    if (char !== '\\') {
      value += char
      continue
    }
    index++
    const escape = index < end ? token[index]! : ''
    const simple = TOML_ESCAPES.get(escape)
    if (simple !== undefined) {
      value += simple
      continue
    }
    const width = escape === 'u' ? 4 : escape === 'U' ? 8 : 0
    const hex = token.slice(index + 1, index + 1 + width)
    if (width === 0 || index + width >= end || !/^[\da-f]+$/i.test(hex)) throw unsupported()
    const point = Number.parseInt(hex, 16)
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw unsupported()
    value += String.fromCodePoint(point)
    index += width
  }
  return value
}

/** A basic ("…") or literal ('…') TOML string's value, or null for any other token. */
function tomlString(token: string, where: string): string | null {
  if (token.startsWith('"')) return tomlBasicString(token, where)
  if (!token.startsWith("'")) return null
  const inner = token.slice(1, -1)
  if (token.length < 2 || !token.endsWith("'") || inner.includes("'") || isTomlControlChar(inner)) {
    throw new Error(`${where}: unsupported string ${token}`)
  }
  return inner
}

function tomlScalar(token: string, where: string): string | number | boolean {
  const text = tomlString(token, where)
  if (text !== null) return text
  if (token === 'true') return true
  if (token === 'false') return false
  if (TOML_INTEGER.test(token)) return Number(token.replaceAll('_', ''))
  if (TOML_DATETIME.test(token)) return token
  throw new Error(`${where}: unsupported value ${token}`)
}

/**
 * Parse the TOML subset a SAIL file uses: comments, `[[table]]` arrays, and
 * bare `key = value` pairs whose value is a string, boolean, integer,
 * datetime, or an array of strings that may span lines. Any other syntax
 * throws, so a format change fails the refresh instead of being misread.
 */
function parseSailToml(body: string): SailDocument {
  const root: SailTable = new Map()
  const tables = new Map<string, SailTable[]>()
  let current = root
  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const where = `SAIL line ${index + 1}`
    const line = withoutComment(lines[index]!).trim()
    if (!line) continue

    const header = TOML_TABLE_ARRAY.exec(line)
    if (header) {
      current = new Map<string, SailValue>()
      const list = tables.get(header[1]!) ?? []
      list.push(current)
      tables.set(header[1]!, list)
      continue
    }

    // Keys are bare, so the first `=` ends the key.
    const equals = line.indexOf('=')
    if (equals === -1) throw new Error(`${where}: unsupported syntax`)
    const key = line.slice(0, equals).trim()
    if (!TOML_BARE_KEY.test(key)) throw new Error(`${where}: unsupported syntax`)
    if (current.has(key)) throw new Error(`${where}: duplicate key ${key}`)
    let value = line.slice(equals + 1).trim()
    if (!value.startsWith('[')) {
      current.set(key, tomlScalar(value, where))
      continue
    }

    // An array may run over several lines and holds strings, never arrays.
    // Strings never span lines, so each new line is scanned on its own.
    const closeIn = (text: string, offset: number) => scanOutsideStrings(text, (char, at) => {
      if (char === '[' && offset + at > 0) throw new Error(`${where}: nested arrays are not supported`)
      return char === ']'
    })
    let end = closeIn(value, 0)
    while (end === -1 && index + 1 < lines.length) {
      index++
      const next = withoutComment(lines[index]!)
      const offset = value.length + 1
      value += `\n${next}`
      const close = closeIn(next, offset)
      if (close !== -1) end = offset + close
    }
    if (end === -1) throw new Error(`${where}: array ${key} is never closed`)
    if (value.slice(end + 1).trim()) throw new Error(`${where}: unexpected text after array ${key}`)
    const inner = value.slice(1, end)
    const items: string[] = []
    let start = 0
    scanOutsideStrings(inner, (char, at) => {
      if (char === ',') {
        items.push(inner.slice(start, at).trim())
        start = at + 1
      }
      return false
    })
    const last = inner.slice(start).trim()
    if (last) items.push(last)
    current.set(key, items.map((item) => {
      const text = tomlString(item, where)
      if (text === null) throw new Error(`${where}: array ${key} holds a value that is not a string`)
      return text
    }))
  }
  return { root, tables }
}

function sailStrings(table: SailTable, key: string, where: string): string[] {
  const value = table.get(key)
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${where}: ${key} must be an array of strings`)
  return value
}

/** SAIL identifiers (service and prefix-set names) compare ASCII-case-insensitively (draft-00 §4.3.1). */
function sameSailName(value: SailValue | undefined, name: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === name.toLowerCase()
}

interface SailPrefix {
  entry: IpRangePrefix
  cidr: ParsedCidr
  /** Family, network and mask: one key however the publisher spelled the prefix. */
  key: string
}

/** The prefixes one table lists itself, each a valid, globally reachable prefix of its key's family. */
function sailTablePrefixes(table: SailTable, label: string): SailPrefix[] {
  const prefixes: SailPrefix[] = []
  for (const [key, family] of [['ipv4_prefixes', 4], ['ipv6_prefixes', 6]] as const) {
    for (const raw of sailStrings(table, key, label)) {
      const where = `${label} ${key} entry ${raw}`
      const entry = prefixEntry(raw, where)
      const text = family === 4 ? entry.ipv4Prefix : entry.ipv6Prefix
      const cidr = text === undefined ? null : parseCidr(text)
      if (!cidr) throw new Error(`${where} is not IPv${family}`)
      if (NON_GLOBAL_PREFIXES.some((special) => cidrsOverlap(cidr, special))) {
        throw new Error(`${where} is not globally reachable unicast space`)
      }
      prefixes.push({ entry, cidr, key: `${cidr.version}:${cidr.network}:${cidr.mask}` })
    }
  }
  return prefixes
}

/**
 * Every prefix a service covers: those of the prefix sets it names, plus any
 * it lists itself, which draft-00 §4.3 treats as an anonymous set.
 */
function sailServicePrefixes(service: SailTable, sets: SailTable[], label: string): SailPrefix[] {
  const prefixes = sailTablePrefixes(service, label)
  for (const setName of sailStrings(service, 'prefix_sets', label)) {
    const matches = sets.filter((set) => sameSailName(set.get('name'), setName))
    if (matches.length !== 1) throw new Error(`SAIL prefix set ${setName} appears ${matches.length} times, not once`)
    prefixes.push(...sailTablePrefixes(matches[0]!, `SAIL prefix set ${setName}`))
  }
  return prefixes
}

/**
 * One SAIL service's prefixes in the common manifest shape; the file's
 * `modified` time is the publisher version. The whole document is checked,
 * because draft-00 says an invalid one is ignored entirely: a dangling
 * reference or a prefix outside global unicast space anywhere fails it.
 */
function decodeSailManifest(body: string, serviceName: string): unknown {
  const document = parseSailToml(body)
  const schema = document.root.get('schema')
  if (schema !== SAIL_SCHEMA) throw new Error(`SAIL schema ${String(schema)} is not ${SAIL_SCHEMA}`)
  const modified = document.root.get('modified')
  if (typeof modified !== 'string') throw new Error('SAIL file has no modified time')
  // A file without an expiry is invalid (draft-00 §4.3). Canonry does not act
  // on the expiry itself: it vendors this list and refreshes it weekly.
  if (!document.root.has('expires') && !document.root.has('expires_after')) {
    throw new Error('SAIL file has no expires or expires_after')
  }

  const sets = document.tables.get('prefix_sets') ?? []
  for (const set of sets) sailTablePrefixes(set, `SAIL prefix set ${String(set.get('name'))}`)
  const services = (document.tables.get('services') ?? []).map((table) => {
    const name = table.get('name')
    if (typeof name !== 'string') throw new Error('SAIL service has no name')
    return { name, prefixes: sailServicePrefixes(table, sets, `SAIL service ${name}`) }
  })
  const targets = services.filter((service) => sameSailName(service.name, serviceName))
  if (targets.length !== 1) throw new Error(`SAIL file lists service ${serviceName} ${targets.length} times, not once`)
  const target = targets[0]!
  if (target.prefixes.length === 0) throw new Error(`SAIL service ${serviceName} lists no prefixes`)

  // The longest listed prefix containing an address decides its services
  // (draft-00 §4.4.3). A more specific prefix that only another service lists
  // inside one of this service's would carve addresses out, which a flat
  // prefix list cannot express, so the refresh fails for a person to read.
  const targetKeys = new Set(target.prefixes.map((prefix) => prefix.key))
  for (const other of services) {
    if (other === target) continue
    const carveOut = other.prefixes.find((inner) => !targetKeys.has(inner.key)
      && target.prefixes.some((outer) => cidrStrictlyInside(inner.cidr, outer.cidr)))
    if (carveOut) {
      const prefix = carveOut.entry.ipv4Prefix ?? carveOut.entry.ipv6Prefix
      throw new Error(`SAIL service ${other.name} carves ${prefix} out of ${serviceName}'s ranges; carve-outs are not supported`)
    }
  }

  const unique = new Map(target.prefixes.map((prefix) => [prefix.key, prefix.entry]))
  return { creationTime: modified, prefixes: [...unique.values()] }
}

/** Decode one publisher response into the common fail-closed manifest shape. */
export function decodeSourcePayload(source: Source, body: string): unknown {
  if (source.format === 'sail-toml') return decodeSailManifest(body, source.sailService)
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
        Accept: source.format === 'sail-toml' ? 'application/sail+toml' : 'application/json',
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
