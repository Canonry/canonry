import { DEFAULT_AI_CRAWLER_RULES } from '../../src/index.js'

/**
 * Every classifier rule's literal user-agent tokens, read from its own
 * patterns, each with a user agent that carries it. The rule-order test
 * (analysis.test.ts) and the Cloudflare Worker test check every rule through
 * these, so a rule is covered as soon as it is added.
 */
export interface RuleToken {
  ruleId: string
  purpose: string
  token: string
  userAgent: string
}

// A plain literal: word characters, `-`, and escaped `/` or `.`.
const LITERAL_PATTERN = /^(?:[\w-]|\\[/.])+$/

/**
 * Tokens for the patterns that are not plain literals, keyed by pattern
 * source. `ruleTokens` throws on a non-literal pattern missing here, so no
 * rule goes unchecked.
 */
const NON_LITERAL_PATTERN_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // Googlebot and its hyphenated variants, such as Googlebot-Image.
  'Googlebot[/-]': ['Googlebot/', 'Googlebot-Image/'],
  // Anthropic says to match the token, with or without a version.
  '(?<=[\\s;(])Claude-Agent(?![\\w-])': ['Claude-Agent/', 'Claude-Agent'],
}

/**
 * A browser-shaped agent user agent carrying the token, versioned when the
 * token ends in `/`. The rest names no rule and holds no Worker keyword
 * (`bot`, `crawler`, `spider`), so only the token can match.
 */
function userAgentFor(token: string): string {
  return `Mozilla/5.0 (compatible; ${token.endsWith('/') ? `${token}1.0` : token}; +https://example.com/about)`
}

export function ruleTokens(): RuleToken[] {
  return DEFAULT_AI_CRAWLER_RULES.flatMap(rule => rule.userAgentPatterns.flatMap((pattern) => {
    const tokens = LITERAL_PATTERN.test(pattern.source)
      ? [pattern.source.replace(/\\(.)/g, '$1')]
      : NON_LITERAL_PATTERN_TOKENS[pattern.source]
    if (!tokens) {
      throw new Error(`Rule ${rule.id}: /${pattern.source}/ is not a plain literal; list its tokens in NON_LITERAL_PATTERN_TOKENS`)
    }
    return tokens.map(token => ({ ruleId: rule.id, purpose: rule.purpose, token, userAgent: userAgentFor(token) }))
  }))
}
