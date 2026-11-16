import { z } from 'zod'

/**
 * Local discoverability signals for a URL that is already in a sitemap
 * (issue #357). These are independent of what GSC or Bing report: a URL can
 * sit in the sitemap telling engines to index it while a local signal —
 * robots.txt, a meta robots tag, or an X-Robots-Tag header — blocks indexing.
 * The check names the strongest blocking signal; the precedence is the
 * order below, robots.txt first because it stops the crawl itself.
 */
export const LOCAL_BLOCK_REASONS = ['robots-disallow', 'meta-noindex', 'x-robots-tag-noindex'] as const
export type LocalBlockReason = (typeof LOCAL_BLOCK_REASONS)[number]
export const localBlockReasonSchema = z.enum(LOCAL_BLOCK_REASONS)

export interface LocalBlockCheck {
  localBlocked: boolean
  localBlockReason: LocalBlockReason | null
}

export function classifyLocalBlock(signals: {
  robotsDisallowed: boolean
  metaNoindex: boolean
  xRobotsNoindex: boolean
}): LocalBlockCheck {
  if (signals.robotsDisallowed) return { localBlocked: true, localBlockReason: 'robots-disallow' }
  if (signals.metaNoindex) return { localBlocked: true, localBlockReason: 'meta-noindex' }
  if (signals.xRobotsNoindex) return { localBlocked: true, localBlockReason: 'x-robots-tag-noindex' }
  return { localBlocked: false, localBlockReason: null }
}

/**
 * Short display label for a local block reason, for inspection tables:
 * `robots` for a robots.txt Disallow, `meta` for a meta robots noindex,
 * `header` for an X-Robots-Tag noindex.
 */
export function localBlockReasonShortLabel(reason: LocalBlockReason): string {
  switch (reason) {
    case 'robots-disallow':
      return 'robots'
    case 'meta-noindex':
      return 'meta'
    case 'x-robots-tag-noindex':
      return 'header'
  }
}

// ── robots.txt ──────────────────────────────────────────────────────────

export interface RobotsGroup {
  /** Lowercased user-agent tokens from the `User-agent:` lines (`*` included). */
  userAgents: string[]
  rules: RobotsRule[]
}

export interface RobotsRule {
  /** Raw pattern from the `Allow:` / `Disallow:` line, `*` and trailing `$` kept. */
  pattern: string
  allow: boolean
}

/**
 * Parse a robots.txt body into groups. Lines the parser does not understand
 * (`Sitemap:`, `Crawl-delay:`, `Host:`, …) are ignored; an empty `Disallow:`
 * allows everything, so it contributes no rule. A `User-agent:` line after
 * rules starts a new group, matching how crawlers read the file.
 */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'user-agent') {
      if (current !== null && current.rules.length > 0) {
        groups.push(current)
        current = null
      }
      if (current === null) current = { userAgents: [], rules: [] }
      current.userAgents.push(value.toLowerCase())
    } else if (field === 'allow' || field === 'disallow') {
      if (value === '') continue
      if (current === null) current = { userAgents: [], rules: [] }
      current.rules.push({ pattern: value, allow: field === 'allow' })
    }
  }
  if (current !== null) groups.push(current)
  return groups
}

function robotsPatternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`)
}

/** Length of the longest rule pattern, for longest-match-wins. `*` counts as one. */
function patternLength(pattern: string): number {
  return pattern.replace(/\$$/, '').length
}

function agentApplies(groupAgent: string, userAgents: readonly string[]): boolean {
  if (groupAgent === '*') return true
  return userAgents.some((agent) => agent.toLowerCase().startsWith(groupAgent))
}

/**
 * Whether any applicable group disallows `url` for one of `userAgents`
 * (for example `['googlebot']` on a GSC run, `['bingbot']` on a Bing run).
 * Longest matching rule wins; an `Allow:` beats a `Disallow:` of the same
 * length; no matching rule means allowed. An unparseable URL is allowed —
 * the caller reports the fetch failure, not a block.
 */
export function isDisallowedByRobots(
  groups: readonly RobotsGroup[],
  url: string,
  userAgents: readonly string[],
): boolean {
  let path: string
  try {
    const parsed = new URL(url)
    path = `${parsed.pathname}${parsed.search}`
  } catch {
    return false
  }
  let bestLength = -1
  let bestAllow = true
  for (const group of groups) {
    if (!group.userAgents.some((agent) => agentApplies(agent, userAgents))) continue
    for (const rule of group.rules) {
      if (!robotsPatternToRegExp(rule.pattern).test(path)) continue
      const length = patternLength(rule.pattern)
      if (length > bestLength || (length === bestLength && rule.allow)) {
        bestLength = length
        bestAllow = rule.allow
      }
    }
  }
  return bestLength >= 0 && !bestAllow
}

// ── meta robots ─────────────────────────────────────────────────────────

/** Attribute values, quoted or bare, from one tag: `name="robots"` or `content=noindex`. */
function tagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const pattern = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/gi
  for (const match of tag.matchAll(pattern)) {
    // Exactly one of the three value groups matched; the others are
    // undefined at runtime, so the first defined group is the value.
    const value = match.slice(2).find(Boolean) ?? ''
    attrs.set(match[1]!.toLowerCase(), value)
  }
  return attrs
}

function directivesIncludeNoindex(content: string): boolean {
  return content
    .split(/[,\s]+/)
    .some((token) => token.toLowerCase() === 'noindex' || token.toLowerCase() === 'none')
}

/**
 * Whether the page carries a `<meta name="robots|googlebot|bingbot"
 * content="…noindex…">` that applies to one of `userAgents`. Commented-out
 * tags are ignored — a commented `noindex` is documentation, not a signal —
 * and the `name` and `content` attributes may appear in either order.
 */
export function hasMetaNoindex(html: string, userAgents: readonly string[]): boolean {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of uncommented.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = tagAttributes(match[0])
    const name = (attrs.get('name') ?? '').toLowerCase()
    if (name === '') continue
    const applies = name === 'robots' || userAgents.some((agent) => agent.toLowerCase() === name)
    if (!applies) continue
    if (directivesIncludeNoindex(attrs.get('content') ?? '')) return true
  }
  return false
}

// ── X-Robots-Tag ────────────────────────────────────────────────────────

/**
 * Whether an `X-Robots-Tag` header value blocks indexing for one of
 * `userAgents`. Directives are comma-separated; a `googlebot: noindex` form
 * applies only to that agent, a bare `noindex` applies to every crawler.
 */
export function hasXRobotsNoindex(header: string | null | undefined, userAgents: readonly string[]): boolean {
  if (header === null || header === undefined || header === '') return false
  for (const part of header.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    if (colon !== -1) {
      const agent = trimmed.slice(0, colon).trim().toLowerCase()
      const applies = userAgents.some((candidate) => candidate.toLowerCase() === agent)
      if (!applies) continue
      if (directivesIncludeNoindex(trimmed.slice(colon + 1))) return true
    } else if (directivesIncludeNoindex(trimmed)) {
      return true
    }
  }
  return false
}
