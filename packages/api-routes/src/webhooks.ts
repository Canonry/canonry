import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { blockedAddressReason, stripIpv6Brackets } from './egress-policy.js'

const REQUEST_TIMEOUT_MS = 10_000

export interface SafeWebhookTarget {
  url: URL
  address: string
  family: 4 | 6
  /**
   * Every address the name resolved to, all checked, in the order to try
   * them; `address` is the first. A caller that can fall back to the next
   * address when one does not answer dials from this list.
   */
  addresses?: ReadonlyArray<{ address: string; family: 4 | 6 }>
}

export type ResolveWebhookTargetResult =
  | { ok: true; target: SafeWebhookTarget }
  /**
   * `unresolved` marks a name with no address: nothing was refused, the target
   * could not be found. `blocked` marks an address the egress policy refused.
   */
  | { ok: false; message: string; unresolved?: true; blocked?: true }

export interface ResolveWebhookTargetOptions {
  /**
   * Allow loopback addresses (127.0.0.0/8 and ::1, including IPv4-mapped forms).
   * Defaults to false — loopback is blocked by default so a cloud deployment
   * cannot be coerced into reaching its own host services (metadata proxies,
   * Redis/Vault, sidecar admin endpoints). Local servers can opt in to preserve
   * dev workflows that point webhooks at localhost.
   */
  allowLoopback?: boolean
  /** The DNS seam. Injected in tests so every blocked address class is reachable without owning a domain. */
  resolveAddresses?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>
}

export async function resolveWebhookTarget(
  raw: string,
  options: ResolveWebhookTargetOptions = {},
): Promise<ResolveWebhookTargetResult> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, message: '"url" must be a valid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: '"url" must use http or https scheme' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, message: '"url" must not include credentials' }
  }

  const lookupHost = stripIpv6Brackets(parsed.hostname)
  if (!lookupHost) {
    return { ok: false, message: '"url" must include a hostname' }
  }

  const addresses = await resolveHostAddresses(lookupHost, options.resolveAddresses)
  if (addresses.length === 0) {
    return { ok: false, message: '"url" hostname could not be resolved', unresolved: true }
  }

  const blocked = addresses.find((entry) => isBlockedAddress(entry.address, options))
  if (blocked) {
    return { ok: false, message: '"url" must not resolve to a private or loopback address', blocked: true }
  }

  return {
    ok: true,
    target: {
      url: parsed,
      address: addresses[0]!.address,
      family: addresses[0]!.family,
      addresses,
    },
  }
}

/**
 * What one delivery attempt established. `requestSent` is false when the
 * request never fully reached the network (DNS, connect or TLS failure, or a
 * timeout before the body was written), so the receiver cannot have acted on
 * it and a retry cannot duplicate it.
 */
export interface WebhookDeliveryResult {
  status: number
  error: string | null
  timedOut?: true
  requestSent: boolean
  /** How long the receiver asked us to wait (`Retry-After`), in seconds. */
  retryAfterSeconds?: number
}

/** `Retry-After` as seconds from now: delta seconds or an HTTP date, at most a day. */
function retryAfterSeconds(header: string | string[] | undefined, now = Date.now()): number | null {
  const value = (Array.isArray(header) ? header[0] : header)?.trim()
  if (!value) return null
  const seconds = /^\d+$/u.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.ceil(seconds), 86_400) : null
}

export async function deliverWebhook(
  target: SafeWebhookTarget,
  payload: unknown,
  webhookSecret: string | null,
): Promise<WebhookDeliveryResult> {
  const body = JSON.stringify(payload)
  const isHttps = target.url.protocol === 'https:'
  const port = target.url.port ? Number(target.url.port) : (isHttps ? 443 : 80)
  const path = `${target.url.pathname}${target.url.search}`
  const headers: Record<string, string> = {
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json',
    'Host': target.url.host,
    'User-Agent': 'Canonry/0.1.0',
  }

  if (webhookSecret) {
    headers['X-Canonry-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(body).digest('hex')
  }
  // A stable event identity lets a receiver deduplicate retries; the v2
  // signature binds a timestamp so a captured request cannot be replayed later.
  const eventId = payload && typeof payload === 'object' ? (payload as { eventId?: unknown }).eventId : undefined
  if (typeof eventId === 'string' && /^evt_[a-f0-9]{64}$/u.test(eventId)) {
    headers['X-Canonry-Event-Id'] = eventId
    headers['Idempotency-Key'] = eventId
    if (webhookSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      headers['X-Canonry-Timestamp'] = timestamp
      headers['X-Canonry-Signature-V2'] = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex')
    }
  }

  return await new Promise((resolve) => {
    // `autoSelectFamily` is a socket option: http.request hands it to net.connect.
    const requestOptions: https.RequestOptions & Pick<net.TcpNetConnectOpts, 'autoSelectFamily'> = {
      // A connection of its own: a shared agent pools by hostname, so it could
      // hand this request a socket some other caller dialed unchecked.
      agent: false,
      // Dial the checked addresses, falling back from one to the next, so a
      // receiver that listens on only one of them (`localhost` checks as
      // 127.0.0.1 and ::1) still gets the delivery.
      autoSelectFamily: true,
      lookup: pinnedLookup(checkedAddresses(target)),
      headers,
      hostname: stripIpv6Brackets(target.url.hostname),
      method: 'POST',
      path,
      port,
      timeout: REQUEST_TIMEOUT_MS,
    }

    if (isHttps) {
      requestOptions.servername = stripIpv6Brackets(target.url.hostname)
    }

    const request = (isHttps ? https.request : http.request)(requestOptions, (response) => {
      response.resume()
      response.on('end', () => {
        const retryAfter = retryAfterSeconds(response.headers['retry-after'])
        resolve({
          status: response.statusCode ?? 0,
          error: null,
          requestSent: true,
          ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
        })
      })
    })

    // 'finish' fires once the whole request is handed to the network. Before
    // that the receiver cannot have the complete body.
    let requestSent = false
    request.on('finish', () => { requestSent = true })

    let timedOut = false
    request.on('timeout', () => {
      timedOut = true
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })

    request.on('error', (error) => {
      resolve({ status: 0, error: error.message, ...(timedOut ? { timedOut: true as const } : {}), requestSent })
    })

    request.end(body)
  })
}

/** Every address the target's check admitted, in the order to try them. */
export function checkedAddresses(target: SafeWebhookTarget): ReadonlyArray<{ address: string; family: 4 | 6 }> {
  return target.addresses ?? [{ address: target.address, family: target.family }]
}

/**
 * A `lookup` that answers with the checked addresses whatever the resolver
 * says now, so a connection dials only what the policy admitted. Node does not
 * call it for an IP-literal host, which is safe: a literal is checked as
 * itself, so it is the checked address.
 */
export function pinnedLookup(addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>): net.LookupFunction {
  return (_hostname, options, callback) => {
    // With `autoSelectFamily` Node asks with `{ all: true }` and expects an
    // array of `{ address, family }` rather than one address.
    if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })))
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  }
}

const LOCALHOST_ADDRESSES = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }] as const

function isLocalhostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
}

async function resolveHostAddresses(
  hostname: string,
  resolveAddresses: ResolveWebhookTargetOptions['resolveAddresses'],
): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  const family = net.isIP(hostname)
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }]
  }
  // `localhost` and every name under it are loopback by definition (RFC 6761
  // §6.3) and never go to DNS. The queries below do not read the hosts file,
  // so without this `localhost` does not resolve at all on some hosts (macOS)
  // and resolves on others. The policy still refuses loopback unless
  // `allowLoopback` admits it.
  if (isLocalhostName(hostname)) return LOCALHOST_ADDRESSES
  if (resolveAddresses) return await resolveAddresses(hostname)

  try {
    // Use dns.resolve4/dns.resolve6 instead of dns.lookup to bypass
    // stub resolvers (e.g. systemd-resolved) that may time out for
    // external CDN domains.
    const [ipv4, ipv6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])
    const unique = new Map<string, { address: string; family: 4 | 6 }>()

    if (ipv4.status === 'fulfilled') {
      for (const address of ipv4.value) {
        unique.set(`4:${address}`, { address, family: 4 })
      }
    }
    if (ipv6.status === 'fulfilled') {
      for (const address of ipv6.value) {
        unique.set(`6:${address}`, { address, family: 6 })
      }
    }

    return [...unique.values()]
  } catch {
    return []
  }
}

function isBlockedAddress(address: string, options: ResolveWebhookTargetOptions): boolean {
  return blockedAddressReason(address, { allowLoopback: options.allowLoopback }) !== null
}

/** Verify before parsing/side effects, then atomically deduplicate the event ID at the receiver. */
export function verifyCanonryWebhook(
  body: string,
  secret: string,
  headers: { timestamp?: string; signature?: string; eventId?: string },
  now = Date.now(),
): boolean {
  if (
    !secret
    || Buffer.byteLength(body) > 512 * 1024
    || !/^\d{10}$/u.test(headers.timestamp ?? '')
    || !/^sha256=[a-f0-9]{64}$/u.test(headers.signature ?? '')
    || !/^evt_[a-f0-9]{64}$/u.test(headers.eventId ?? '')
  ) return false
  if (Math.abs(now - Number(headers.timestamp) * 1000) > 300_000) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${headers.timestamp}.${body}`).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headers.signature!))) return false
  try {
    return (JSON.parse(body) as { eventId?: unknown }).eventId === headers.eventId
  } catch {
    return false
  }
}
