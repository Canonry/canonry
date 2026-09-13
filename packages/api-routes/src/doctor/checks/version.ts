import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import type { CheckDefinition } from '../types.js'

const versionCurrentCheck: CheckDefinition = {
  id: 'canonry.version.current',
  category: CheckCategories.config,
  scope: CheckScopes.global,
  title: 'Canonry version',
  run: (ctx) => {
    if (!ctx.getUpdateStatus) {
      return {
        status: CheckStatuses.skipped,
        code: 'version.status-unavailable',
        summary: 'This deployment does not report update status.',
      }
    }

    const status = ctx.getUpdateStatus()
    if (!status.enabled) {
      return {
        status: CheckStatuses.skipped,
        code: 'version.check-disabled',
        summary: `Update check is disabled (running ${status.current}).`,
        remediation: 'Unset CANONRY_DISABLE_UPDATE_CHECK / DO_NOT_TRACK / CI, or set updateCheck: true in config.yaml, to re-enable it.',
        details: { current: status.current },
      }
    }

    if (!status.latest) {
      return {
        status: CheckStatuses.skipped,
        code: 'version.latest-unknown',
        summary: `Latest published version is not known yet (running ${status.current}).`,
        remediation: 'The npm registry has not been reached yet. Re-run doctor in a moment; offline hosts stay skipped.',
        details: { current: status.current },
      }
    }

    if (compareVersions(status.latest, status.current) > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'version.outdated',
        summary: `canonry ${status.latest} is available; this server runs ${status.current}.`,
        remediation: `Run \`${status.upgradeCommand}\`, then restart the server (\`canonry stop && canonry start\`, or restart \`canonry serve\`).`,
        details: {
          current: status.current,
          latest: status.latest,
          upgradeCommand: status.upgradeCommand,
          url: status.url,
        },
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'version.current',
      summary: `Running the latest canonry (${status.current}).`,
      details: { current: status.current, latest: status.latest },
    }
  },
}

/**
 * Compare `major.minor.patch` cores, ignoring pre-release and build metadata.
 * Unparseable input compares equal, so a malformed registry value can never
 * produce a false "outdated" warning.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const parts = (v.split(/[-+]/)[0] ?? '').split('.')
    if (parts.length < 3) return null
    const nums = parts.slice(0, 3).map(Number)
    return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]! ? 1 : -1
  }
  return 0
}

export const VERSION_CHECKS: readonly CheckDefinition[] = [versionCurrentCheck]
