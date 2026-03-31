import { normalizeProjectDomain } from './project.js'
import type { VisibilityState } from './run.js'

const GENERIC_TOKENS = new Set([
  'agency',
  'app',
  'company',
  'corp',
  'group',
  'health',
  'inc',
  'llc',
  'online',
  'platform',
  'services',
  'site',
  'solutions',
  'software',
  'systems',
  'tech',
])

export interface AnswerMentionResult {
  mentioned: boolean
  matchedTerms: string[]
}

export function extractAnswerMentions(
  answerText: string | null | undefined,
  displayName: string,
  domains: string[],
): AnswerMentionResult {
  if (!answerText) return { mentioned: false, matchedTerms: [] }

  const matchedTerms: string[] = []
  const lowerAnswer = answerText.toLowerCase()

  for (const domain of domains) {
    const normalizedDomain = normalizeProjectDomain(domain)
    if (!normalizedDomain || !normalizedDomain.includes('.')) continue
    if (domainMentioned(lowerAnswer, normalizedDomain)) {
      matchedTerms.push(normalizedDomain)
    }
  }

  const normalizedDisplayName = normalizeText(displayName)
  if (normalizedDisplayName && normalizeText(answerText).includes(normalizedDisplayName)) {
    matchedTerms.push(displayName)
  }

  const tokens = collectDistinctiveTokens(displayName, domains)
  let tokenMatches = 0
  const matchedTokens: string[] = []
  for (const token of tokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lowerAnswer)) {
      tokenMatches++
      matchedTokens.push(token)
    }
  }

  const tokenThresholdMet = tokens.length > 0 && (
    (tokens.length === 1 && tokenMatches >= 1)
    || tokenMatches >= Math.min(2, tokens.length)
  )

  if (tokenThresholdMet) {
    matchedTerms.push(...matchedTokens)
  }

  // Deduplicate
  const unique = [...new Set(matchedTerms)]
  return { mentioned: unique.length > 0, matchedTerms: unique }
}

export function determineAnswerMentioned(
  answerText: string | null | undefined,
  displayName: string,
  domains: string[],
): boolean {
  return extractAnswerMentions(answerText, displayName, domains).mentioned
}

export function visibilityStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): VisibilityState {
  return answerMentioned ? 'visible' : 'not-visible'
}

function domainMentioned(lowerAnswer: string, normalizedDomain: string): boolean {
  const escapedDomain = escapeRegExp(normalizedDomain.toLowerCase())
  const patterns = [
    new RegExp(`(^|[^a-z0-9-])${escapedDomain}($|[^a-z0-9-])`),
    new RegExp(`https?://(?:www\\.)?${escapedDomain}(?:[/:?#]|$)`),
    new RegExp(`www\\.${escapedDomain}(?:[/:?#]|$)`),
  ]
  return patterns.some(pattern => pattern.test(lowerAnswer))
}

function collectDistinctiveTokens(displayName: string, domains: string[]): string[] {
  const tokens = new Set<string>()

  for (const token of extractDistinctiveTokens(displayName)) {
    tokens.add(token)
  }

  for (const domain of domains) {
    const hostname = normalizeProjectDomain(domain).split('/')[0] ?? ''
    for (const label of hostname.split('.').filter(Boolean)) {
      const token = label.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (isDistinctiveToken(token)) tokens.add(token)
    }
  }

  return [...tokens]
}

function extractDistinctiveTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter(isDistinctiveToken)
}

function isDistinctiveToken(token: string): boolean {
  if (token.length < 4) return false
  return !GENERIC_TOKENS.has(token)
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
