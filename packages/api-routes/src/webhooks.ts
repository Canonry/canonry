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
}

export type ResolveWebhookTargetResult =
  | { ok: true; target: SafeWebhookTarget }
  | { ok: false; message: string }

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
    return { ok: false, message: '"url" hostname could not be resolved' }
  }

  const blocked = addresses.find((entry) => isBlockedAddress(entry.address, options))
  if (blocked) {
    return { ok: false, message: '"url" must not resolve to a private or loopback address' }
  }

  return {
    ok: true,
    target: {
      url: parsed,
      address: addresses[0]!.address,
      family: addresses[0]!.family,
    },
  }
}

export async function deliverWebhook(
  target: SafeWebhookTarget,
  payload: unknown,
  webhookSecret: string | null,
): Promise<{ status: number; error: string | null }> {
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

  return await new Promise((resolve) => {
    const requestOptions: https.RequestOptions = {
      family: target.family,
      headers,
      hostname: target.address,
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
        resolve({ status: response.statusCode ?? 0, error: null })
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })

    request.on('error', (error) => {
      resolve({ status: 0, error: error.message })
    })

    request.end(body)
  })
}

async function resolveHostAddresses(
  hostname: string,
  resolveAddresses: ResolveWebhookTargetOptions['resolveAddresses'],
): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  const family = net.isIP(hostname)
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }]
  }
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
