import { DEFAULT_AI_CRAWLER_RULES, type AiCrawlerRule } from '../../src/index.js'

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
  /** A browser-shaped user agent carrying only the token (`userAgentFor`). */
  userAgent: string
  /**
   * The operator's documented full user agent for a rule that sets
   * `documentedUserAgents`, so the trust rules read it as the agent's own;
   * `userAgent` for every other rule.
   */
  classifierUserAgent: string
}

/** A rule pattern this fixture cannot cover yet; its case fails with `problem`. */
export interface RuleTokenGap {
  ruleId: string
  purpose: string
  /** The pattern, standing in for the token in a case name. */
  token: string
  problem: string
}

// A plain literal: word characters, `-`, and escaped `/` or `.`.
const LITERAL_PATTERN = /^(?:[\w-]|\\[/.])+$/

/**
 * Tokens for the patterns that are not plain literals, keyed by pattern
 * source. A non-literal pattern missing here, or listed with no tokens, is a
 * gap, so no rule goes unchecked.
 */
const NON_LITERAL_PATTERN_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // Googlebot and its hyphenated variants, such as Googlebot-Image.
  'Googlebot[/-]': ['Googlebot/', 'Googlebot-Image/'],
  // Anthropic says to match the token, with or without a version.
  '(?<=[\\s;(])Claude-Agent(?![\\w-])': ['Claude-Agent/', 'Claude-Agent'],
}

/**
 * The operators' documented full user agents, for the rules that set
 * `documentedUserAgents`. The trust rules judge any other user agent claiming
 * these agents likely fake.
 */
const DOCUMENTED_USER_AGENTS: Readonly<Record<string, string>> = {
  // https://developers.openai.com/api/docs/bots
  'openai-chatgpt-user': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  // https://docs.mistral.ai/robots
  'mistral-ai-user': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)',
}

/**
 * A browser-shaped agent user agent carrying the token, versioned when the
 * token ends in `/`. The rest names no rule and holds no Worker keyword
 * (`bot`, `crawler`, `spider`), so only the token can match.
 */
function userAgentFor(token: string): string {
  return `Mozilla/5.0 (compatible; ${token.endsWith('/') ? `${token}1.0` : token}; +https://example.com/about)`
}

/**
 * The documented user agent the classifier cases use: null for a rule that
 * sets no `documentedUserAgents`, and false when this fixture lists none that
 * matches the rule's documented strings and carries the pattern's token.
 */
function documentedUserAgentFor(rule: AiCrawlerRule, pattern: RegExp): string | null | false {
  const documentedPatterns = rule.documentedUserAgents ?? []
  if (documentedPatterns.length === 0) return null
  const documented = DOCUMENTED_USER_AGENTS[rule.id]
  return documented !== undefined && pattern.test(documented) && documentedPatterns.some(documentedPattern => documentedPattern.test(documented))
    ? documented
    : false
}

/**
 * One case per token of every rule pattern, and a gap for each pattern this
 * fixture cannot cover: a non-literal pattern without tokens, or a rule with
 * documented user agents and no documented string here that carries the
 * token. A test with one case per entry fails only the gap's case.
 */
export function ruleTokenCases(): Array<RuleToken | RuleTokenGap> {
  return DEFAULT_AI_CRAWLER_RULES.flatMap(rule => rule.userAgentPatterns.flatMap((pattern): Array<RuleToken | RuleTokenGap> => {
    const gap = (problem: string): RuleTokenGap => ({ ruleId: rule.id, purpose: rule.purpose, token: `/${pattern.source}/`, problem })
    const tokens = LITERAL_PATTERN.test(pattern.source)
      ? [pattern.source.replace(/\\(.)/g, '$1')]
      : NON_LITERAL_PATTERN_TOKENS[pattern.source] ?? []
    if (tokens.length === 0) {
      return [gap(`Rule ${rule.id}: /${pattern.source}/ is not a plain literal; list its tokens in NON_LITERAL_PATTERN_TOKENS`)]
    }
    const documented = documentedUserAgentFor(rule, pattern)
    if (documented === false) {
      return [gap(`Rule ${rule.id}: list the operator's documented user agent, matching its documentedUserAgents and /${pattern.source}/, in DOCUMENTED_USER_AGENTS`)]
    }
    return tokens.map(token => {
      const userAgent = userAgentFor(token)
      return { ruleId: rule.id, purpose: rule.purpose, token, userAgent, classifierUserAgent: documented ?? userAgent }
    })
  }))
}

/** Every rule token; throws on the first gap. */
export function ruleTokens(): RuleToken[] {
  return ruleTokenCases().map((entry) => {
    if ('problem' in entry) throw new Error(entry.problem)
    return entry
  })
}
