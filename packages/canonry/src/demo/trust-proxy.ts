import { isIP } from 'node:net'

/** A reverse proxy on the same machine as the demo listener. */
export const DEFAULT_DEMO_TRUSTED_PROXIES: readonly string[] = Object.freeze(['127.0.0.1', '::1'])

/**
 * Why a value cannot name a proxy whose X-Forwarded-For the demo believes, or
 * null for a plain IP address or CIDR range. Names such as "loopback", zone
 * ids and lists are refused so the flag means exactly what it says.
 */
export function trustedProxyProblem(value: string): string | null {
  const slash = value.indexOf('/')
  const address = slash === -1 ? value : value.slice(0, slash)
  const prefix = slash === -1 ? null : value.slice(slash + 1)
  const family = address.includes('%') ? 0 : isIP(address)
  if (family === 0 || (prefix !== null && !/^(?:0|[1-9]\d{0,2})$/.test(prefix))) {
    return 'must be an IP address or CIDR range, such as 10.0.0.5 or 10.0.0.0/24'
  }
  if (prefix === null) return null
  const maxBits = family === 4 ? 32 : 128
  if (Number(prefix) > maxBits) return `has a prefix longer than ${maxBits} bits`
  if (Number(prefix) === 0) {
    return "would trust every address, letting any visitor choose the address the rate limit counts. Name the proxy's own address or range"
  }
  return null
}
