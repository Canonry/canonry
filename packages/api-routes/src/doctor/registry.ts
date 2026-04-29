import { GA_AUTH_CHECKS } from './checks/ga-auth.js'
import { GOOGLE_AUTH_CHECKS } from './checks/google-auth.js'
import { PROVIDERS_CHECKS } from './checks/providers.js'
import type { CheckDefinition } from './types.js'

export const ALL_CHECKS: readonly CheckDefinition[] = [
  ...GOOGLE_AUTH_CHECKS,
  ...GA_AUTH_CHECKS,
  ...PROVIDERS_CHECKS,
]

export const CHECK_BY_ID: Record<string, CheckDefinition> = Object.fromEntries(
  ALL_CHECKS.map((check) => [check.id, check]),
)

export function listCheckIds(): string[] {
  return ALL_CHECKS.map((check) => check.id)
}
