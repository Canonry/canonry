import { AGENT_CHECKS } from './checks/agent.js'
import { BING_AUTH_CHECKS } from './checks/bing-auth.js'
import { GA_AUTH_CHECKS } from './checks/ga-auth.js'
import { GOOGLE_AUTH_CHECKS } from './checks/google-auth.js'
import { PROVIDERS_CHECKS } from './checks/providers.js'
import { RUNTIME_STATE_CHECKS } from './checks/runtime-state.js'
import { TRAFFIC_SOURCE_CHECKS } from './checks/traffic-source.js'
import type { CheckDefinition } from './types.js'

export const ALL_CHECKS: readonly CheckDefinition[] = [
  // Runtime-state checks run first so file-system gone errors surface
  // before any auth/integration checks try to touch the (orphaned) DB.
  ...RUNTIME_STATE_CHECKS,
  ...GOOGLE_AUTH_CHECKS,
  ...BING_AUTH_CHECKS,
  ...GA_AUTH_CHECKS,
  ...PROVIDERS_CHECKS,
  ...TRAFFIC_SOURCE_CHECKS,
  ...AGENT_CHECKS,
]

