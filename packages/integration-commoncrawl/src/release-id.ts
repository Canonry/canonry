import { RELEASE_ID_REGEX } from './constants.js'

export function isValidReleaseId(id: string): boolean {
  return RELEASE_ID_REGEX.test(id)
}

export interface ParsedRelease {
  year: number
  quarter: 'jan-feb-mar' | 'apr-may-jun' | 'jul-aug-sep' | 'oct-nov-dec'
}

export function parseReleaseId(id: string): ParsedRelease | null {
  const match = RELEASE_ID_REGEX.exec(id)
  if (!match) return null
  const year = Number.parseInt(match[1]!, 10)
  const quarter = match[2] as ParsedRelease['quarter']
  return { year, quarter }
}

export function formatReleaseId(year: number, quarter: ParsedRelease['quarter']): string {
  return `cc-main-${year}-${quarter}`
}
