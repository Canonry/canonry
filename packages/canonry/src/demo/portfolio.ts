/** Shared fictional portfolio identity for measurement and website examples. */
export const HARBOR_MARKETS = [
  { key: 'key-west', label: 'Key West', city: 'Key West', region: 'FL' },
  { key: 'coastal-maine', label: 'Coastal Maine', city: 'Portland', region: 'ME' },
  { key: 'pacific-northwest', label: 'Pacific Northwest', city: 'Seattle', region: 'WA' },
] as const

export function harborProperties() {
  return HARBOR_MARKETS.flatMap(market => [1, 2, 3, 4].map(number => ({
    key: `harbor-${market.key}-${number}`,
    number,
    label: `Harbor ${market.label} ${number === 1 ? 'Resort' : `Villas ${number}`}`,
    market,
    path: `/destinations/${market.key}/${number === 1 ? 'resort' : `villas-${number}`}`,
  })))
}
