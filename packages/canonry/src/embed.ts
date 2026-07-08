import type { ResolvedEmbedConfig } from '@ainyc/canonry-contracts'
import { normalizeIdTokens, parseOriginList, splitList } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from './config.js'

const DEFAULT_EMBED_PROJECT_TABS = ['overview']

/**
 * Read-only embed mode (issue #716) — resolve the effective embed settings from
 * environment variables layered over `~/.canonry/config.yaml`.
 *
 * Mirrors the verified `basePath` precedence (server.ts: `process.env.X ??
 * config.X`): env overrides config, per field. Lives in `packages/canonry`
 * (not `contracts`) because it couples `CanonryConfig` to `process.env`; the
 * pure origin/CSP/client-block helpers it delegates to live in `contracts`.
 *
 * Resolution rules:
 *  - `enabled`: `CANONRY_EMBED` is authoritative when set and non-empty
 *    (`'1'`/`'true'` → on, anything else → off, so `'0'`/`'false'` force off
 *    even if config enables); otherwise `config.embed.enabled === true`.
 *  - `allowedOrigins`: `parseOriginList(CANONRY_EMBED_ORIGINS)` when that env
 *    var is *present* (even empty — an empty value clears config origins and
 *    fails closed); otherwise the normalized `config.embed.allowOrigins`.
 *  - `views`: `CANONRY_EMBED_VIEWS` when set, else `config.embed.views`,
 *    lowercased + de-duped; an empty list collapses to `undefined` (= all
 *    views) so an empty allowlist never silently bricks every embed.
 *  - `projectTabs`: `CANONRY_EMBED_PROJECT_TABS` when set, else
 *    `config.embed.projectTabs`, lowercased + de-duped. Empty/missing defaults
 *    to `overview` in embed mode so the client-facing iframe starts locked
 *    down rather than exposing every project tab.
 *  - `theme`: `config.embed.theme` only (no env form).
 */
export function resolveEmbedConfig(env: NodeJS.ProcessEnv, config: CanonryConfig): ResolvedEmbedConfig {
  const embed = config.embed

  const rawEnabled = env.CANONRY_EMBED?.trim()
  const enabled = rawEnabled
    ? rawEnabled === '1' || rawEnabled.toLowerCase() === 'true'
    : embed?.enabled === true

  const allowedOrigins =
    env.CANONRY_EMBED_ORIGINS !== undefined
      ? parseOriginList(env.CANONRY_EMBED_ORIGINS)
      : parseOriginList(embed?.allowOrigins)

  const rawViews =
    env.CANONRY_EMBED_VIEWS !== undefined ? splitList(env.CANONRY_EMBED_VIEWS) : splitList(embed?.views)
  const views = normalizeIdTokens(rawViews)

  const rawProjectTabs =
    env.CANONRY_EMBED_PROJECT_TABS !== undefined
      ? splitList(env.CANONRY_EMBED_PROJECT_TABS)
      : splitList(embed?.projectTabs)
  const projectTabs = normalizeIdTokens(rawProjectTabs) ?? (enabled ? DEFAULT_EMBED_PROJECT_TABS : undefined)

  return {
    enabled,
    allowedOrigins,
    ...(views ? { views } : {}),
    ...(projectTabs ? { projectTabs } : {}),
    ...(embed?.theme ? { theme: embed.theme } : {}),
  }
}
