import { z } from 'zod'

/**
 * The coding-agent harnesses canonry installs skill bundles for. Use the
 * `CodingAgents` constant for comparisons and the `CodingAgent` type for
 * narrowed values (e.g. fields that always identify a single agent).
 */
export const codingAgentSchema = z.enum(['claude', 'codex'])
export type CodingAgent = z.infer<typeof codingAgentSchema>
export const CodingAgents = codingAgentSchema.enum

/**
 * Scope accepted by the `canonry skills install --client` flag: a specific
 * coding agent or `all` to target every supported agent. Use the
 * `SkillsClients` constant for comparisons and the schema for parsing.
 */
export const skillsClientSchema = z.enum(['claude', 'codex', 'all'])
export type SkillsClient = z.infer<typeof skillsClientSchema>
export const SkillsClients = skillsClientSchema.enum
