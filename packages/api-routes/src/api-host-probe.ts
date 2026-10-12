import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { blockedAddressReason, isLoopbackAddress } from './egress-policy.js'

export type ApiHostProbeKind = 'reachable' | 'null-routed' | 'private-address' | 'no-address' | 'resolver-unavailable' | 'connect-failed' | 'tls-failed'

export interface ApiHostProbeResult {
  kind: ApiHostProbeKind
  host: string
  addresses: string[]
  code?: string
  durationMs: number
}

export interface ApiHostProbeOptions {
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>
  connect?: (host: string, address: string, timeoutMs: number) => Promise<'reachable' | 'connect-failed' | 'tls-failed'>
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
}

function isTlsProbeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code ?? ''
  return code === 'ECONNRESET'
    || code.startsWith('ERR_SSL_')
    || code.startsWith('ERR_TLS_')
    || code.startsWith('CERT_')
    || code.startsWith('UNABLE_TO_VERIFY_')
    || code.startsWith('SELF_SIGNED_')
    || code.startsWith('DEPTH_ZERO_')
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; result: ApiHostProbeResult }>()
const inFlight = new Map<string, Promise<ApiHostProbeResult>>()

export function resetApiHostProbeCacheForTest(): void {
  cache.clear()
  inFlight.clear()
}

function defaultLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(host, { all: true })
}

function defaultConnect(host: string, address: string, timeoutMs: number): Promise<'reachable' | 'connect-failed' | 'tls-failed'> {
  return new Promise(resolve => {
    const socket = tls.connect({ host: address, port: 443, servername: host, timeout: timeoutMs, rejectUnauthorized: true })
    let settled = false
    const finish = (result: 'reachable' | 'connect-failed' | 'tls-failed') => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('secureConnect', () => finish('reachable'))
    socket.once('timeout', () => finish('connect-failed'))
    socket.once('error', error => {
      finish(isTlsProbeError(error) ? 'tls-failed' : 'connect-failed')
    })
  })
}

async function lookupWithDeadline(
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>,
  host: string,
  timeoutMs: number,
): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('lookup timeout'), { code: 'ETIMEDOUT' })), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function classifyBlocked(address: string): 'null-routed' | 'private-address' | null {
  const normalized = address.toLowerCase()
  if (normalized === '::' || isLoopbackAddress(address) || blockedAddressReason(address) === 'which is unspecified space') return 'null-routed'
  if (blockedAddressReason(address)) return 'private-address'
  return null
}

async function probeApiHostUncached(host: string, options: ApiHostProbeOptions): Promise<ApiHostProbeResult> {
  const now = options.now ?? Date.now
  const cached = cache.get(host)
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (cached && now() - cached.at < ttl) return cached.result
  const started = now()
  const lookup = options.lookup ?? defaultLookup
  const connect = options.connect ?? defaultConnect
  let records: Array<{ address: string; family: number }>
  try {
    records = await lookupWithDeadline(lookup, host, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const kind: ApiHostProbeKind = code === 'ENOTFOUND' || code === 'ENODATA' ? 'no-address' : 'resolver-unavailable'
    const result = { kind, host, addresses: [], code, durationMs: now() - started }
    return result
  }
  const addresses = records.map(record => record.address)
  const publicAddresses = records.filter(record => net.isIP(record.address) > 0 && !classifyBlocked(record.address)).slice(0, 2)
  const blocked = records.map(record => classifyBlocked(record.address)).find(Boolean)
  if (publicAddresses.length === 0) {
    const result: ApiHostProbeResult = { kind: blocked ?? 'no-address', host, addresses, durationMs: now() - started }
    return result
  }
  const attempts = await Promise.all(publicAddresses.map(async record => {
    try {
      return await connect(host, record.address, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    } catch (error) {
      return isTlsProbeError(error) ? 'tls-failed' as const : 'connect-failed' as const
    }
  }))
  const kind: ApiHostProbeKind = attempts.includes('reachable') ? 'reachable' : attempts.includes('tls-failed') ? 'tls-failed' : 'connect-failed'
  const result = { kind, host, addresses, durationMs: now() - started }
  if (kind === 'reachable') cache.set(host, { at: now(), result })
  return result
}

export async function probeApiHost(host: string, options: ApiHostProbeOptions = {}): Promise<ApiHostProbeResult> {
  const now = options.now ?? Date.now
  const cached = cache.get(host)
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (cached && now() - cached.at < ttl) return cached.result
  const pending = inFlight.get(host)
  if (pending) return pending
  const current = probeApiHostUncached(host, options)
  inFlight.set(host, current)
  try {
    return await current
  } finally {
    if (inFlight.get(host) === current) inFlight.delete(host)
  }
}
