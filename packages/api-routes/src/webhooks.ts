import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const REQUEST_TIMEOUT_MS = 10_000

export interface SafeWebhookTarget {
  url: URL
  address: string
  family: 4 | 6
}

export type ResolveWebhookTargetResult =
  | { ok: true; target: SafeWebhookTarget }
  | { ok: false; message: string }

export async function resolveWebhookTarget(raw: string): Promise<ResolveWebhookTargetResult> {
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

  const addresses = await resolveHostAddresses(lookupHost)
  if (addresses.length === 0) {
    return { ok: false, message: '"url" hostname could not be resolved' }
  }

  const blocked = addresses.find((entry) => isBlockedAddress(entry.address))
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

async function resolveHostAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const family = net.isIP(hostname)
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }]
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true })
    const unique = new Map<string, { address: string; family: 4 | 6 }>()
    for (const record of records) {
      if (record.family !== 4 && record.family !== 6) continue
      unique.set(`${record.family}:${record.address}`, {
        address: record.address,
        family: record.family,
      })
    }
    return [...unique.values()]
  } catch {
    return []
  }
}

function isBlockedAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase()
  const family = net.isIP(normalized)

  if (family === 4) {
    return isBlockedIpv4(normalized)
  }

  if (family === 6) {
    const mappedIpv4 = extractMappedIpv4(normalized)
    if (mappedIpv4) {
      return isBlockedIpv4(mappedIpv4)
    }
    return isBlockedIpv6(normalized)
  }

  return true
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(Number.isNaN)) {
    return true
  }

  const [first, second] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.split('%')[0]!.toLowerCase()
  if (normalized === '::' || normalized === '::1') {
    return true
  }

  const firstHextetText = normalized.split(':')[0] ?? ''
  const firstHextet = firstHextetText === '' ? 0 : Number.parseInt(firstHextetText, 16)
  if (Number.isNaN(firstHextet)) {
    return true
  }

  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  )
}

function extractMappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase()
  if (!normalized.startsWith('::ffff:')) {
    return null
  }

  const remainder = normalized.slice('::ffff:'.length)
  if (net.isIP(remainder) === 4) {
    return remainder
  }

  const parts = remainder.split(':')
  if (parts.length !== 2 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null
  }

  const high = Number.parseInt(parts[0]!, 16)
  const low = Number.parseInt(parts[1]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}
