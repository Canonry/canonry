import type { HealthSnapshot, MetricTone, ServiceStatus, SettingsVm, SetupWizardVm, SystemHealthCardVm } from '../view-models.js'
import { toneFromService } from './tone-helpers.js'

/** Display name comes from the API (adapter.displayName). Capitalize as fallback. */
function providerDisplayName(p: { name: string; displayName?: string }): string {
  return p.displayName ?? p.name.charAt(0).toUpperCase() + p.name.slice(1)
}

export function serviceStatusTooltip(status: ServiceStatus): string | undefined {
  const parts = [status.detail, status.hint].filter(Boolean)
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function buildSystemHealthCards(
  cards: SystemHealthCardVm[],
  healthSnapshot: HealthSnapshot,
  settings: SettingsVm,
): SystemHealthCardVm[] {
  const result = cards.filter(card => card.id !== 'mcp').map((card) => {
    if (card.id === 'api') {
      return {
        ...card,
        tone: toneFromService(healthSnapshot.apiStatus),
        detail: healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Needs attention',
        meta: healthSnapshot.apiStatus.detail,
      }
    }

    if (card.id === 'worker') {
      return {
        ...card,
        tone: toneFromService(healthSnapshot.workerStatus),
        detail: healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : 'Needs attention',
        meta: healthSnapshot.workerStatus.detail,
      }
    }

    const configuredCount = settings.providerStatuses.filter(p => p.state === 'ready').length
    const totalCount = settings.providerStatuses.length
    const allReady = configuredCount > 0
    const configuredNames = settings.providerStatuses.filter(p => p.state === 'ready').map(p => providerDisplayName(p)).join(' · ')
    return {
      ...card,
      label: 'Providers',
      tone: allReady ? 'positive' as MetricTone : 'caution' as MetricTone,
      detail: `${configuredCount} of ${totalCount} configured`,
      meta: configuredNames || 'None configured',
    }
  })
  const mcp = healthSnapshot.apiStatus.mcp
  const mcpCard: SystemHealthCardVm = { id: 'mcp', label: 'MCP', tone: 'neutral', detail: 'Unknown', meta: 'MCP status is not available from this server.' }
  if (healthSnapshot.apiStatus.state === 'checking') {
    mcpCard.detail = 'Checking'
    mcpCard.meta = 'Checking MCP availability.'
  } else if (healthSnapshot.apiStatus.state === 'ok' && mcp) {
    if (mcp.status === 'available') {
      mcpCard.tone = 'positive'
      mcpCard.detail = 'Available'
      mcpCard.meta = 'MCP is available for agent connections. This checks the server transport, not an individual client connection.'
    } else if (mcp.status === 'unavailable') {
      mcpCard.tone = 'negative'
      mcpCard.detail = 'Unavailable'
      mcpCard.meta = 'The MCP transport is not fully available. Contact your Canonry team.'
    } else {
      mcpCard.detail = 'Not enabled'
      mcpCard.meta = 'This server does not provide an MCP endpoint.'
    }
  }
  result.splice(Math.max(0, result.findIndex(card => card.id === 'api') + 1), 0, mcpCard)
  return result
}

export function getLaunchBlockedReason(healthSnapshot: HealthSnapshot, settings: SettingsVm): string | undefined {
  if (healthSnapshot.apiStatus.state !== 'ok') {
    return 'Launch is blocked until the API responds cleanly.'
  }

  if (healthSnapshot.apiStatus.databaseConfigured === false) {
    return 'Launch is blocked until the API has a database connection configured.'
  }

  if (healthSnapshot.workerStatus.state !== 'ok') {
    return 'Launch is blocked until the worker is healthy and heartbeats are current.'
  }

  if (!settings.providerStatuses.some(p => p.state === 'ready')) {
    return 'Launch is blocked until at least one provider is configured.'
  }

  return undefined
}

export function buildSetupModel(base: SetupWizardVm, healthSnapshot: HealthSnapshot, settings: SettingsVm): SetupWizardVm {
  const blockedReason = getLaunchBlockedReason(healthSnapshot, settings)
  const model = structuredClone(base)

  model.healthChecks = model.healthChecks.map((check) => {
    if (check.id === 'api') {
      return {
        ...check,
        detail: healthSnapshot.apiStatus.detail,
        state: healthSnapshot.apiStatus.state === 'ok' ? 'ready' : 'attention',
      }
    }

    if (check.id === 'worker') {
      return {
        ...check,
        detail: healthSnapshot.workerStatus.detail,
        state: healthSnapshot.workerStatus.state === 'ok' ? 'ready' : 'attention',
      }
    }

    const anyReady = settings.providerStatuses.some(p => p.state === 'ready')
    return {
      ...check,
      detail: anyReady ? 'At least one provider configured.' : 'No providers configured.',
      state: anyReady ? 'ready' : 'attention',
    }
  })

  model.launchState.enabled = blockedReason === undefined
  model.launchState.blockedReason = blockedReason
  model.launchState.summary =
    blockedReason ?? 'Queue a visibility sweep first, then follow with a site audit to explain movement.'

  return model
}
