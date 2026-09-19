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
/**
 * Resolve whether Aero may wake ITSELF, from the environment layered over
 * `~/.canonry/config.yaml`, resolved exactly the way `resolveAgentEnabled`
 * resolves the kill switch (env over config).
 *
 * This is a narrower question than "is the agent on". Prompt-only Aero keeps
 * every interactive surface: the routes, the dashboard bar, `canonry agent
 * ask`. What it gives up is the proactive turn `RunCoordinator` fires after
 * each `run.completed`. An install that wants an agent it can ask, but never
 * one that starts talking on its own, sets this and nothing else.
 *
 *  - `CANONRY_AGENT_PROMPT_ONLY` is authoritative when set and non-empty:
 *    `'1'` / `'true'` (case-insensitive) stop the proactive wake; any other
 *    value (including `'0'` / `'false'`) forces it ON, so the env can restore
 *    proactive behaviour on a config that disabled it.
 *  - otherwise `config.agent?.mode === 'prompt-only'` stops the wake.
 *  - default (no env, no config) — proactive, which is what every install
 *    already does today.
 *
 * Says nothing about `'disabled'`: when the agent is off there is no session
 * registry to wake, so the question does not arise.
 */
export function resolveAgentProactiveEnabled(env: NodeJS.ProcessEnv, config: CanonryConfig): boolean {
  const raw = env.CANONRY_AGENT_PROMPT_ONLY?.trim()
  if (raw) {
    return !(raw === '1' || raw.toLowerCase() === 'true')
  }
  return config.agent?.mode !== 'prompt-only'
}
