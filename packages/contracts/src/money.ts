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

/**
 * Format integer micros as a currency string, e.g. 39_280_000 → "$39.28".
 * `fractionDigits` fixes the decimals for sub-cent amounts (a single answer's
 * estimated cost is often a fraction of a cent: 14_200 → "$0.0142" at 4).
 * `showTinyAsLessThan` prints a positive amount that rounds to zero at the
 * precision in use as below its smallest step (49 → "<$0.0001" at 4), so a
 * real but tiny amount never reads as a real zero. Zero itself is unchanged.
 */
export function formatMicros(
  micros: number,
  currencyCode = 'USD',
  options: { fractionDigits?: number; showTinyAsLessThan?: boolean } = {},
): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    ...(options.fractionDigits === undefined
      ? {}
      : { minimumFractionDigits: options.fractionDigits, maximumFractionDigits: options.fractionDigits }),
  })
  const formatted = formatter.format(micros / MICROS_PER_UNIT)
  if (options.showTinyAsLessThan && micros > 0 && formatted === formatter.format(0)) {
    const smallestStep = 10 ** -(formatter.resolvedOptions().maximumFractionDigits ?? 0)
    return `<${formatter.format(smallestStep)}`
  }
  return formatted
}
