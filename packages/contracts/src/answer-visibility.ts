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

export function determineAnswerMentioned(
  answerText: string | null | undefined,
  displayName: string,
  domains: string[],
): boolean {
  if (!answerText) return false

  const lowerAnswer = answerText.toLowerCase()
  for (const domain of domains) {
    const normalizedDomain = normalizeProjectDomain(domain)
    if (!normalizedDomain || !normalizedDomain.includes('.')) continue
    if (domainMentioned(lowerAnswer, normalizedDomain)) return true
  }

  const normalizedDisplayName = normalizeText(displayName)
  if (normalizedDisplayName && normalizeText(answerText).includes(normalizedDisplayName)) {
    return true
  }

  const tokens = collectDistinctiveTokens(displayName, domains)
  if (tokens.length === 0) return false

  let matches = 0
  for (const token of tokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lowerAnswer)) {
      matches++
    }
  }

  if (tokens.length === 1) {
    return matches >= 1
  }

  return matches >= Math.min(2, tokens.length)
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
