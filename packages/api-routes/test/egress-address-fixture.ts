/**
 * The address classes the outbound egress policy (`src/egress-policy.ts`)
 * refuses and admits. Shared by every suite that drives a gate built on it, so
 * the webhook gate and the public-fetch gate are checked against one list and
 * can never drift apart again.
 */

/** Every refused class, plus the IPv6 spellings that carry an internal IPv4 address. */
export const BLOCKED_ADDRESSES = [
  '0.0.0.0',
  '127.0.0.1',
  '127.255.255.254',
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '100.127.255.254',
  '192.0.0.1',
  '192.0.0.170',
  '198.18.0.1',
  '198.19.255.254',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::2',
  '0:1::1',
  'fe80::1',
  'fc00::1',
  'fd12:3456::1',
  'fec0::1',
  'feff:ffff::1',
  'ff02::1',
  'ff05::1:3',
  // IPv4-mapped (::ffff:0:0/96)
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  // IPv4-compatible (::/96), in both spellings
  '::7f00:1',
  '::a9fe:a9fe',
  '::169.254.169.254',
  // SIIT IPv4-translated (::ffff:0:0:0/96)
  '::ffff:0:a9fe:a9fe',
  '::ffff:0:127.0.0.1',
  // NAT64 well-known prefix (64:ff9b::/96) carrying a refused IPv4 address
  '64:ff9b::a00:1',
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b::0.0.0.0',
  '64:ff9b::e000:1',
  // Local-use NAT64 (64:ff9b:1::/48) is refused whatever it carries
  '64:ff9b:1::808:808',
  '64:ff9b:1::a9fe:a9fe',
  // Discard-only (100::/64)
  '100::1',
  // Benchmarking (2001:2::/48)
  '2001:2::1',
  // 6to4 (2002::/16) and Teredo (2001::/32) tunnel to any IPv4 address
  '2002:7f00:1::',
  '2002:a9fe:a9fe::1',
  '2001::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
] as const

/** Public addresses both gates must admit, including a DNS64-synthesized AAAA for a public IPv4 host. */
export const PUBLIC_ADDRESSES = [
  '8.8.8.8',
  '2606:4700::1111',
  '64:ff9b::808:808',
  '64:ff9b::8.8.8.8',
] as const

/** Loopback by its bytes, the only class `allowLoopback` admits. */
export const LOOPBACK_ADDRESSES = [
  '127.0.0.1',
  '127.255.255.254',
  '::1',
  '::ffff:127.0.0.1',
] as const

/** Loopback spelled through a translation prefix, or local without being loopback: refused even with `allowLoopback`. */
export const NOT_LOOPBACK_ADDRESSES = [
  '::7f00:1',
  '64:ff9b::7f00:1',
  '2002:7f00:1::',
  '0.0.0.0',
  '::',
  '169.254.169.254',
] as const

/** The URL host for an address literal, bracketed when it is IPv6. */
export function literalHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}
