import { isIP } from 'node:net'

/** A reverse proxy on the same machine as the demo listener. */
export const DEFAULT_DEMO_TRUSTED_PROXIES: readonly string[] = Object.freeze(['127.0.0.1', '::1'])

// Fastify matches an IPv4 peer against an IPv6 range through the peer's
// IPv4-mapped form (::ffff:a.b.c.d), and an IPv4 range against a mapped IPv6
// peer. Measuring every range in one 128-bit space, with IPv4 at ::ffff:0:0/96,
// judges a range by the peers it trusts rather than by how it is spelled.
const IPV4_FIRST = 0xffffn << 32n
const IPV4_LAST = IPV4_FIRST + (1n << 32n) - 1n
const LAST_ADDRESS = (1n << 128n) - 1n

interface AddressRange { first: bigint; last: bigint }

function ipv4Value(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) + BigInt(octet), 0n)
}

/** The 128-bit value of IPv6 text that node:net has already validated. */
function ipv6Value(address: string): bigint {
  const dotted = /^(?<head>.*:)(?<ipv4>\d+\.\d+\.\d+\.\d+)$/.exec(address)?.groups
  let text = address
  if (dotted) {
    const ipv4 = ipv4Value(dotted.ipv4!)
    text = `${dotted.head}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const groups = (part: string) => (part ? part.split(':') : [])
  const zeros = tail === undefined ? [] : Array<string>(8 - groups(head).length - groups(tail).length).fill('0')
  return [...groups(head), ...zeros, ...groups(tail ?? '')]
    .reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n)
}

function parseTrustedProxy(value: string): AddressRange | string {
  const slash = value.indexOf('/')
  const address = slash === -1 ? value : value.slice(0, slash)
  const prefix = slash === -1 ? null : value.slice(slash + 1)
  const family = address.includes('%') ? 0 : isIP(address)
  if (family === 0 || (prefix !== null && !/^(?:0|[1-9]\d{0,2})$/.test(prefix))) {
    return 'must be an IP address or CIDR range, such as 10.0.0.5 or 10.0.0.0/24'
  }
  const maxBits = family === 4 ? 32 : 128
  const bits = prefix === null ? maxBits : Number(prefix)
  if (bits > maxBits) return `has a prefix longer than ${maxBits} bits`
  const hostBits = BigInt(maxBits - bits)
  const start = family === 4 ? IPV4_FIRST + ipv4Value(address) : ipv6Value(address)
  const first = (start >> hostBits) << hostBits
  return { first, last: first + (1n << hostBits) - 1n }
}

/** Whether the ranges, taken together, contain every address from first to last. */
function covers(ranges: readonly AddressRange[], first: bigint, last: bigint): boolean {
  let next = first
  for (const range of [...ranges].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))) {
    if (range.first > next) return false
    if (range.last >= next) next = range.last + 1n
    if (next > last) return true
  }
  return false
}

function catchAllProblem(ranges: readonly AddressRange[]): string | null {
  const everyIPv4 = covers(ranges, IPV4_FIRST, IPV4_LAST)
  const everyIPv6 = covers(ranges, 0n, IPV4_FIRST - 1n) && covers(ranges, IPV4_LAST + 1n, LAST_ADDRESS)
  if (!everyIPv4 && !everyIPv6) return null
  const scope = everyIPv4 && everyIPv6 ? 'every address' : everyIPv4 ? 'every IPv4 address' : 'every IPv6 address'
  return `would trust ${scope}, letting any visitor choose the address the rate limit counts. Name the proxy's own address or range`
}

/**
 * Why a value cannot name a proxy whose X-Forwarded-For the demo believes, or
 * null for a plain IP address or CIDR range. Names such as "loopback", zone
 * ids and lists are refused so the flag means exactly what it says. So is a
 * range that contains every IPv4 or every IPv6 address, in any spelling.
 */
export function trustedProxyProblem(value: string): string | null {
  const range = parseTrustedProxy(value)
  return typeof range === 'string' ? range : catchAllProblem([range])
}

/**
 * Why values that each pass trustedProxyProblem cannot be trusted together,
 * or null. Ranges such as 0.0.0.0/1 and 128.0.0.0/1 are each narrow but
 * together trust every IPv4 address.
 */
export function trustedProxiesProblem(values: readonly string[]): string | null {
  const ranges = values.map(parseTrustedProxy).filter((range): range is AddressRange => typeof range !== 'string')
  return catchAllProblem(ranges)
}
