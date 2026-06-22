import type { CanonryConfig } from './config.js'

/**
 * Resolve whether the built-in Aero agent is enabled, from the environment
 * layered over `~/.canonry/config.yaml` (env over config, mirroring
 * `resolveEmbedConfig` in embed.ts).
 *
 * Disabling turns OFF the entire agent subsystem: the proactive auto-wake on
 * `run.completed`, the `SessionRegistry`, and the interactive agent routes
 * (`/projects/:name/agent/*`) plus the `canonry agent ask` CLI (a thin client
 * of those routes). It does NOT touch data syncs, intelligence, or
 * notifications — only the agent.
 *
 *  - `CANONRY_AGENT_DISABLED` is authoritative when set and non-empty: `'1'` /
 *    `'true'` (case-insensitive) disable the agent; any other value (including
 *    `'0'` / `'false'`) forces it ON, so the env can re-enable an agent that
 *    config disabled.
 *  - otherwise `config.agent?.mode === 'disabled'` disables it.
 *  - default (no env, no config) — enabled.
 */
export function resolveAgentEnabled(env: NodeJS.ProcessEnv, config: CanonryConfig): boolean {
  const raw = env.CANONRY_AGENT_DISABLED?.trim()
  if (raw) {
    return !(raw === '1' || raw.toLowerCase() === 'true')
  }
  return config.agent?.mode !== 'disabled'
}
