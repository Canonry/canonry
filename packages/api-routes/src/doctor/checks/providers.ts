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

export const PROVIDERS_CHECKS: readonly CheckDefinition[] = [providersConfiguredCheck]
