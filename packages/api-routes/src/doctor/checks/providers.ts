import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import type { CheckDefinition } from '../types.js'

const providersConfiguredCheck: CheckDefinition = {
  id: 'config.providers',
  category: CheckCategories.providers,
  scope: CheckScopes.global,
  title: 'Provider keys',
  run: (ctx) => {
    const summary = ctx.providerSummary
    if (!summary) {
      return {
        status: CheckStatuses.skipped,
        code: 'providers.summary-unavailable',
        summary: 'Provider summary is not available in this deployment.',
        remediation: null,
      }
    }
    const configured = summary.filter((entry) => entry.configured).map((entry) => entry.name)
    const total = summary.length
    if (configured.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'providers.none-configured',
        summary: 'No answer-engine provider is configured. Page Health remains available; AI Visibility is disabled.',
        remediation:
          'To enable AI Visibility, set a provider environment variable and rerun `canonry bootstrap`, ' +
          'or run `canonry settings provider <name> --api-key <key>` while the server is running.',
        details: { available: summary.map((entry) => entry.name) },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'providers.configured',
      summary: `${configured.length} of ${total} providers configured: ${configured.join(', ')}.`,
      remediation: null,
      details: { configured, total },
    }
  },
}

const agentProvidersConfiguredCheck: CheckDefinition = {
  id: 'config.agent-providers',
  category: CheckCategories.providers,
  scope: CheckScopes.global,
  title: 'Agent provider keys',
  run: (ctx) => {
    // Which provider drives the agent, and that a key is configured for it, is
    // administrator knowledge: `GET /agent/providers` refuses a non-administrator
    // outright rather than serving a trimmed catalog, on the grounds that naming
    // which providers exist and which one is configured is most of the answer.
    // Doctor carries no administrator gate of its own (the generic role gate
    // refuses a viewer only on writes), so this check has to ask here, or it
    // hands the same answer to every analyst on the install.
    if (ctx.callerIsInstanceAdministrator === false) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent-providers.restricted',
        summary: 'Agent provider configuration is visible to administrators only.',
        remediation: null,
      }
    }
    const summary = ctx.getAgentProviderSummary?.()
    if (!summary) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent-providers.summary-unavailable',
        summary: 'Agent provider summary is not available in this deployment.',
        remediation: null,
      }
    }
    const configured = summary.filter((entry) => entry.configured)
    const total = summary.length
    const details = {
      configured: configured.map((entry) => entry.id),
      providers: summary.map((entry) => ({
        id: entry.id,
        configured: entry.configured,
        keySource: entry.keySource,
      })),
    }
    if (configured.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'agent-providers.none-configured',
        summary: 'No agent LLM provider has credentials configured — the built-in Aero agent cannot run.',
        remediation:
          'Add a key for one of the agent providers (claude, openai, gemini, zai, deepinfra) under ' +
          '`providers.<name>.apiKey` in ~/.canonry/config.yaml, or export its env var ' +
          '(e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPINFRA_TOKEN).',
        details,
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'agent-providers.configured',
      summary: `${configured.length} of ${total} agent providers configured: ${configured.map((e) => e.id).join(', ')}.`,
      remediation: null,
      details,
    }
  },
}

export const PROVIDERS_CHECKS: readonly CheckDefinition[] = [
  providersConfiguredCheck,
  agentProvidersConfiguredCheck,
]
