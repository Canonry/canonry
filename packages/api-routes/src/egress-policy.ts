import net from 'node:net'

/**
 * The one outbound address policy. Every gate that dials a URL this instance
 * did not choose itself classifies each resolved address here, so a range is
 * refused everywhere or nowhere. Add a range here, never in a caller.
 *
 * Classification reads the address as bytes, so every spelling of the same
 * address (hex or dotted IPv4 tail, compressed or not, with a zone id) lands
 * on the same rule.
 *
 * The documentation ranges (the IPv4 TEST-NETs, 2001:db8::/32, 3fff::/20) are
 * deliberately dialable: nothing routes them, so refusing them protects
 * nothing, and fixtures use them as stand-ins for public addresses.
 */

/**
 * Null when the address is safe to dial; otherwise the phrase that completes
 * the rejection message. `allowLoopback` admits loopback by its bytes (127/8,
 * ::1 and IPv4-mapped 127/8) and nothing else: a loopback address spelled
 * through a translation prefix, the unspecified address and link-local space
 * stay refused.
 */
export function blockedAddressReason(value: string, options: { allowLoopback?: boolean } = {}): string | null {
  const address = stripZoneId(stripIpv6Brackets(value))
  if (options.allowLoopback && isLoopbackAddress(address)) return null
  const family = net.isIP(address)
  if (family === 4) return blockedIpv4Reason(ipv4Octets(address))
  if (family === 6) {
    const bytes = ipv6Bytes(address)
    return bytes ? blockedIpv6Reason(bytes) : 'which could not be read as an address'
  }
  return 'which is not an IP address'
}

/** True for 127.0.0.0/8, ::1 and ::ffff:127.0.0.0/104, decided by the address bytes. */
export function isLoopbackAddress(value: string): boolean {
  const address = stripZoneId(stripIpv6Brackets(value))
  const family = net.isIP(address)
  if (family === 4) return ipv4Octets(address)[0] === 127
  if (family !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  const mapped = mappedIpv4(bytes)
  if (mapped) return mapped[0] === 127
  return bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
}

export function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

/**
 * A resolver may answer with a zone id attached, and `net.isIPv6` accepts one
 * that contains colons. Left on, that text is read as further address groups
 * and shifts the bytes the prefix rules inspect.
 */
function stripZoneId(address: string): string {
  return address.split('%')[0]!
}

function ipv4Octets(address: string): number[] {
  return address.split('.').map(part => Number.parseInt(part, 10))
}

function blockedIpv4Reason(octets: readonly number[]): string | null {
  const [first, second] = octets as [number, number, number, number]
  if (first === 0) return 'which is unspecified space'
  if (first === 127) return 'which is loopback'
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return 'which is private space'
  }
  if (first === 100 && second >= 64 && second <= 127) return 'which is carrier-grade NAT space'
  if (first === 169 && second === 254) return 'which is link-local'
  if (first >= 224 && first <= 239) return 'which is multicast'
  // 192.0.0.0/24 is IETF protocol assignments, 198.18.0.0/15 is benchmarking
  // and 240.0.0.0/4 is reserved, broadcast included.
  if ((first === 192 && second === 0 && octets[2] === 0) || (first === 198 && (second === 18 || second === 19)) || first >= 240) {
    return 'which is reserved'
  }
  return null
}

function blockedIpv6Reason(bytes: Uint8Array): string | null {
  const first = bytes[0]!
  if (first === 0x00) {
    // 64:ff9b::/96 is where DNS64 puts an IPv4-only host's address, so an
    // IPv6-only network reaches every public IPv4 site through it. The IPv4
    // address it carries is judged by the IPv4 rules, loopback included.
    const nat64 = nat64Ipv4(bytes)
    if (nat64) return blockedIpv4Reason(nat64) === null ? null : `which is the NAT64 form of ${nat64.join('.')}`
    // The rest of ::/8 holds the unspecified and loopback addresses, the
    // IPv4-mapped, IPv4-compatible and IPv4-translated forms, and the
    // local-use NAT64 prefix 64:ff9b:1::/48, which carries a network's own
    // translator. Nothing globally routable lives there, so the whole block is
    // refused rather than each spelling of the same internal address being
    // chased individually.
    const mapped = mappedIpv4(bytes)
    return mapped ? `which is the IPv6 form of ${mapped.join('.')}` : 'which is reserved IPv6 space'
  }
  // 100::/64 is the discard-only prefix, outside ::/8.
  if (first === 0x01 && bytes.slice(1, 8).every(byte => byte === 0)) return 'which is reserved IPv6 space'
  if (first === 0xff) return 'which is multicast'
  if ((first & 0xfe) === 0xfc) return 'which is unique-local'
  if (first === 0xfe && (bytes[1]! & 0xc0) === 0x80) return 'which is link-local'
  if (first === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return 'which is reserved site-local space'
  // Teredo and 6to4 both encode an arbitrary IPv4 destination in the address,
  // so they are a second spelling of every range above.
  if (first === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'which is a Teredo tunnel'
  if (first === 0x20 && bytes[1] === 0x02) return 'which is a 6to4 tunnel'
  // 2001:2::/48 is benchmarking, the IPv6 twin of 198.18.0.0/15.
  if (first === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02 && bytes[4] === 0x00 && bytes[5] === 0x00) {
    return 'which is reserved IPv6 space'
  }
  return null
}

function mappedIpv4(bytes: Uint8Array): number[] | null {
  const isMapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  return isMapped ? [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!] : null
}

const NAT64_WELL_KNOWN_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]

function nat64Ipv4(bytes: Uint8Array): number[] | null {
  const isNat64 = NAT64_WELL_KNOWN_PREFIX.every((byte, index) => bytes[index] === byte)
  return isNat64 ? [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!] : null
}

/** Expands an already-valid IPv6 literal, embedded IPv4 tail included, so prefixes can be tested as bits. */
function ipv6Bytes(address: string): Uint8Array | null {
  if (!net.isIPv6(address)) return null
  const halves = address.split('::')
  if (halves.length > 2) return null

  const expand = (text: string): number[] => {
    if (text === '') return []
    const groups: number[] = []
    const chunks = text.split(':')
    for (const [index, chunk] of chunks.entries()) {
      if (index === chunks.length - 1 && chunk.includes('.')) {
        const octets = ipv4Octets(chunk)
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!)
        continue
      }
      groups.push(Number.parseInt(chunk, 16))
    }
    return groups
  }

  const head = expand(halves[0]!)
  const tail = halves.length === 2 ? expand(halves[1]!) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail]

  const bytes = new Uint8Array(16)
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8
    bytes[index * 2 + 1] = group & 255
  }
  return bytes
}
