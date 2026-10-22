import { z } from 'zod'

/**
 * What kind of provider an adapter is.
 *
 * - `answer-engine`  a model provider answering with its own search tool (Gemini, OpenAI, ...)
 * - `model-gateway`  one connection fronting many models (OpenRouter); measured through pinned routes
 * - `answer-service` a hosted service that searches the web and returns a grounded answer
 *
 * Absent means `answer-engine`, so every adapter written before this field
 * keeps its behaviour.
 */
export const providerKindSchema = z.enum(['answer-engine', 'model-gateway', 'answer-service'])
export type ProviderKind = z.infer<typeof providerKindSchema>
export const ProviderKinds = providerKindSchema.enum

/** Workflows that send a tracked query and store the grounded answer. */
export const providerWorkflowSchema = z.enum(['visibility-sweep', 'research', 'snapshot', 'discovery-seed'])
export type ProviderWorkflow = z.infer<typeof providerWorkflowSchema>
export const ProviderWorkflows = providerWorkflowSchema.enum

/**
 * How a provider came to be used. `explicit` is a person or config naming it;
 * `implicit` is every default: an empty project provider list, "all configured
 * engines", schedules without providers, snapshots and research without a
 * provider, setup readiness and discovery defaults.
 */
export type ProviderSelectionMode = 'explicit' | 'implicit'

export interface ProviderCapabilities {
  /** Plain prompt-in, text-out generation (profiling, assessment, query generation). */
  textGeneration: boolean
  /** A complete grounded answer for a tracked query. */
  groundedAnswer: boolean
  /** Workflows an explicit selection may use. Absent means every workflow. */
  workflows?: readonly ProviderWorkflow[]
}

export interface ProviderEligibilitySubject {
  kind?: ProviderKind
  capabilities?: ProviderCapabilities
}

/**
 * Whether a provider may run a workflow. Implicit selection never admits a
 * hosted answer service, so connecting one never widens an existing
 * project's measurement. (A gateway's bare connection is never a concrete
 * target either; its routes appear only where someone saved them, which is
 * why a saved gateway route keeps its existing defaults.) Explicit selection
 * admits an answer service only for the workflows its profile declares.
 */
export function isEligibleFor(subject: ProviderEligibilitySubject, workflow: ProviderWorkflow, selection: ProviderSelectionMode): boolean {
  const kind = subject.kind ?? ProviderKinds['answer-engine']
  if (selection === 'implicit') return kind !== ProviderKinds['answer-service']
  if (subject.capabilities?.groundedAnswer === false) return false
  const workflows = subject.capabilities?.workflows
  if (kind === ProviderKinds['answer-service']) return workflows?.includes(workflow) ?? false
  return workflows === undefined || workflows.includes(workflow)
}

/**
 * Generation roles (snapshot profiling and assessment, query generation,
 * classification, Aero, sentiment) need plain text generation, which no
 * answer service offers: it always searches and answers instead.
 */
export function canGenerateText<T extends { generateText?: unknown; capabilities?: ProviderCapabilities }>(
  adapter: T,
): adapter is T & { generateText: NonNullable<T['generateText']> } {
  return typeof adapter.generateText === 'function' && adapter.capabilities?.textGeneration !== false
}

/**
 * Whether a configured provider can make an install ready to measure on its
 * own (setup readiness, the dashboard health card, doctor). A hosted answer
 * service runs only where a project or request names one of its profiles, so
 * it never does.
 */
export function makesInstallMeasurable(subject: Pick<ProviderEligibilitySubject, 'kind'>): boolean {
  return (subject.kind ?? ProviderKinds['answer-engine']) !== ProviderKinds['answer-service']
}
