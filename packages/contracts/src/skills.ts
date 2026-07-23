import { z } from 'zod'

/**
 * The coding-agent harnesses canonry installs skill bundles for. Use the
 * `CodingAgents` constant for comparisons and the `CodingAgent` type for
 * narrowed values (e.g. fields that always identify a single agent).
 */
export const codingAgentSchema = z.enum(['claude', 'codex'])
export type CodingAgent = z.infer<typeof codingAgentSchema>
export const CodingAgents = codingAgentSchema.enum

/** Native agent clients that can load the shared Canonry plugin bundle. */
export type AgentPluginClient = 'claude-code' | 'codex'

/** Best-effort user-global snapshot of native Canonry plugin availability. */
export interface AgentPluginState {
  /** Clients whose user settings enable the exact `canonry@canonry` ID. */
  configuredClients: AgentPluginClient[]
  /** Configured clients whose cached plugin manifests and skill assets exist. */
  verifiedClients: AgentPluginClient[]
  /** Verified manifest version selected for each client cache. */
  verifiedClientVersions?: Partial<Record<AgentPluginClient, string>>
}

/**
 * Scope accepted by the `canonry skills install --client` flag: a specific
 * coding agent or `all` to target every supported agent. Use the
 * `SkillsClients` constant for comparisons and the schema for parsing.
 */
export const skillsClientSchema = z.enum(['claude', 'codex', 'all'])
export type SkillsClient = z.infer<typeof skillsClientSchema>
export const SkillsClients = skillsClientSchema.enum

/**
 * Reserved filename written into every installed skill tree
 * (`.claude/skills/<name>/.canonry-skill-manifest.json`). It records what
 * canonry last wrote so a later install / doctor run can tell an upstream
 * update apart from a deliberate local edit. It is metadata, not skill
 * content — it is never part of the bundled tree and must be excluded from any
 * bundle-vs-install content comparison.
 */
export const SKILL_MANIFEST_FILENAME = '.canonry-skill-manifest.json'

/**
 * On-disk record of the canonry-shipped skill content that was last written to
 * an installed tree. Lets the installer and the doctor distinguish "the bundle
 * changed this file upstream" (safe to refresh) from "the operator edited this
 * file locally" (must not be clobbered without `--force`).
 */
export interface SkillManifest {
  /** Skill name, e.g. `"canonry"` or `"aero"`. */
  skill: string
  /** canonry package version that last wrote this tree. */
  version: string
  /**
   * Relative file path → sha256 hex of the canonry-shipped content last
   * written for that path. Keys mirror the bundled tree (sorted relative
   * paths); the manifest file itself is never listed.
   */
  files: Record<string, string>
}

/**
 * Snapshot of a bundled skill as it exists in the running canonry build.
 * Computed by the package at boot and injected into the doctor context so the
 * `agent.skills.current` check (which lives in `api-routes` and cannot resolve
 * canonry's bundled assets) can compare against it.
 */
export interface BundledSkillSnapshot {
  /** Skill name, e.g. `"canonry"` or `"aero"`. */
  name: string
  /** canonry package version this snapshot was taken from. */
  version: string
  /** Relative file path → sha256 hex of the bundled content. */
  files: Record<string, string>
}

/**
 * Classification of one bundled file against what is on disk:
 * - `missing`   — the bundled file is not present in the install (an
 *                 unambiguous addition; an additive install copies it).
 * - `unchanged` — present and byte-identical to the bundle (nothing to do).
 * - `stale`     — present but differs from the bundle, yet matches the
 *                 manifest record. canonry wrote it and the bundle has since
 *                 moved on; the operator never touched it, so it is safe to
 *                 refresh without `--force`.
 * - `edited`    — present and differs from BOTH the bundle and the manifest
 *                 (or there is no manifest record). Treated as a genuine local
 *                 edit and preserved unless `--force` is passed.
 */
export type SkillFileState = 'missing' | 'unchanged' | 'stale' | 'edited'

/**
 * Pure classifier shared by the installer and the doctor. Given the bundled
 * hash, the on-disk hash (null/undefined when absent), and the manifest's
 * recorded hash (null/undefined when unknown), decide how the file should be
 * treated. See {@link SkillFileState} for the meaning of each result.
 */
export function classifySkillFile(params: {
  bundledHash: string
  installedHash: string | null | undefined
  manifestHash: string | null | undefined
}): SkillFileState {
  const { bundledHash, installedHash, manifestHash } = params
  if (installedHash == null) return 'missing'
  if (installedHash === bundledHash) return 'unchanged'
  // Differs from the bundle. If it still matches what canonry last wrote, the
  // operator hasn't touched it — the bundle moved on, so it's stale, not edited.
  if (manifestHash != null && installedHash === manifestHash) return 'stale'
  return 'edited'
}

/**
 * Validate an already-parsed value as a {@link SkillManifest}: accept it when it
 * has a `files` object, otherwise return null. Shared by the installer (which
 * writes the manifest) and the `agent.skills.current` doctor check (which reads
 * it) so the shape guard can never drift between them. Pure — the caller owns
 * reading the file and `JSON.parse`; a malformed or legacy manifest yields null
 * and the consumer treats every file as having no recorded hash.
 */
export function coerceSkillManifest(parsed: unknown): SkillManifest | null {
  if (
    parsed != null && typeof parsed === 'object'
    && typeof (parsed as { files?: unknown }).files === 'object'
    && (parsed as { files?: unknown }).files !== null
  ) {
    return parsed as SkillManifest
  }
  return null
}
