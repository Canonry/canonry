/**
 * Heuristic filter: does this query look like one a blog post can answer?
 *
 * Used by the content recommendation engine to pre-filter the candidate
 * query set before classification. Excludes transactional and navigational
 * intent — neither will earn AI citations to a blog page, no matter how
 * good the post is.
 *
 * Conservative: when in doubt, treat as blog-shaped. False positives
 * downstream produce low-confidence targets; false negatives silently
 * drop opportunities.
 */

const TRANSACTIONAL = /\b(buy|price|pricing|cost|cheap|discount|coupon|deal|sale|trial|plan)\b/i

const NAVIGATIONAL =
  /\b(login|sign[- ]?in|contact|support|help|download|app|homepage)\b|\.(com|io|net|org|app|ai)\b/i

export function isBlogShapedQuery(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  if (TRANSACTIONAL.test(trimmed)) return false
  if (NAVIGATIONAL.test(trimmed)) return false
  return true
}
