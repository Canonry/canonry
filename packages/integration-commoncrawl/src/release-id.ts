import { RELEASE_ID_REGEX } from './constants.js'

export function isValidReleaseId(id: string): boolean {
  return RELEASE_ID_REGEX.test(id)
}

export function formatReleaseId(year: number, window: string): string {
  return `cc-main-${year}-${window}`
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * A release's crawl window: the year it is named by and the months it covers,
 * as absolute month numbers (`year * 12 + month index`). Null for an id that is
 * not a release. A release is named by its FIRST month's year, so a cross-year
 * `cc-main-2025-nov-dec-jan` ends in January 2026.
 */
function releaseWindow(id: string): { first: number; last: number } | null {
  const match = RELEASE_ID_REGEX.exec(id)
  if (!match) return null
  const first = MONTH_NAMES.indexOf(match[2]!.slice(0, 3) as (typeof MONTH_NAMES)[number])
  return { first: Number(match[1]) * 12 + first, last: Number(match[1]) * 12 + first + 2 }
}

const monthLabel = (absolute: number) => `${MONTH_LABELS[absolute % 12]} ${Math.floor(absolute / 12)}`

/**
 * Orders releases by their crawl window, oldest first: the order the link graph
 * was observed in, which is not the order a workspace happened to sync them.
 * An id that is not a release sorts before every release, by id.
 */
export function compareReleaseIds(a: string, b: string): number {
  const left = releaseWindow(a)
  const right = releaseWindow(b)
  if (left && right) return left.first - right.first
  if (left) return 1
  if (right) return -1
  return a < b ? -1 : a > b ? 1 : 0
}

/** The first day of a release window's last month: `cc-main-2026-may-jun-jul` is `2026-07-01`. */
export function releaseWindowEndMonth(id: string): string | null {
  const window = releaseWindow(id)
  if (!window) return null
  return `${Math.floor(window.last / 12)}-${String((window.last % 12) + 1).padStart(2, '0')}-01`
}

/** A release's crawl window, short enough for a chart tick: "May-Jul 2026", or "Nov 2025-Jan 2026" across a year. */
export function formatReleaseWindow(id: string): string | null {
  const window = releaseWindow(id)
  if (!window) return null
  const firstYear = Math.floor(window.first / 12)
  const lastYear = Math.floor(window.last / 12)
  return firstYear === lastYear
    ? `${MONTH_LABELS[window.first % 12]}-${monthLabel(window.last)}`
    : `${monthLabel(window.first)}-${monthLabel(window.last)}`
}
