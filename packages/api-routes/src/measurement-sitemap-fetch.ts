import { isLocationRedirectStatus, compareText, sortedUnique as sortedUniqueUrls } from '@ainyc/canonry-contracts'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { blockedAddressReason, stripIpv6Brackets } from './egress-policy.js'
import type { SafeWebhookTarget, ResolveWebhookTargetResult } from './webhooks.js'

const gunzipAsync = promisify(gunzip)

export const DEFAULT_MEASUREMENT_SITEMAP_LIMITS = {
  timeoutMs: 10_000,
  // Large portfolios commonly publish one sitemap close to the 10k URL cap.
  // Keep the byte budget bounded, but large enough for those documents.
  maxBodyBytes: 5_000_000,
  maxDepth: 3,
  maxUrls: 10_000,
  maxSitemaps: 100,
  maxRedirects: 3,
} as const

export interface MeasurementSitemapHttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/**
 * This seam exists so every unit test can exercise the exact SSRF and redirect
 * control flow without opening a socket. Production callers use the pinned
 * Node transport below.
 */
export type MeasurementSitemapTransport = (
  target: SafeWebhookTarget,
  limits: Pick<MeasurementSitemapFetchLimits, 'timeoutMs' | 'maxBodyBytes'>,
) => Promise<MeasurementSitemapHttpResponse>

export interface MeasurementSitemapFetchLimits {
  timeoutMs: number
  maxBodyBytes: number
  maxDepth: number
  maxUrls: number
  maxSitemaps: number
  maxRedirects: number
}

export interface MeasurementSitemapAddress {
  address: string
  family: 4 | 6
}

/** The DNS seam. Injected in tests so every blocked address class is reachable without owning a domain. */
export type MeasurementSitemapAddressResolver = (hostname: string) => Promise<readonly MeasurementSitemapAddress[]>

export interface MeasurementSitemapFetchOptions {
  limits?: Partial<MeasurementSitemapFetchLimits>
  transport?: MeasurementSitemapTransport
  resolveTarget?: (url: string) => Promise<ResolveWebhookTargetResult>
  resolveAddresses?: MeasurementSitemapAddressResolver
}

export interface MeasurementSitemapFetchResult {
  urls: string[]
  fetchedSitemaps: number
}

/**
 * Adds the digest discovery keys its determinism on. Declared as an extension
 * rather than folded into `MeasurementSitemapFetchResult` so the injectable
 * `fetchSitemap` seam on the v1 discovery route keeps its narrower contract.
 */
export interface MeasurementSitemapDocument extends MeasurementSitemapFetchResult {
  /** sha256 over every decoded sitemap document, in visit order. Equal bytes, equal digest. */
  bytesChecksum: string
}

/**
 * Fetch a public sitemap under the egress policy in §0.4 of the Advanced
 * Measurement spec. Every request — the first one and every redirect hop — is
 * checked for scheme, embedded credentials and address class, then connected to
 * the exact address that was checked while retaining the original Host header
 * and TLS SNI name. The HTTP client never follows a redirect itself, because a
 * followed redirect is a request nobody validated.
 */
export async function fetchMeasurementSitemap(
  sitemapUrl: string,
  options: MeasurementSitemapFetchOptions = {},
): Promise<MeasurementSitemapDocument> {
  const limits = { ...DEFAULT_MEASUREMENT_SITEMAP_LIMITS, ...options.limits }
  assertLimits(limits)
  const resolveTarget = options.resolveTarget
    ?? ((url: string) => resolveMeasurementSitemapTarget(url, { resolveAddresses: options.resolveAddresses }))
  const transport = options.transport ?? requestPinnedSitemap
  const urls = new Set<string>()
  const visited = new Set<string>()
  const documents = crypto.createHash('sha256')
  const deadlineAt = Date.now() + limits.timeoutMs

  async function visit(rawUrl: string, depth: number): Promise<void> {
    assertBeforeDeadline(deadlineAt)
    if (depth > limits.maxDepth) throw new Error(`Sitemap nesting exceeds the maximum depth of ${limits.maxDepth}`)
    const sitemap = normalizeSitemapUrl(rawUrl)
    if (visited.has(sitemap)) return
    if (visited.size >= limits.maxSitemaps) throw new Error(`Sitemap count exceeds the maximum of ${limits.maxSitemaps}`)
    visited.add(sitemap)

    const response = await requestFollowingValidatedRedirects(sitemap, resolveTarget, transport, limits, deadlineAt)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sitemap request failed with HTTP ${response.status}`)
    }
    const xml = await decodeSitemapBody(response.body, response.headers, limits.maxBodyBytes)
    // Keyed by URL as well as content so two documents that swap places are a
    // different input, which is what makes a rerun's determinism checkable.
    documents.update(`${sitemap}\n`).update(xml)
    const sitemapIndex = /<(?:[\w-]+:)?sitemapindex\b/i.test(xml)
    const urlSet = /<(?:[\w-]+:)?urlset\b/i.test(xml)
    if (!sitemapIndex && !urlSet) throw new Error('Sitemap response is not a sitemap document')
    const childSitemaps = sitemapIndexLocations(xml)
    if (childSitemaps.length > 0) {
      for (const child of childSitemaps) await visit(child, depth + 1)
      return
    }
    for (const url of urlSetLocations(xml)) {
      if (urls.has(url)) continue
      if (urls.size >= limits.maxUrls) throw new Error(`Sitemap URL count exceeds the maximum of ${limits.maxUrls}`)
      urls.add(url)
    }
  }

  await visit(sitemapUrl, 0)
  return { urls: [...urls].sort(compareText), fetchedSitemaps: visited.size, bytesChecksum: documents.digest('hex') }
}

/**
 * The §0.4 pre-flight, in order: scheme, credentials, then every address the
 * hostname resolves to. It answers with the address that was checked, and that
 * address is what the transport dials — a second lookup can return a tailnet
 * answer, but nothing ever asks for one.
 *
 * Both this and `resolveWebhookTarget` classify addresses with the shared
 * egress policy (`egress-policy.ts`). This one never admits loopback and names
 * the refused address, because an operator reads its message to see why the
 * sitemap was refused.
 */
export async function resolveMeasurementSitemapTarget(
  rawUrl: string,
  options: { resolveAddresses?: MeasurementSitemapAddressResolver } = {},
): Promise<ResolveWebhookTargetResult> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, message: `${rawUrl} is not a valid URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `${parsed.protocol}// is not http or https` }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: 'a sitemap URL must not carry credentials' }
  }

  const hostname = stripIpv6Brackets(parsed.hostname)
  if (!hostname) return { ok: false, message: 'the URL has no hostname' }

  // An address literal is checked as itself and never handed to the resolver:
  // there is nothing to look up, and asking would let a resolver answer for it.
  const literalFamily = net.isIPv6(hostname) ? 6 : net.isIPv4(hostname) ? 4 : null
  const addresses: readonly MeasurementSitemapAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (options.resolveAddresses ?? resolveSitemapAddresses)(hostname)
  if (addresses.length === 0) return { ok: false, message: `${hostname} does not resolve` }

  for (const entry of addresses) {
    const reason = blockedAddressReason(entry.address)
    if (reason) return { ok: false, message: `${hostname} resolves to ${entry.address}, ${reason}` }
  }

  return { ok: true, target: { url: parsed, address: addresses[0]!.address, family: addresses[0]!.family } }
}

/**
 * `dns.resolve4`/`resolve6` rather than `dns.lookup`: the stub resolver a host
 * may be running answers from a cache this process cannot inspect, and the
 * whole point of the check is to see the same answer the socket will use.
 */
async function resolveSitemapAddresses(hostname: string): Promise<MeasurementSitemapAddress[]> {
  const [ipv4, ipv6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])
  const found = new Map<string, MeasurementSitemapAddress>()
  if (ipv4.status === 'fulfilled') for (const address of ipv4.value) found.set(`4:${address}`, { address, family: 4 })
  if (ipv6.status === 'fulfilled') for (const address of ipv6.value) found.set(`6:${address}`, { address, family: 6 })
  return [...found.values()]
}

async function requestFollowingValidatedRedirects(
  startUrl: string,
  resolveTarget: (url: string) => Promise<ResolveWebhookTargetResult>,
  transport: MeasurementSitemapTransport,
  limits: MeasurementSitemapFetchLimits,
  deadlineAt: number,
): Promise<MeasurementSitemapHttpResponse> {
  let current = startUrl
  for (let redirects = 0; ; redirects += 1) {
    const check = await beforeDeadline(() => resolveTarget(current), deadlineAt)
    if (!check.ok) throw new Error(`Sitemap URL rejected: ${check.message}`)
    const response = await beforeDeadline(() => transport(check.target, {
      timeoutMs: remainingTime(deadlineAt),
      maxBodyBytes: limits.maxBodyBytes,
    }), deadlineAt)
    if (!isLocationRedirectStatus(response.status)) return response
    if (redirects >= limits.maxRedirects) throw new Error(`Sitemap redirect count exceeds the maximum of ${limits.maxRedirects}`)
    const location = firstHeader(response.headers.location)
    if (!location) throw new Error('Sitemap redirect response has no Location header')
    try {
      current = new URL(location, check.target.url).href
    } catch {
      throw new Error('Sitemap redirect has an invalid Location header')
    }
  }
}

function remainingTime(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error('Sitemap fetch exceeded its operation deadline')
  return remaining
}

function assertBeforeDeadline(deadlineAt: number): void {
  remainingTime(deadlineAt)
}

async function beforeDeadline<T>(start: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = remainingTime(deadlineAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = start()
    const value = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Sitemap fetch exceeded its operation deadline')), remaining)
      }),
    ])
    assertBeforeDeadline(deadlineAt)
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The production transport. Exported so the header set and the streaming body
 * cap can be asserted against a real socket rather than through the injected
 * seam, which by construction cannot show what goes on the wire.
 *
 * It sends exactly three headers. No cookie jar, no Authorization, and none of
 * this instance's own auth headers: an operator-supplied URL is a stranger, and
 * a stranger is never handed a credential.
 */
export async function requestPinnedSitemap(
  target: SafeWebhookTarget,
  limits: Pick<MeasurementSitemapFetchLimits, 'timeoutMs' | 'maxBodyBytes'>,
): Promise<MeasurementSitemapHttpResponse> {
  const secure = target.url.protocol === 'https:'
  const port = target.url.port ? Number(target.url.port) : secure ? 443 : 80
  const requestOptions: https.RequestOptions = {
    hostname: target.address,
    family: target.family,
    port,
    method: 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: { Host: target.url.host, Accept: 'application/xml,text/xml,*/*;q=0.1', 'Accept-Encoding': 'gzip' },
  }
  if (secure) requestOptions.servername = stripIpv6Brackets(target.url.hostname)

  return await new Promise((resolve, reject) => {
    let settled = false
    const succeed = (response: MeasurementSitemapHttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(response)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reject(error)
    }
    const request = (secure ? https.request : http.request)(requestOptions, (response) => {
      const chunks: Buffer[] = []
      let byteLength = 0
      // An announced length over the cap is refused before a byte of it is
      // read; an unannounced one is cut off mid-stream below. Either way the
      // process never holds more than one chunk past the limit.
      const announced = Number(firstHeader(response.headers['content-length']))
      // The rejection is raised before the socket is torn down, because
      // destroying it first would surface as a generic truncation and hide
      // which cap was hit.
      const abortOverCap = () => {
        fail(new Error(`Sitemap body exceeds the maximum of ${limits.maxBodyBytes} bytes`))
        response.destroy()
      }
      if (Number.isFinite(announced) && announced > limits.maxBodyBytes) {
        abortOverCap()
        return
      }
      response.on('data', (chunk: Buffer) => {
        byteLength += chunk.length
        if (byteLength > limits.maxBodyBytes) {
          abortOverCap()
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => succeed({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('Sitemap response ended before completion')))
    })
    const deadline = setTimeout(
      () => request.destroy(new Error(`Sitemap request timed out after ${limits.timeoutMs}ms`)),
      limits.timeoutMs,
    )
    request.on('error', fail)
    request.end()
  })
}

async function decodeSitemapBody(body: Buffer, headers: http.IncomingHttpHeaders, maxBodyBytes: number): Promise<string> {
  const contentEncoding = firstHeader(headers['content-encoding'])?.toLowerCase()
  const gzipped = contentEncoding === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b)
  const bytes = gzipped ? await gunzipAsync(body, { maxOutputLength: maxBodyBytes }) : body
  if (bytes.length > maxBodyBytes) throw new Error(`Sitemap body exceeds the maximum of ${maxBodyBytes} bytes`)
  return new TextDecoder().decode(bytes)
}

function sitemapIndexLocations(xml: string): string[] {
  if (!hasXmlElement(xml, 'sitemapindex')) return []
  return sortedUniqueUrls(xmlElementContents(xml, 'sitemap').flatMap(extractLocation))
}

function urlSetLocations(xml: string): string[] {
  if (!hasXmlElement(xml, 'urlset')) return []
  return sortedUniqueUrls(xmlElementContents(xml, 'url').flatMap(extractLocation))
}

function extractLocation(xml: string): string[] {
  const value = xmlElementContents(xml, 'loc')[0]?.trim()
  return value ? [normalizeSitemapUrl(decodeXmlEntities(value))] : []
}

/**
 * Purpose-built, non-validating XML tag scanner. It deliberately reads only
 * the sitemap element names we need and never applies an unbounded regular
 * expression to network input. Sitemap XML is small and this transport's body
 * cap keeps the scan linear and bounded.
 */
function hasXmlElement(xml: string, elementName: string): boolean {
  for (let offset = 0; ; ) {
    const tag = nextXmlTag(xml, offset)
    if (!tag) return false
    if (!tag.closing && tag.localName === elementName) return true
    offset = tag.end
  }
}

function xmlElementContents(xml: string, elementName: string): string[] {
  const contents: string[] = []
  let depth = 0
  let contentStart = -1
  for (let offset = 0; ; ) {
    const tag = nextXmlTag(xml, offset)
    if (!tag) return contents
    if (tag.localName === elementName) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0 && contentStart >= 0) {
          contents.push(xml.slice(contentStart, tag.start))
          contentStart = -1
        }
      } else if (!tag.selfClosing) {
        if (depth === 0) contentStart = tag.end
        depth += 1
      }
    }
    offset = tag.end
  }
}

interface XmlTag {
  start: number
  end: number
  localName: string
  closing: boolean
  selfClosing: boolean
}

function nextXmlTag(xml: string, from: number): XmlTag | null {
  const start = xml.indexOf('<', from)
  if (start < 0) return null
  if (xml.startsWith('<!--', start)) {
    const endComment = xml.indexOf('-->', start + 4)
    return endComment < 0 ? null : nextXmlTag(xml, endComment + 3)
  }
  if (xml.startsWith('<![CDATA[', start)) {
    const endCdata = xml.indexOf(']]>', start + 9)
    return endCdata < 0 ? null : nextXmlTag(xml, endCdata + 3)
  }
  if (xml.startsWith('<?', start) || xml.startsWith('<!', start)) {
    const endDeclaration = xml.indexOf('>', start + 2)
    return endDeclaration < 0 ? null : nextXmlTag(xml, endDeclaration + 1)
  }
  const end = xml.indexOf('>', start + 1)
  if (end < 0) return null
  let nameOffset = start + 1
  while (xml[nameOffset] === ' ' || xml[nameOffset] === '\t' || xml[nameOffset] === '\r' || xml[nameOffset] === '\n') nameOffset += 1
  const closing = xml[nameOffset] === '/'
  if (closing) nameOffset += 1
  while (xml[nameOffset] === ' ' || xml[nameOffset] === '\t' || xml[nameOffset] === '\r' || xml[nameOffset] === '\n') nameOffset += 1
  const nameEnd = (() => {
    let index = nameOffset
    while (index < end && !isTagNameSeparator(xml[index]!)) index += 1
    return index
  })()
  const fullName = xml.slice(nameOffset, nameEnd)
  const localName = fullName.slice(fullName.lastIndexOf(':') + 1).toLowerCase()
  return { start, end: end + 1, localName, closing, selfClosing: !closing && xml.slice(start, end).trimEnd().endsWith('/') }
}

function isTagNameSeparator(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '/' || value === '>'
}

/**
 * Scheme and credential checks are stated twice on purpose: here they also
 * cover the `<loc>` values inside a document, which are never fetched but do
 * reach the caller, and in the resolver they cover every redirect hop, which
 * never passes through this function.
 */
function normalizeSitemapUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Sitemap URL rejected: ${value} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Sitemap URL rejected: ${value} does not use http or https`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Sitemap URL rejected: ${value} carries credentials`)
  }
  return parsed.href
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!)
}



function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function assertLimits(limits: MeasurementSitemapFetchLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Sitemap ${name} must be a positive safe integer`)
  }
}
