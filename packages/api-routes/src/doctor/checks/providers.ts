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
        status: CheckStatuses.fail,
        code: 'providers.none-configured',
        summary: 'No answer-engine providers have credentials configured.',
        remediation:
          'Run `canonry init` to set provider keys interactively, or add them via flags ' +
          '(`--gemini-key`, `--openai-key`, `--claude-key`, `--perplexity-key`).',
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
