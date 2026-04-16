import type { CanonryConfig } from './config.js'

/**
 * Resolves the OpenClaw session key for routing dashboard messages.
 * Single-user mode returns a constant. Multi-user would look up request.user here.
 */
export function resolveAgentSessionKey(config: CanonryConfig): string {
  return config.agent?.sessionKey ?? `agent:${config.agent?.profile ?? 'aero'}:main`
}
