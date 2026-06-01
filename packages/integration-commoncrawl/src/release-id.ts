import { RELEASE_ID_REGEX } from './constants.js'

export function isValidReleaseId(id: string): boolean {
  return RELEASE_ID_REGEX.test(id)
}

export interface ParsedRelease {
  year: number
  /** The `mon-mon-mon` window slug, e.g. 'mar-apr-may'. */
  window: string
  /** Convenience split of `window` into its three month tokens. */
  months: [string, string, string]
}

export function parseReleaseId(id: string): ParsedRelease | null {
  const match = RELEASE_ID_REGEX.exec(id)
  if (!match) return null
  const year = Number.parseInt(match[1]!, 10)
  const window = match[2]!
  const [a, b, c] = window.split('-')
  return { year, window, months: [a!, b!, c!] }
}

export function formatReleaseId(year: number, window: string): string {
  return `cc-main-${year}-${window}`
}
