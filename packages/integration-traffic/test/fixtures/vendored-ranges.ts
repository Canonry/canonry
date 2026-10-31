import type { TrafficVerificationManifest } from '@canonry/canonry-contracts'
import { ipInCidr, ipRangeManifestContentHash, parseCidr } from '../../src/index.js'

/**
 * Helpers for tests that check verification against the vendored publisher
 * snapshots in `src/ip-ranges/`.
 *
 * The weekly refresh workflow rewrites those snapshots whenever a publisher
 * changes its ranges, then runs every test before it opens a PR. A test that
 * pins a literal crawler address or a snapshot's version and hash fails on
 * the first real change, so the refresh never lands. Read addresses and
 * manifest identities from the snapshot instead. Pin a literal address only
 * when no publisher can ever list it: RFC 5737 documentation ranges
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) or RFC 1918 private space.
 */
export interface VendoredRanges {
  _source: string
  creationTime: string
  prefixes: ReadonlyArray<{ ipv4Prefix?: string; ipv6Prefix?: string }>
}

/** The provenance the classifier records when it consults this snapshot. */
export function vendoredManifest(raw: VendoredRanges): TrafficVerificationManifest {
  return {
    id: `${raw._source}#${raw.creationTime}#sha256:${ipRangeManifestContentHash(raw)}`,
    source: raw._source,
    version: raw.creationTime,
  }
}

/**
 * The network address of the first published prefix, optionally limited to
 * one IP family. It lies inside that prefix, so it verifies for every rule
 * mapped to this snapshot.
 */
export function firstPublishedIp(raw: Pick<VendoredRanges, 'prefixes'>, family?: 4 | 6): string {
  const prefix = raw.prefixes
    .map((entry) => (family === 4 ? entry.ipv4Prefix : family === 6 ? entry.ipv6Prefix : entry.ipv4Prefix ?? entry.ipv6Prefix))
    .find((value): value is string => typeof value === 'string')
  if (!prefix) throw new Error(`vendored snapshot publishes no ${family ? `IPv${family} ` : ''}prefix`)
  return prefix.split('/')[0]!
}

/** The network address of every published prefix. */
export function everyPublishedIp(raw: Pick<VendoredRanges, 'prefixes'>): string[] {
  return raw.prefixes
    .map((entry) => entry.ipv4Prefix ?? entry.ipv6Prefix)
    .filter((value): value is string => typeof value === 'string')
    .map((prefix) => prefix.split('/')[0]!)
}

/** Whether the snapshot publishes a prefix that contains this address. */
export function publishesIp(raw: Pick<VendoredRanges, 'prefixes'>, ip: string): boolean {
  return raw.prefixes.some((entry) => {
    const cidr = parseCidr(entry.ipv4Prefix ?? entry.ipv6Prefix ?? '')
    return cidr !== null && ipInCidr(ip, cidr)
  })
}
