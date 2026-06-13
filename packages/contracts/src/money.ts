// Micro-amount money helpers. Ad platforms (OpenAI Advertiser API, Google
// Ads) express budgets/bids as integer micros (1 unit = 1e-6 of the account
// currency) while some reporting surfaces return decimal currency units.
// Canonry persists money as integer micros; these helpers convert and format
// at the edges.

const MICROS_PER_UNIT = 1_000_000

/** Decimal currency units → integer micros (rounds away IEEE-754 artifacts). */
export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * MICROS_PER_UNIT)
}

/** Integer micros → decimal currency units. */
export function microsToDollars(micros: number): number {
  return micros / MICROS_PER_UNIT
}

/** Format integer micros as a currency string, e.g. 39_280_000 → "$39.28". */
export function formatMicros(micros: number, currencyCode = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(micros / MICROS_PER_UNIT)
}
